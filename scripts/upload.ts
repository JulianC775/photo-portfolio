/**
 * The upload CLI (docs/PLAN.md D4) — the only way photos get into either bucket.
 *
 *   npm run upload -- ./shot.jpg --public --category astro --title "Milky Way over Sedona"
 *   npm run upload -- ./event/*.jpg --event "Camping Trip 2026"
 *   npm run upload -- ./shot.jpg --public --category astro --event "Camping Trip 2026"
 *
 * Flags may be omitted; missing ones are prompted for. Passing both `--public` and `--event`
 * uploads the same source files twice, processed differently for each destination (D4).
 *
 * Per file: read EXIF → public path generates 400/1200/2400w AVIF+WebP with `sharp` and asserts
 * no GPS tag survived (invariant 2) → friends path uploads the original byte-for-byte with full
 * EXIF intact (invariant 3) plus one browse-sized preview → a blur placeholder is generated either
 * way → everything lands in the bucket before the manifest is touched. Video/timelapse support is
 * M4 scope, not this file (docs/PLAN.md M4).
 *
 * Idempotent: a file already recorded in the manifest (by `sourceFilename` for public, by
 * `filename`+event for friends) is skipped without re-reading or re-uploading it, so an
 * interrupted batch resumes by re-running the same command.
 *
 * Manifest writes, backups and the local mirror all happen inside `writePublicManifest` /
 * `writeFriendsManifest` (src/lib/content.ts) — this script never touches a manifest object
 * directly, so invariant 7 is enforced in one place regardless of who calls it.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline/promises";

import { gps as gpsOf, parse as parseExif } from "exifr";
import sharp, { type Sharp } from "sharp";

import {
  getFriendsManifest,
  getPublicManifestDirect,
  writeFriendsManifest,
  writePublicManifest,
  type FriendsManifestInput,
  type PublicManifestInput,
} from "../src/lib/content";
import type { FriendsManifest, PublicManifest, Rendition } from "../src/lib/manifest";
import { CACHE_CONTROL, getStorage, type StorageProvider } from "../src/lib/storage";

// `.env.local` isn't loaded automatically outside of `next dev`/`next build`. Doesn't override
// already-exported vars, so `STORAGE_ENDPOINT=... npm run upload` still works for one-off runs.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local — fine if every var is already in the environment; storageConfig() names
  // exactly what's missing if not.
}

/** The size ladder from D4. A width is only generated if the source is at least that wide. */
const WIDTHS = [400, 1200, 2400] as const;
const FORMATS = ["avif", "webp"] as const;
const FRIENDS_PREVIEW_WIDTH = 1600;

const MIME: Record<string, string> = { avif: "image/avif", webp: "image/webp" };
const ORIGINAL_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/**
 * Files-in-flight at once: EXIF read, `sharp` processing and the S3 PUT together, so a bulk
 * friends event doesn't run one file at a time (D4 step 5's "6–8 concurrent"). Per-part multipart
 * concurrency inside a single large upload is a separate knob (`Upload`'s `queueSize` in
 * src/lib/storage/s3.ts) and is left at its default — this is about the batch, not one file.
 */
const CONCURRENCY = 6;

const rl = createInterface({ input: process.stdin, output: process.stdout });

type Flags = {
  files: string[];
  public: boolean;
  event?: string;
  category?: string;
  title?: string;
  caption?: string;
  location?: string;
  featured: boolean;
};

type ExifData = { takenAt?: string };

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.files.length === 0) {
    console.error(
      'Usage: npm run upload -- <file...> [--public --category <slug> [--title "..."]] [--event "Name"]',
    );
    process.exitCode = 1;
    return;
  }

  let toPublic = flags.public;
  let eventLabel = flags.event;

  if (!toPublic && !eventLabel) {
    const choice = (await ask("Upload to public gallery, friends event, or both?", "public")).toLowerCase();
    toPublic = choice === "public" || choice === "both";
    if (choice === "friends" || choice === "both") {
      eventLabel = await ask("Event name");
    }
  }
  if (!toPublic && !eventLabel) {
    throw new Error("Nothing to do — pass --public and/or --event.");
  }

  // Fail before doing any work, not after processing every file — the manifest write refuses to
  // run without this anyway (invariant 7), but that's a wasted batch of uploads to discover it.
  if (!process.env.LOCAL_MANIFEST_MIRROR) {
    throw new Error(
      "LOCAL_MANIFEST_MIRROR is not set — see .env.example. Refusing to start (invariant 7).",
    );
  }

  console.log(
    `\n${flags.files.length} file(s) → ${[toPublic && "public", eventLabel && `friends: ${eventLabel}`]
      .filter(Boolean)
      .join(", ")}\n`,
  );

  // Direct read, not the cached one pages use — this is about to read-modify-write and a stale
  // read here would silently drop a recent upload (see getPublicManifestDirect in content.ts).
  const publicManifest = toPublic ? await getPublicManifestDirect() : undefined;
  const friendsManifest = eventLabel ? await getFriendsManifest() : undefined;

  let categorySlug: string | undefined;
  if (toPublic && publicManifest) {
    categorySlug = flags.category ?? (await ask("Category slug"));
    await ensureCategory(publicManifest, categorySlug);
  }

  let eventSlug: string | undefined;
  if (eventLabel && friendsManifest) {
    eventSlug = slugify(eventLabel);
    ensureEvent(friendsManifest, eventSlug, eventLabel);
  }

  // Gather anything that needs a prompt up front, sequentially — readline can't share a terminal
  // with the concurrent phase below.
  const publicTitles = new Map<string, string>();
  if (toPublic && publicManifest) {
    for (const filePath of flags.files) {
      const filename = basename(filePath);
      if (publicManifest.items.some((item) => item.sourceFilename === filename)) continue;
      const title =
        flags.title && flags.files.length === 1
          ? flags.title
          : await ask(`Title for ${filename}`, prettifyFilename(filename));
      publicTitles.set(filename, title);
    }
  }

  const publicIds = new Set(publicManifest?.items.map((item) => item.id) ?? []);
  const friendsIds = new Set(friendsManifest?.photos.map((photo) => photo.id) ?? []);

  const newPublicItems: PublicManifestInput["items"] = [];
  const newFriendsPhotos: FriendsManifestInput["photos"] = [];
  const failures: { file: string; error: Error }[] = [];

  const storage = await getStorage();

  await runWithConcurrency(flags.files, CONCURRENCY, async (filePath) => {
    const filename = basename(filePath);
    console.log(`${filename}`);

    const needsPublic =
      toPublic && !publicManifest!.items.some((item) => item.sourceFilename === filename);
    const needsFriends =
      eventLabel && !friendsManifest!.photos.some((p) => p.event === eventSlug && p.filename === filename);

    if (!needsPublic && !needsFriends) {
      console.log(`  ${filename}: already in the manifest — skipped`);
      return;
    }
    if (toPublic && !needsPublic) console.log(`  ${filename}: public already uploaded, skipped`);
    if (eventLabel && !needsFriends) console.log(`  ${filename}: friends already uploaded, skipped`);

    let buffer: Buffer;
    let exif: ExifData;
    try {
      buffer = await readFile(filePath);
      exif = await readExif(buffer);
    } catch (error) {
      failures.push({ file: filename, error: error as Error });
      console.error(`  ${filename}: failed to read — ${(error as Error).message}`);
      return;
    }

    if (needsPublic) {
      try {
        const item = await processPublic({
          buffer,
          filename,
          exif,
          categorySlug: categorySlug!,
          title: publicTitles.get(filename) ?? prettifyFilename(filename),
          caption: flags.caption,
          location: flags.location,
          featured: flags.featured,
          ids: publicIds,
          storage,
        });
        newPublicItems.push(item);
        console.log(`  ${filename}: public ok (${item.renditions.length} renditions)`);
      } catch (error) {
        failures.push({ file: filename, error: error as Error });
        console.error(`  ${filename}: public FAILED — ${(error as Error).message}`);
      }
    }

    if (needsFriends) {
      try {
        const photo = await processFriends({
          buffer,
          filename,
          exif,
          eventSlug: eventSlug!,
          ids: friendsIds,
          storage,
        });
        newFriendsPhotos.push(photo);
        console.log(`  ${filename}: friends ok`);
      } catch (error) {
        failures.push({ file: filename, error: error as Error });
        console.error(`  ${filename}: friends FAILED — ${(error as Error).message}`);
      }
    }
  });

  if (toPublic && publicManifest && newPublicItems.length > 0) {
    const updated = await writePublicManifest({
      version: 1,
      categories: publicManifest.categories,
      items: [...publicManifest.items, ...newPublicItems],
    });
    console.log(`\nPublic manifest written: ${updated.items.length} item(s) total.`);
    await pingRevalidate();
  }

  if (eventLabel && friendsManifest && newFriendsPhotos.length > 0) {
    const updated = await writeFriendsManifest({
      version: 1,
      events: friendsManifest.events,
      photos: [...friendsManifest.photos, ...newFriendsPhotos],
    });
    console.log(`Friends manifest written: ${updated.photos.length} photo(s) total.`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} file(s) failed — re-run the same command to retry just those:`);
    for (const { file, error } of failures) console.error(`  ${file}: ${error.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Per-destination processing
// ---------------------------------------------------------------------------

async function processPublic(args: {
  buffer: Buffer;
  filename: string;
  exif: ExifData;
  categorySlug: string;
  title: string;
  caption?: string;
  location?: string;
  featured: boolean;
  ids: Set<string>;
  storage: StorageProvider;
}): Promise<Extract<PublicManifestInput["items"][number], { kind: "photo" }>> {
  const { buffer, filename, exif, categorySlug, title, caption, location, featured, ids, storage } = args;

  // Claimed before any `await`, so two files racing in the concurrent pool can't pick the same id.
  const id = uniqueSlug(slugify(title) || "photo", ids);

  // `.rotate()` bakes in EXIF orientation; not calling `.withMetadata()` afterwards is what strips
  // the rest of the metadata (D4 step 2) — the assertion below is what makes that a fact and not
  // an assumption.
  const { data: normalized, info } = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
  const source = sharp(normalized);
  const { width: sourceWidth, height: sourceHeight } = info;

  const widths: number[] = WIDTHS.filter((w) => w <= sourceWidth);
  if (widths.length === 0) widths.push(sourceWidth);

  const renditions: Rendition[] = [];
  for (const width of widths) {
    const height = Math.round((width / sourceWidth) * sourceHeight);
    for (const format of FORMATS) {
      const out = await source
        .clone()
        .resize(width, height)
        .toFormat(format, { quality: format === "avif" ? 50 : 78 })
        .toBuffer();

      // Invariant 2: never trust the strip silently. Check every derivative, not just one — the
      // assertion is cheap and a photo that's the exception is worse than the extra work.
      if (await gpsSurvived(out)) {
        throw new Error(
          `GPS EXIF survived derivative generation (${width}w ${format}) — aborting before upload`,
        );
      }

      const key = `photos/${id}/${width}.${format}`;
      await storage.put("public", key, out, {
        contentType: MIME[format],
        cacheControl: CACHE_CONTROL.immutable,
      });
      renditions.push({ key, format, width, height, bytes: out.length });
    }
  }

  return {
    kind: "photo",
    id,
    title,
    category: categorySlug,
    caption,
    location,
    takenAt: exif.takenAt,
    featured,
    addedAt: new Date().toISOString(),
    width: sourceWidth,
    height: sourceHeight,
    renditions,
    blurDataUrl: await blurPlaceholder(source, sourceWidth, sourceHeight),
    sourceFilename: filename,
  };
}

async function processFriends(args: {
  buffer: Buffer;
  filename: string;
  exif: ExifData;
  eventSlug: string;
  ids: Set<string>;
  storage: StorageProvider;
}): Promise<FriendsManifestInput["photos"][number]> {
  const { buffer, filename, exif, eventSlug, ids, storage } = args;

  const id = uniqueSlug(slugify(`${eventSlug}-${stripExt(filename)}`), ids);
  const ext = extname(filename).toLowerCase() || ".jpg";
  const originalKey = `friends/${eventSlug}/${id}/original${ext}`;

  // Invariant 3: the exact bytes read from disk, untouched — no `sharp` in this call at all.
  await storage.put("private", originalKey, buffer, {
    contentType: ORIGINAL_CONTENT_TYPES[ext] ?? "application/octet-stream",
    cacheControl: CACHE_CONTROL.private,
  });

  const { data: normalized, info } = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
  const source = sharp(normalized);
  const previewWidth = Math.min(FRIENDS_PREVIEW_WIDTH, info.width);
  const previewHeight = Math.round((previewWidth / info.width) * info.height);

  const preview: Rendition[] = [];
  for (const format of FORMATS) {
    const out = await source
      .clone()
      .resize(previewWidth, previewHeight)
      .toFormat(format, { quality: format === "avif" ? 55 : 80 })
      .toBuffer();
    const key = `friends/${eventSlug}/${id}/preview-${previewWidth}.${format}`;
    await storage.put("private", key, out, {
      contentType: MIME[format],
      cacheControl: CACHE_CONTROL.private,
    });
    preview.push({ key, format, width: previewWidth, height: previewHeight, bytes: out.length });
  }

  return {
    id,
    event: eventSlug,
    filename,
    original: { key: originalKey, bytes: buffer.length, width: info.width, height: info.height },
    preview,
    takenAt: exif.takenAt,
    addedAt: new Date().toISOString(),
    blurDataUrl: await blurPlaceholder(source, info.width, info.height),
  };
}

/**
 * Invariant 2's actual check. `exifr.gps()` can't sniff GPS out of an AVIF/WebP container
 * directly — it throws `Unknown file format` on both, which would look exactly like "no GPS
 * found" if that error were swallowed, making the assertion a no-op for the two formats this
 * pipeline actually produces. So this goes through `sharp`'s own metadata instead: `meta.exif`,
 * when present, is the raw EXIF blob prefixed with the 6-byte JPEG APP1 marker (`Exif\0\0`) that
 * `sharp`/libvips writes even inside non-JPEG containers — stripping that prefix leaves a plain
 * TIFF payload `exifr.gps()` reads reliably regardless of what format it was embedded in.
 */
async function gpsSurvived(imageBuffer: Buffer): Promise<boolean> {
  const meta = await sharp(imageBuffer).metadata();
  if (!meta.exif) return false;
  const gps = await gpsOf(meta.exif.subarray(6)).catch(() => undefined);
  return !!gps;
}

/** ~20px WebP as a data URI — the LQIP from D4 step 4. */
async function blurPlaceholder(source: Sharp, width: number, height: number): Promise<string> {
  const w = 20;
  const h = Math.max(1, Math.round((w / width) * height));
  const buffer = await source.clone().resize(w, h).webp({ quality: 40 }).toBuffer();
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}

async function readExif(buffer: Buffer): Promise<ExifData> {
  try {
    const tags = await parseExif(buffer, { pick: ["DateTimeOriginal", "CreateDate"] });
    const date: Date | undefined = tags?.DateTimeOriginal ?? tags?.CreateDate;
    return { takenAt: date instanceof Date ? date.toISOString() : undefined };
  } catch {
    // No EXIF block, or a format exifr doesn't parse — not fatal, the photo just has no takenAt.
    return {};
  }
}

// ---------------------------------------------------------------------------
// Manifest helpers — mutate the in-memory manifest; content.ts owns the actual write
// ---------------------------------------------------------------------------

async function ensureCategory(manifest: PublicManifest, slug: string): Promise<void> {
  if (manifest.categories.some((c) => c.slug === slug)) return;
  console.log(`Category "${slug}" doesn't exist yet.`);
  const label = await ask("Display label", prettifyFilename(slug));
  manifest.categories.push({ slug, label, order: manifest.categories.length });
  console.log(`  created category ${slug} → "${label}"`);
}

function ensureEvent(manifest: FriendsManifest, slug: string, label: string): void {
  if (manifest.events.some((e) => e.slug === slug)) return;
  manifest.events.push({ slug, label });
  console.log(`Created event ${slug} → "${label}"`);
}

async function pingRevalidate(): Promise<void> {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!site || !secret) {
    console.warn("Skipping revalidate ping — NEXT_PUBLIC_SITE_URL or REVALIDATE_SECRET not set.");
    return;
  }
  try {
    const response = await fetch(new URL("/api/revalidate", site), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!response.ok) {
      console.warn(`Revalidate ping failed: ${response.status} ${response.statusText}`);
      return;
    }
    console.log("Revalidate ping sent — the gallery should be current within seconds.");
  } catch (error) {
    // The bucket write already succeeded; a failed ping only means the 5-minute TTL fallback
    // applies instead of "within seconds". Worth a warning, not worth failing the run.
    console.warn(`Could not reach ${site} to revalidate: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Flags {
  const files: string[] = [];
  const flags: Flags = { files, public: false, featured: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--public":
        flags.public = true;
        break;
      case "--featured":
        flags.featured = true;
        break;
      case "--event":
        flags.event = argv[++i];
        break;
      case "--category":
        flags.category = argv[++i];
        break;
      case "--title":
        flags.title = argv[++i];
        break;
      case "--caption":
        flags.caption = argv[++i];
        break;
      case "--location":
        flags.location = argv[++i];
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
        files.push(arg);
    }
  }
  return flags;
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue || "";
}

/** Runs `task` over `items` with at most `limit` in flight, preserving no particular order. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await task(next);
    }
  });
  await Promise.all(workers);
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let candidate = base || "item";
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  taken.add(candidate);
  return candidate;
}

function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "item";
}

function stripExt(filename: string): string {
  return filename.replace(/\.[^./]+$/, "");
}

function prettifyFilename(filename: string): string {
  return stripExt(filename)
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

main()
  .catch((error) => {
    console.error(`\n${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
