/**
 * The content boundary: the only module that reads or writes a manifest.
 *
 * Everything above this file — pages, components, the upload CLI — deals in the types from
 * `./manifest` and never in JSON, HTTP or object keys. Swapping the manifests for a real
 * database later is therefore a change to this one file (docs/PLAN.md D2), and only becomes
 * worth doing if per-photo mutable state shows up (view counts, per-person grants).
 *
 * The read side is deliberately asymmetric, because the two buckets are:
 *
 * - **Public** manifest: fetched over HTTP from the media domain, so Cloudflare's edge and
 *   Next's data cache both get to serve it. Tagged `content`, revalidated by the CLI's ping to
 *   `/api/revalidate` after every upload.
 * - **Friends** manifest: fetched with credentials through the S3 client, because the private
 *   bucket has no anonymous read at all (D3). Nothing about it may be cached.
 */
import { z } from "zod";

import {
  emptyFriendsManifest,
  emptyPublicManifest,
  friendsManifestSchema,
  publicManifestSchema,
  type Category,
  type EventFolder,
  type FriendsManifest,
  type FriendsPhoto,
  type PublicItem,
  type PublicManifest,
} from "./manifest";
import { CACHE_CONTROL, getStorage, publicMediaUrl } from "./storage";

/** Manifest locations, one per bucket. Fixed keys — nothing looks these up dynamically. */
export const MANIFEST_KEYS = {
  public: "content/public.json",
  friends: "content/friends.json",
} as const;

/** Seconds the public manifest may be served from cache without checking (D2). */
const PUBLIC_MANIFEST_TTL = 300;

/** Cache tag revalidated by `/api/revalidate`. */
export const CONTENT_TAG = "content";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The public manifest, validated.
 *
 * A missing object yields an empty manifest rather than an error, so the site renders an empty
 * gallery before the first upload — that's what lets the gallery be built and deployed while
 * the Pi is still being set up. A *malformed* object still throws: silently serving a partial
 * gallery because one field went bad would be worse than a visible failure (D2).
 */
export async function getPublicManifest(): Promise<PublicManifest> {
  const url = publicMediaUrl(MANIFEST_KEYS.public);

  let response: Response;
  try {
    response = await fetch(url, {
      // `force-cache` is explicit because in Next 16 fetch caching is opt-in — without it this
      // would hit the Pi on every render. `revalidate` is the fallback TTL; the tag is what the
      // CLI's revalidate ping actually clears.
      cache: "force-cache",
      next: { revalidate: PUBLIC_MANIFEST_TTL, tags: [CONTENT_TAG] },
    });
  } catch (error) {
    // A refused connection is not a missing manifest — it means the media host is unreachable.
    // The most common cause in development is the local media server not running, so say so.
    throw new Error(
      `Could not reach the media host at ${url}: ${(error as Error).message}\n` +
        "If you're developing against seeded data, start it with: npm run dev:media",
    );
  }

  if (response.status === 404 || response.status === 403) return emptyPublicManifest();
  if (!response.ok) {
    throw new Error(`Fetching ${MANIFEST_KEYS.public} failed: ${response.status} ${response.statusText}`);
  }

  return parseManifest(publicManifestSchema, await response.text(), MANIFEST_KEYS.public);
}

/**
 * The friends manifest, validated.
 *
 * No caching layer on purpose. This costs one S3 GET per call, which at a few-hundred-photo
 * manifest is a small JSON body and a handful of requests a day — not worth a cache that could
 * serve one friend's view to another. Read it once per page and pass it down rather than
 * calling this from several components in the same render.
 */
export async function getFriendsManifest(): Promise<FriendsManifest> {
  const storage = await getStorage();
  const body = await storage.getText("private", MANIFEST_KEYS.friends);
  if (body === null) return emptyFriendsManifest();
  return parseManifest(friendsManifestSchema, body, MANIFEST_KEYS.friends);
}

function parseManifest<T extends z.ZodType>(schema: T, body: string, key: string): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new Error(`${key} is not valid JSON: ${(error as Error).message}`);
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    // prettifyError gives the field paths, which is what actually helps when a hand-edited
    // manifest is wrong.
    throw new Error(`${key} failed validation:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Views over a manifest
// ---------------------------------------------------------------------------
// Pure functions taking an already-loaded manifest, so a page reads once and every list it
// renders is derived from that same snapshot. Also makes them trivially testable.

/** Categories in display order — the filter UI renders straight from this (D10). */
export function listCategories(manifest: PublicManifest): Category[] {
  return [...manifest.categories].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/**
 * Public items, newest first. `category` is a slug from the manifest; an unknown one yields an
 * empty list rather than throwing, so a stale bookmarked filter URL just shows nothing.
 */
export function listItems(manifest: PublicManifest, options: { category?: string } = {}): PublicItem[] {
  const items = options.category
    ? manifest.items.filter((item) => item.category === options.category)
    : manifest.items;
  return [...items].sort(byNewest);
}

export function findItem(manifest: PublicManifest, id: string): PublicItem | undefined {
  return manifest.items.find((item) => item.id === id);
}

/** Hero candidates, newest first. Empty until something is flagged `featured`. */
export function listFeatured(manifest: PublicManifest): PublicItem[] {
  return manifest.items.filter((item) => item.featured).sort(byNewest);
}

/** Events newest first, undated ones last. */
export function listEvents(manifest: FriendsManifest): EventFolder[] {
  return [...manifest.events].sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.label.localeCompare(b.label);
  });
}

export function findEvent(manifest: FriendsManifest, slug: string): EventFolder | undefined {
  return manifest.events.find((event) => event.slug === slug);
}

/** Photos in one event, oldest first — an event reads as a chronological story. */
export function listEventPhotos(manifest: FriendsManifest, eventSlug: string): FriendsPhoto[] {
  return manifest.photos
    .filter((photo) => photo.event === eventSlug)
    .sort((a, b) => (a.takenAt ?? a.addedAt).localeCompare(b.takenAt ?? b.addedAt));
}

export function findFriendsPhoto(manifest: FriendsManifest, id: string): FriendsPhoto | undefined {
  return manifest.photos.find((photo) => photo.id === id);
}

function byNewest(a: PublicItem, b: PublicItem): number {
  return (b.takenAt ?? b.addedAt).localeCompare(a.takenAt ?? a.addedAt);
}

// ---------------------------------------------------------------------------
// Writing — upload CLI only
// ---------------------------------------------------------------------------
// Accepts the schemas' *input* types so the CLI can omit fields that have defaults, minus
// `updatedAt`, which is stamped here — the CLI has no business inventing a value that is
// immediately overwritten.

export type PublicManifestInput = Omit<z.input<typeof publicManifestSchema>, "updatedAt">;
export type FriendsManifestInput = Omit<z.input<typeof friendsManifestSchema>, "updatedAt">;

export async function writePublicManifest(manifest: PublicManifestInput): Promise<PublicManifest> {
  return writeManifest(publicManifestSchema, stamp(manifest), "public", MANIFEST_KEYS.public);
}

export async function writeFriendsManifest(manifest: FriendsManifestInput): Promise<FriendsManifest> {
  return writeManifest(friendsManifestSchema, stamp(manifest), "private", MANIFEST_KEYS.friends);
}

function stamp<T extends object>(manifest: T): T & { updatedAt: string } {
  return { ...manifest, updatedAt: new Date().toISOString() };
}

/**
 * Validate a public manifest and produce the exact bytes that would go into the bucket.
 *
 * Exists for the dev seeder, which writes a fixture manifest to local disk instead of to
 * storage. It goes through here rather than doing its own `JSON.stringify` so that seeded data
 * is validated by the same schema and formatted identically to the real thing — a fixture that
 * the app would reject is worse than no fixture.
 */
export function serializePublicManifest(manifest: PublicManifestInput): string {
  const result = publicManifestSchema.safeParse(stamp(manifest));
  if (!result.success) {
    throw new Error(`Invalid public manifest:\n${z.prettifyError(result.error)}`);
  }
  return toBody(result.data);
}

/** Pretty-printed: the manifest is meant to stay readable and hand-fixable (D2). */
function toBody(manifest: unknown): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Validate → back up → write → mirror locally. The order matters:
 *
 * 1. **Validate first**, so an invalid manifest can never reach the bucket and take the gallery
 *    down (D2). This also catches an unknown category before anything is uploaded.
 * 2. **Check the mirror target before writing anything**, because a manifest write that can't be
 *    mirrored is a write that must not happen — the manifest is the only data on the Pi that
 *    cannot be regenerated from the originals (invariant 7, D2 durability).
 * 3. **Copy the live object to `content/backups/`** before overwriting. These replace the git
 *    history the manifest gave up by living outside the repo; a few KB each, keep them all.
 *    Rollback is copying one back over the live key.
 * 4. **Write, then mirror.**
 */
async function writeManifest<T extends z.ZodType>(
  schema: T,
  input: unknown,
  bucket: "public" | "private",
  key: string,
): Promise<z.infer<T>> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Refusing to write an invalid ${key}:\n${z.prettifyError(result.error)}`);
  }

  const mirrorDir = requireMirrorDir();
  const storage = await getStorage();

  const existing = await storage.getText(bucket, key);
  if (existing !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = key.split("/").pop()?.replace(/\.json$/, "") ?? "manifest";
    await storage.put(bucket, `content/backups/${name}-${stamp}.json`, existing, {
      contentType: "application/json",
      cacheControl: bucket === "public" ? CACHE_CONTROL.manifest : CACHE_CONTROL.private,
    });
  }

  const body = toBody(result.data);
  await storage.put(bucket, key, body, {
    contentType: "application/json",
    cacheControl: bucket === "public" ? CACHE_CONTROL.manifest : CACHE_CONTROL.private,
  });

  await mirrorLocally(mirrorDir, key, body);
  return result.data;
}

function requireMirrorDir(): string {
  const dir = process.env.LOCAL_MANIFEST_MIRROR;
  if (!dir) {
    throw new Error(
      "LOCAL_MANIFEST_MIRROR is not set, so this manifest write cannot be mirrored to your PC.\n" +
        "The manifest is the only data on the Pi that cannot be regenerated from your originals,\n" +
        "so the write is refused rather than left unmirrored. See CLAUDE.md invariant 7.",
    );
  }
  return dir;
}

/**
 * Invariant 7: every manifest write lands on the local machine too, in the same command.
 *
 * Two bundler notes, both about the fact that this function only ever runs from the CLI:
 *
 * - `node:fs` is imported dynamically rather than at the top of the file, because the gallery
 *   filter is a Client Component and may well want the pure view helpers above. A top-level
 *   `node:fs` import would make importing this module from client code a build error.
 * - `turbopackIgnore` on the `join`. The path comes from an env var, so Turbopack can't tell
 *   what it might touch and conservatively traces the whole project into the Vercel server
 *   output (it warns about exactly this). Nothing here runs at request time —
 *   `LOCAL_MANIFEST_MIRROR` isn't even set on Vercel — so that trace is pure deploy bloat.
 */
async function mirrorLocally(dir: string, key: string, body: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");

  const filename = key.split("/").pop() ?? "manifest.json";
  const target = join(/* turbopackIgnore: true */ dir, filename);
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  } catch (error) {
    throw new Error(
      `The manifest was written to storage but mirroring it to ${target} failed: ` +
        `${(error as Error).message}\nFix LOCAL_MANIFEST_MIRROR and re-run — the bucket copy is current.`,
    );
  }
}

/** Re-exported so the CLI has one import for everything manifest-shaped. */
export { emptyFriendsManifest, emptyPublicManifest } from "./manifest";
