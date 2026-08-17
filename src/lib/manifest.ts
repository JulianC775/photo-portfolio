/**
 * The shape of the two manifests — the entire content model of the site.
 *
 * `docs/PLAN.md` D2: metadata lives as JSON in the buckets, not in git, so adding a photo
 * needs no commit and no deploy. The price of that is nobody type-checks the file before it
 * is served, so every read validates against these schemas and fails loudly (D2: "Validate
 * with zod on load so a malformed manifest fails loudly").
 *
 * This module only *describes* the data. `src/lib/content.ts` is the only code that reads or
 * writes it — see CLAUDE.md boundaries.
 *
 * Two rules drive most of the design here:
 *
 * 1. **Categories and events are data, never code** (D10 / invariant 8). Both are explicit
 *    arrays in the manifest, and photos reference them by slug via `z.string()` validated as
 *    a *reference into that array*. Never `z.enum`, so adding a category is a manifest edit.
 * 2. **Renditions are a flat list, not fixed fields.** `{ 400: ..., 1200: ... }` would bake
 *    the current size ladder into the type; a list of `{ format, width, key }` lets the CLI
 *    add a size or a new format (JPEG XL, say) without a schema change or a deploy.
 */
import { z } from "zod";

/** Lowercase kebab-case. Used for ids, category slugs and event slugs — all appear in URLs. */
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case (a-z, 0-9, hyphens)");

/** A key inside a bucket, e.g. `photos/milky-way-sedona/1200.avif`. No leading slash. */
const objectKey = z
  .string()
  .min(1)
  .refine((k) => !k.startsWith("/"), "object keys are bucket-relative and must not start with /");

const pixels = z.number().int().positive();
const byteCount = z.number().int().nonnegative();

/**
 * A ~20px base64 LQIP (D4 step 4). Kept inline in the manifest rather than as an object so the
 * grid needs one round trip, not one per placeholder.
 */
const blurDataUrl = z.string().startsWith("data:image/");

// ---------------------------------------------------------------------------
// Renditions — one generated file at one size in one format
// ---------------------------------------------------------------------------

export const renditionSchema = z.object({
  key: objectKey,
  /**
   * `avif`, `webp`, `jpeg`, … deliberately `z.string()`: the format ladder is the CLI's
   * business. Consumers group renditions by format to build `<source>`/`srcset` and never
   * branch on a specific value.
   */
  format: z.string().min(1),
  width: pixels,
  height: pixels,
  bytes: byteCount.optional(),
});

export const videoSourceSchema = z.object({
  key: objectKey,
  /** MIME type, e.g. `video/mp4` — goes straight into `<source type>`. */
  contentType: z.string().min(1),
  width: pixels,
  height: pixels,
  bytes: byteCount.optional(),
});

// ---------------------------------------------------------------------------
// Public manifest
// ---------------------------------------------------------------------------

/**
 * Fields every public item has, whether photo or timelapse. Spread into both members of the
 * discriminated union below rather than expressed as a base schema + `.extend()`, because
 * `z.discriminatedUnion` wants plain object schemas.
 */
const publicItemBase = {
  id: slug,
  title: z.string().min(1),
  /** Slug of a category in this manifest's `categories` array. Validated below. */
  category: z.string().min(1),
  caption: z.string().optional(),
  /** When the shot was taken, from EXIF where available. */
  takenAt: z.iso.datetime().optional(),
  /**
   * A human-readable place name only — "Sedona, Arizona". Never coordinates: public images
   * have their GPS EXIF stripped (invariant 2) and putting it back in the manifest would
   * defeat the point.
   */
  location: z.string().optional(),
  /** Candidate for the home page hero. More than one is fine; the page picks. */
  featured: z.boolean().default(false),
  /** When the upload CLI added it. Drives default ordering. */
  addedAt: z.iso.datetime(),
  /** Intrinsic dimensions of the largest rendition, so the grid can reserve space (no CLS). */
  width: pixels,
  height: pixels,
  blurDataUrl: blurDataUrl.optional(),
  /**
   * Original filename on the owner's PC. Not shown anywhere — it is how the CLI recognises a
   * file it has already uploaded and skips it, so an interrupted batch resumes (D4).
   */
  sourceFilename: z.string().min(1).optional(),
};

export const photoSchema = z.object({
  kind: z.literal("photo"),
  ...publicItemBase,
  /** Every generated size/format. At least one, or there is nothing to show. */
  renditions: z.array(renditionSchema).min(1),
});

export const timelapseSchema = z.object({
  kind: z.literal("timelapse"),
  ...publicItemBase,
  /** One compressed MP4 to start (D7); a list so an HLS/AV1 source can be added later. */
  sources: z.array(videoSourceSchema).min(1),
  /** Poster frame, as a normal rendition list so the grid treats it exactly like a photo. */
  poster: z.array(renditionSchema).min(1),
  durationSeconds: z.number().positive().optional(),
});

export const publicItemSchema = z.discriminatedUnion("kind", [photoSchema, timelapseSchema]);

export const categorySchema = z.object({
  slug,
  /** What the filter UI shows, e.g. "Astro". Editable without touching photos. */
  label: z.string().min(1),
  /** Ascending. Ties fall back to label. */
  order: z.number().int().default(0),
});

const publicManifestShape = z.object({
  /** Bumped only by a breaking shape change, so a stale reader fails instead of guessing. */
  version: z.literal(1),
  updatedAt: z.iso.datetime(),
  /**
   * Explicit rather than derived from the photos (D10) — that keeps labels and ordering
   * controllable, and lets a category exist before it has a photo in it.
   */
  categories: z.array(categorySchema),
  items: z.array(publicItemSchema),
});

export const publicManifestSchema = publicManifestShape.superRefine((manifest, ctx) => {
  requireUniqueSlugs(
    manifest.categories.map((c) => c.slug),
    ["categories"],
    "category slug",
    ctx,
  );
  requireUniqueSlugs(
    manifest.items.map((i) => i.id),
    ["items"],
    "item id",
    ctx,
  );

  // The invariant-8 reference check: a photo may only name a category the manifest declares.
  const known = new Set(manifest.categories.map((c) => c.slug));
  manifest.items.forEach((item, index) => {
    if (!known.has(item.category)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "category"],
        message: `unknown category "${item.category}" — add it to the manifest's categories array first`,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Friends manifest
// ---------------------------------------------------------------------------

export const eventSchema = z.object({
  slug,
  /** Display name, e.g. "Camping Trip 2026". */
  label: z.string().min(1),
  /** Date of the event itself (not of upload). Sorted newest first in the UI. */
  date: z.iso.date().optional(),
  /** Id of a photo in this manifest to use as the folder cover. Validated below. */
  coverPhotoId: z.string().min(1).optional(),
});

export const friendsPhotoSchema = z.object({
  id: slug,
  /** Slug of an event in this manifest's `events` array. Validated below. */
  event: z.string().min(1),
  /**
   * The name the file should save as. Sent as `Content-Disposition: attachment; filename=…`
   * on the presigned URL (D6) — the friend gets `DSC_4821.jpg`, not an opaque object key.
   */
  filename: z.string().min(1),
  /**
   * The untouched original, full EXIF intact (invariant 3). This is what Download serves and
   * the only reason the private bucket exists.
   */
  original: z.object({ key: objectKey, bytes: byteCount, width: pixels, height: pixels }),
  /** Web-sized derivatives so browsing an event doesn't pull 25 MB files (D4 step 3). */
  preview: z.array(renditionSchema).min(1),
  takenAt: z.iso.datetime().optional(),
  addedAt: z.iso.datetime(),
  blurDataUrl: blurDataUrl.optional(),
});

const friendsManifestShape = z.object({
  version: z.literal(1),
  updatedAt: z.iso.datetime(),
  events: z.array(eventSchema),
  photos: z.array(friendsPhotoSchema),
});

export const friendsManifestSchema = friendsManifestShape.superRefine((manifest, ctx) => {
  requireUniqueSlugs(
    manifest.events.map((e) => e.slug),
    ["events"],
    "event slug",
    ctx,
  );
  requireUniqueSlugs(
    manifest.photos.map((p) => p.id),
    ["photos"],
    "photo id",
    ctx,
  );

  const knownEvents = new Set(manifest.events.map((e) => e.slug));
  manifest.photos.forEach((photo, index) => {
    if (!knownEvents.has(photo.event)) {
      ctx.addIssue({
        code: "custom",
        path: ["photos", index, "event"],
        message: `unknown event "${photo.event}" — add it to the manifest's events array first`,
      });
    }
  });

  const knownPhotos = new Set(manifest.photos.map((p) => p.id));
  manifest.events.forEach((event, index) => {
    if (event.coverPhotoId && !knownPhotos.has(event.coverPhotoId)) {
      ctx.addIssue({
        code: "custom",
        path: ["events", index, "coverPhotoId"],
        message: `coverPhotoId "${event.coverPhotoId}" is not a photo in this manifest`,
      });
    }
  });
});

function requireUniqueSlugs(
  values: string[],
  path: (string | number)[],
  label: string,
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", path: [...path, index], message: `duplicate ${label} "${value}"` });
    }
    seen.add(value);
  });
}

// ---------------------------------------------------------------------------
// Types — inferred, never hand-written, so schema and type can't drift
// ---------------------------------------------------------------------------

export type Rendition = z.infer<typeof renditionSchema>;
export type VideoSource = z.infer<typeof videoSourceSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Photo = z.infer<typeof photoSchema>;
export type Timelapse = z.infer<typeof timelapseSchema>;
export type PublicItem = z.infer<typeof publicItemSchema>;
export type PublicManifest = z.infer<typeof publicManifestSchema>;
export type EventFolder = z.infer<typeof eventSchema>;
export type FriendsPhoto = z.infer<typeof friendsPhotoSchema>;
export type FriendsManifest = z.infer<typeof friendsManifestSchema>;

// ---------------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------------

/**
 * A valid, empty manifest. Used two ways: the CLI starts from one on the very first upload,
 * and `content.ts` falls back to one when the object doesn't exist yet — so the site renders
 * an empty gallery instead of erroring before any photo has been uploaded.
 */
export function emptyPublicManifest(): PublicManifest {
  return { version: 1, updatedAt: new Date().toISOString(), categories: [], items: [] };
}

export function emptyFriendsManifest(): FriendsManifest {
  return { version: 1, updatedAt: new Date().toISOString(), events: [], photos: [] };
}
