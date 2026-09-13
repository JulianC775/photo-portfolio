/**
 * The upload CLI (docs/PLAN.md D4) — the only way photos get into either bucket.
 *
 *   npm run upload -- ./shot.jpg --public --category astro --title "Milky Way over Sedona"
 *   npm run upload -- ./event/*.jpg --event "Camping Trip 2026"
 *   npm run upload -- ./shot.jpg --public --category astro --event "Camping Trip 2026"
 *   npm run upload -- ./batch/*.jpg --public --category photography --label "Photography" --title-from-date
 *   npm run upload -- ./timelapse.mp4 --public --category timelapses --title "Perseids"
 *
 * Flags may be omitted; missing ones are prompted for. Passing both `--public` and `--event`
 * uploads the same source files twice, processed differently for each destination (D4).
 *
 * Per file: read EXIF → public path generates 400/1200/2400w AVIF+WebP with `sharp` and asserts
 * no GPS tag survived (invariant 2) → friends path uploads the original byte-for-byte with full
 * EXIF intact (invariant 3) plus one browse-sized preview → a blur placeholder is generated either
 * way → everything lands in the bucket before the manifest is touched.
 *
 * A video source (`.mp4`/`.mov`) takes the timelapse path instead (docs/PLAN.md D7): ffmpeg
 * transcodes it to one well-compressed 1080p H.264 MP4, a frame is pulled out for the poster and
 * run through the *same* derivative pipeline photos use, and the item lands in the public manifest
 * as `kind: "timelapse"`. Public bucket only — a video passed with `--event` is refused, because a
 * friends event is full-resolution photos people download (D4).
 *
 * Idempotent: a file already recorded in the manifest (by `sourceFilename` for public, by
 * `filename`+event for friends) is skipped without re-reading or re-uploading it, so an
 * interrupted batch resumes by re-running the same command.
 *
 * Manifest writes, backups and the local mirror all happen inside `writePublicManifest` /
 * `writeFriendsManifest` (src/lib/content.ts) — this script never touches a manifest object
 * directly, so invariant 7 is enforced in one place regardless of who calls it.
 */
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { gps as gpsOf, parse as parseExif } from "exifr";
import sharp, { type Sharp } from "sharp";

import {
  getFriendsManifestDirect,
  getPublicManifestDirect,
  writeFriendsManifest,
  writePublicManifest,
  type FriendsManifestInput,
  type PublicManifestInput,
} from "../src/lib/content";
import type {
  FriendsManifest,
  PublicManifest,
  Rendition,
  VideoSource,
} from "../src/lib/manifest";
import { CACHE_CONTROL, getStorage, type StorageProvider } from "../src/lib/storage";
import { buildEventArchive } from "./lib/archive";
import { assertPrivateRoom, describePrivateUsage, privateUsageBytes } from "./lib/quota";

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
 * Extensions that take the video path (docs/PLAN.md D7). `.mov` is here and still gets transcoded
 * to MP4: a camera `.mov` is usually H.264 already, but neither its container nor its bitrate is
 * what a browser wants to stream.
 */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov"]);

/**
 * D7's "one well-compressed 1080p H.264 MP4", as ffmpeg settings. 1080p caps the bitrate at
 * something the Pi's upstream and a phone connection can both live with; crf 23 is the usual
 * quality-per-byte sweet spot for H.264, and `preset slow` spends encode time on the owner's PC
 * once rather than bandwidth on every view.
 */
const VIDEO_MAX_HEIGHT = 1080;
const VIDEO_CRF = 23;
const VIDEO_PRESET = "slow";
const VIDEO_AUDIO_BITRATE = "128k";

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
  /** Display label for a category being created in this run — skips the prompt. */
  label?: string;
  /**
   * Title every public photo by the month it was taken ("June 2026", from EXIF), falling back to
   * the filename. For batches: 80 hand-typed titles is where a curated upload stops happening.
   */
  titleFromDate: boolean;
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

  // Videos are public-gallery only: a friends event is full-resolution photos people download
  // (D4), so there is no private-bucket video path at all. Checked before any work, so a mixed
  // batch refuses up front instead of half-uploading itself.
  const videos = flags.files.filter(isVideoFile);
  if (eventLabel && videos.length > 0) {
    throw new Error(
      `Videos can't go into a friends event — re-run without --event for: ${videos
        .map((file) => basename(file))
        .join(", ")}`,
    );
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
  const friendsManifest = eventLabel ? await getFriendsManifestDirect() : undefined;

  let categorySlug: string | undefined;
  if (toPublic && publicManifest) {
    categorySlug = flags.category ?? (await ask("Category slug"));
    await ensureCategory(publicManifest, categorySlug, flags.label);
  }

  let eventSlug: string | undefined;
  if (eventLabel && friendsManifest) {
    eventSlug = slugify(eventLabel);
    ensureEvent(friendsManifest, eventSlug, eventLabel);
  }

  // Gather anything that needs a prompt up front, sequentially — readline can't share a terminal
  // with the concurrent phase below.
  const publicTitles = new Map<string, string>();
  if (toPublic && publicManifest && !flags.titleFromDate) {
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

  // The private bucket has a size cap (scripts/lib/quota.ts). Check before doing any work: a
  // friends upload costs the originals, small previews, and — once the zip is rebuilt at the end —
  // the originals again. Refusing up front beats discovering it after 200 files.
  if (eventLabel && friendsManifest) {
    const pending = flags.files.filter(
      (filePath) =>
        !friendsManifest.photos.some((p) => p.event === eventSlug && p.filename === basename(filePath)),
    );
    if (pending.length > 0) {
      const sizes = await Promise.all(pending.map((filePath) => stat(filePath).then((s) => s.size)));
      const originals = sizes.reduce((sum, size) => sum + size, 0);
      const previews = pending.length * 200_000;
      const priorArchive = friendsManifest.events.find((e) => e.slug === eventSlug)?.archive?.bytes ?? 0;
      const eventOriginals = friendsManifest.photos
        .filter((p) => p.event === eventSlug)
        .reduce((sum, p) => sum + p.original.bytes, 0);
      const zipGrowth = eventOriginals + originals - priorArchive;
      await assertPrivateRoom(storage, originals + previews + zipGrowth, `"${eventLabel}" (${pending.length} photos + zip)`);
    }
  }

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

    // The video path never reads the file into memory — a timelapse export can be gigabytes.
    // ffprobe and ffmpeg work on the path, and the upload is streamed from the transcode.
    if (isVideoFile(filePath)) {
      let probe: VideoProbe;
      try {
        probe = await probeVideo(filePath);
      } catch (error) {
        failures.push({ file: filename, error: error as Error });
        console.error(`  ${filename}: ffprobe failed — ${(error as Error).message}`);
        return;
      }

      try {
        const item = await processVideo({
          filePath,
          filename,
          probe,
          categorySlug: categorySlug!,
          title:
            publicTitles.get(filename) ??
            (flags.titleFromDate ? monthTitle(probe.takenAt) : undefined) ??
            prettifyFilename(filename),
          caption: flags.caption,
          location: flags.location,
          featured: flags.featured,
          ids: publicIds,
          storage,
        });
        newPublicItems.push(item);
        console.log(`  ${filename}: public ok (timelapse, ${item.poster.length} poster renditions)`);
      } catch (error) {
        failures.push({ file: filename, error: error as Error });
        console.error(`  ${filename}: public FAILED — ${(error as Error).message}`);
      }
      return;
    }

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
          title:
            publicTitles.get(filename) ??
            (flags.titleFromDate ? monthTitle(exif.takenAt) : undefined) ??
            prettifyFilename(filename),
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
    // Photos first, so a crash mid-zip leaves the manifest correct (just without an archive) and
    // `npm run zip` can finish the job; then the zip, then the manifest again with its entry.
    let updated = await writeFriendsManifest({
      version: 1,
      events: friendsManifest.events,
      photos: [...friendsManifest.photos, ...newFriendsPhotos],
    });
    console.log(`Friends manifest written: ${updated.photos.length} photo(s) total.`);

    const event = updated.events.find((e) => e.slug === eventSlug);
    if (event) {
      console.log(`
Building "Download all" zip for "${event.label}" (D6)…`);
      try {
        event.archive = await buildEventArchive(storage, updated, event, () => {});
        updated = await writeFriendsManifest(updated);
        console.log(`Archive written: ${event.archive.photoCount} photos, ${(event.archive.bytes / 1e6).toFixed(0)} MB.`);
        console.log(describePrivateUsage(await privateUsageBytes(storage)));
      } catch (error) {
        console.error(`Archive FAILED — photos are fine; rebuild with: npm run zip -- "${event.label}"`);
        console.error(`  ${(error as Error).message}`);
        process.exitCode = 1;
      }
    }
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

  const { width, height, renditions, blurDataUrl } = await publicDerivatives({
    buffer,
    storage,
    keyFor: (w, format) => `photos/${id}/${w}.${format}`,
  });

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
    width,
    height,
    renditions,
    blurDataUrl,
    sourceFilename: filename,
  };
}

/**
 * The public image pipeline: normalise orientation, generate the D4 size ladder in both formats,
 * assert invariant 2 on every output, upload, and hand back the renditions plus an LQIP.
 *
 * Shared with the timelapse poster on purpose. A poster that goes through exactly this ends up as
 * an ordinary rendition list of the same widths and formats, so `PhotoGrid` renders a timelapse
 * with the same component and no branch on `kind` (the GPS assertion is a no-op for a frame out of
 * ffmpeg, but running it unconditionally is cheaper than reasoning about which sources can skip it).
 */
async function publicDerivatives(args: {
  buffer: Buffer;
  storage: StorageProvider;
  /** Where each output goes — `photos/<id>/…` for a photo, `timelapses/<id>/poster-…` for a poster. */
  keyFor: (width: number, format: string) => string;
}): Promise<{ width: number; height: number; renditions: Rendition[]; blurDataUrl: string }> {
  const { buffer, storage, keyFor } = args;

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

      const key = keyFor(width, format);
      await storage.put("public", key, out, {
        contentType: MIME[format],
        cacheControl: CACHE_CONTROL.immutable,
      });
      renditions.push({ key, format, width, height, bytes: out.length });
    }
  }

  return {
    width: sourceWidth,
    height: sourceHeight,
    renditions,
    blurDataUrl: await blurPlaceholder(source, sourceWidth, sourceHeight),
  };
}

/**
 * The timelapse path (D7). Transcode → upload the MP4 → poster frame through the photo pipeline.
 *
 * `width`/`height` on the item come from the *transcoded* file, not the source: they are what the
 * grid and the detail page reserve space with, and after a 1080p downscale (or an autorotated
 * phone clip) the source dimensions would be the wrong ones.
 */
async function processVideo(args: {
  filePath: string;
  filename: string;
  probe: VideoProbe;
  categorySlug: string;
  title: string;
  caption?: string;
  location?: string;
  featured: boolean;
  ids: Set<string>;
  storage: StorageProvider;
}): Promise<Extract<PublicManifestInput["items"][number], { kind: "timelapse" }>> {
  const { filePath, filename, probe, categorySlug, title, caption, location, featured, ids, storage } =
    args;

  const id = uniqueSlug(slugify(title) || "timelapse", ids);

  // Everything ffmpeg writes is a derivative, like a `sharp` rendition — it goes to a scratch
  // directory that is deleted in `finally`, whether the upload worked or not.
  const workDir = await mkdtemp(join(tmpdir(), "portfolio-video-"));
  try {
    const mp4Path = join(workDir, "encoded.mp4");
    const encoded = await queueTranscode(() => transcodeTo1080p(filePath, mp4Path, probe));

    // Keyed by the encoded height, mirroring `photos/<id>/<width>.<format>`: content-addressed
    // enough that a re-encode at a different size is a new key, so `immutable` is honest (D3).
    const key = `timelapses/${id}/${encoded.height}.mp4`;
    // Streamed, never buffered: a long timelapse can be bigger than the heap, and `storage.put`
    // hands a stream to `@aws-sdk/lib-storage`, which switches to multipart on its own (D4 step 5).
    await storage.put("public", key, createReadStream(mp4Path), {
      contentType: "video/mp4",
      cacheControl: CACHE_CONTROL.immutable,
    });
    const sources: VideoSource[] = [
      { key, contentType: "video/mp4", width: encoded.width, height: encoded.height, bytes: encoded.bytes },
    ];

    // Poster from the transcoded file, not the original: it then matches the first thing that
    // actually plays, and its aspect ratio matches the width/height above by construction.
    const frame = await extractPosterFrame(mp4Path, join(workDir, "poster.png"), encoded.durationSeconds);
    const poster = await publicDerivatives({
      buffer: frame,
      storage,
      keyFor: (w, format) => `timelapses/${id}/poster-${w}.${format}`,
    });

    return {
      kind: "timelapse",
      id,
      title,
      category: categorySlug,
      caption,
      location,
      takenAt: probe.takenAt,
      featured,
      addedAt: new Date().toISOString(),
      width: encoded.width,
      height: encoded.height,
      sources,
      poster: poster.renditions,
      durationSeconds: encoded.durationSeconds,
      blurDataUrl: poster.blurDataUrl,
      sourceFilename: filename,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// Video (docs/PLAN.md D7) — ffmpeg/ffprobe via child_process, no npm dependency
// ---------------------------------------------------------------------------

/**
 * `execFile`, not `exec`: arguments are passed as an array, so a path with a space or a title with
 * a quote in it can never be re-parsed as shell syntax.
 */
const execFileAsync = promisify(execFile);

type VideoProbe = {
  width: number;
  height: number;
  durationSeconds?: number;
  /** From the container's `creation_time` tag only — see `probeVideo`. */
  takenAt?: string;
  /** `aac`, `pcm_s16le`, … or undefined when the file has no audio stream at all. */
  audioCodec?: string;
  bytes: number;
};

function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** The subset of `ffprobe -print_format json` this needs. Everything is optional — it's JSON. */
type FfprobeOutput = {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    tags?: Record<string, string>;
  }[];
  format?: { duration?: string; size?: string; tags?: Record<string, string> };
};

/**
 * Dimensions, duration, audio and creation date, without decoding the file.
 *
 * `takenAt` comes *only* from the container's `creation_time` tag, and stays undefined when that's
 * missing (most renders from Lightroom/Resolve have none). The file's mtime is tempting and wrong:
 * it is when the export finished, not when the sequence was shot, and a confidently wrong date
 * under a photo is worse than no date at all.
 */
async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { maxBuffer: 8 << 20 },
  );

  const probed = JSON.parse(stdout) as FfprobeOutput;
  const video = probed.streams?.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) {
    throw new Error(`no video stream found in ${basename(filePath)}`);
  }
  const audio = probed.streams?.find((stream) => stream.codec_type === "audio");

  const duration = Number(probed.format?.duration ?? video.duration);
  const created = probed.format?.tags?.creation_time ?? video.tags?.creation_time;
  const createdAt = created ? new Date(created) : undefined;

  return {
    width: video.width,
    height: video.height,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Number(duration.toFixed(3)) : undefined,
    takenAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : undefined,
    audioCodec: audio?.codec_name,
    bytes: Number(probed.format?.size) || (await stat(filePath)).size,
  };
}

/**
 * One transcode at a time, regardless of `CONCURRENCY`. x264 already uses every core on a single
 * file, so six parallel encodes would finish later than six sequential ones and interleave their
 * progress lines into noise. Photos in the same batch keep running concurrently around this.
 */
let transcodeQueue: Promise<unknown> = Promise.resolve();
function queueTranscode<T>(task: () => Promise<T>): Promise<T> {
  const result = transcodeQueue.then(task);
  // Swallowed only for the *queue's* copy of the promise, so one failed transcode doesn't reject
  // the next file's turn. The caller still sees the rejection through `result`.
  transcodeQueue = result.catch(() => undefined);
  return result;
}

/**
 * D7's "compress before upload": one H.264 MP4, at most 1080 tall. Returns a fresh probe of the
 * output, which is the authority on the final dimensions and duration.
 *
 * The non-obvious flags:
 *
 * - `scale=-2:1080` fixes the height and lets the width follow the aspect ratio, rounded to an
 *   even number (yuv420p's chroma subsampling requires even dimensions; `-1` can land on odd and
 *   fail). A source already ≤1080 tall is left alone rather than upscaled — upscaling adds bytes
 *   and no detail.
 * - `-movflags +faststart` rewrites the file with the `moov` atom at the front. Without it a
 *   browser must fetch the *end* of the file before it can render a single frame, which is the
 *   difference between a hero that starts instantly and one that stalls — and it is what makes
 *   byte-range requests useful for seeking rather than just supported.
 * - `-pix_fmt yuv420p` pins 8-bit 4:2:0 chroma, the one combination every hardware decoder and
 *   browser handles; an editor export can easily be 4:2:2 or 10-bit, which Safari refuses.
 *   (ffprobe may still *label* the result `yuvj420p` when the source is full-range — same
 *   subsampling, just a range flag carried through, which is what keeps the colours identical.)
 * - `-nostdin` so ffmpeg doesn't consume this CLI's readline stdin.
 */
async function transcodeTo1080p(input: string, output: string, probe: VideoProbe): Promise<VideoProbe> {
  const scale = probe.height > VIDEO_MAX_HEIGHT ? ["-vf", `scale=-2:${VIDEO_MAX_HEIGHT}`] : [];
  // Copied when it's already AAC, re-encoded when it isn't, dropped when there's no audio track —
  // which is the usual case for a timelapse.
  const audio =
    probe.audioCodec === undefined
      ? ["-an"]
      : probe.audioCodec === "aac"
        ? ["-c:a", "copy"]
        : ["-c:a", "aac", "-b:a", VIDEO_AUDIO_BITRATE];

  console.log(
    `  transcoding ${basename(input)} — ${probe.width}×${probe.height}, ${formatMb(probe.bytes)}, ` +
      `${probe.durationSeconds?.toFixed(0) ?? "?"}s → H.264 ${scale.length > 0 ? `${VIDEO_MAX_HEIGHT}p` : "source size"}, ` +
      `crf ${VIDEO_CRF}, preset ${VIDEO_PRESET}. This takes a while.`,
  );
  const startedAt = Date.now();

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-nostdin",
      "-loglevel", "error",
      "-i", input,
      "-map", "0:v:0",
      ...(probe.audioCodec ? ["-map", "0:a:0"] : []),
      ...scale,
      "-c:v", "libx264",
      "-crf", String(VIDEO_CRF),
      "-preset", VIDEO_PRESET,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      ...audio,
      output,
    ],
    { maxBuffer: 8 << 20 },
  );

  const encoded = await probeVideo(output);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(
    `  transcoded in ${seconds}s → ${formatMb(encoded.bytes)} ` +
      `(${encoded.width}×${encoded.height}, ${((100 * encoded.bytes) / probe.bytes).toFixed(0)}% of the source)`,
  );
  return encoded;
}

/**
 * One frame, as PNG so the AVIF/WebP ladder downstream is the only lossy step. Taken a second in
 * rather than at 0 — the opening frame of a night timelapse is often the darkest one in it — or at
 * the midpoint of anything shorter than two seconds. `-ss` before `-i` seeks by keyframe, which is
 * both far faster and plenty accurate for a still.
 */
async function extractPosterFrame(
  video: string,
  output: string,
  durationSeconds?: number,
): Promise<Buffer> {
  const at = durationSeconds !== undefined && durationSeconds < 2 ? durationSeconds / 2 : 1;
  await execFileAsync("ffmpeg", [
    "-y",
    "-nostdin",
    "-loglevel", "error",
    "-ss", at.toFixed(3),
    "-i", video,
    "-frames:v", "1",
    output,
  ]);
  return readFile(output);
}

function formatMb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
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

async function ensureCategory(manifest: PublicManifest, slug: string, givenLabel?: string): Promise<void> {
  if (manifest.categories.some((c) => c.slug === slug)) return;
  console.log(`Category "${slug}" doesn't exist yet.`);
  const label = givenLabel ?? (await ask("Display label", prettifyFilename(slug)));
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
  const flags: Flags = { files, public: false, featured: false, titleFromDate: false };

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
      case "--label":
        flags.label = argv[++i];
        break;
      case "--title-from-date":
        flags.titleFromDate = true;
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

/** "June 2026" from an ISO timestamp, or undefined when there was no EXIF date. */
function monthTitle(takenAt: string | undefined): string | undefined {
  if (!takenAt) return undefined;
  return new Date(takenAt).toLocaleDateString("en-US", { year: "numeric", month: "long", timeZone: "UTC" });
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
