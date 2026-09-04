/**
 * One event's photos: browse + download.
 *
 * **Every preview image needs a pre-signed URL**, not a plain `<img src>`. Unlike the public
 * gallery, friends' previews live in the *private* bucket (no anonymous read, by design — D3), so
 * this page signs one URL per rendition up front and hands `PhotoImage` a lookup instead of the
 * public `renditionUrl` it defaults to (see the `urlFor` note in `photo-image.tsx`).
 *
 * Those preview signatures get a longer expiry than the download redirect's. A friend might sit on
 * this page for a while scrolling before tapping Download; the images are already embedded in the
 * HTML by then, so a short-lived signature would just mean broken thumbnails, not a meaningfully
 * smaller exposure window. The download link itself (`/api/friends/download/[id]`) is signed fresh
 * on click and stays on the short default (D6: "short-lived").
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PhotoImage } from "@/components/photo-image";
import { grantAllowsEvent, requireGrant } from "@/lib/auth";
import { findEvent, getFriendsManifest, listEventPhotos } from "@/lib/content";
import { fallbackRendition, formatTakenAt } from "@/lib/media";
import type { FriendsPhoto, Rendition } from "@/lib/manifest";
import { getStorage } from "@/lib/storage";

/** Preview images are viewed, not downloaded — an hour outlives any normal browsing session. */
const PREVIEW_URL_TTL_SECONDS = 3600;

const GRID_SIZES = "(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 100vw";

type Props = { params: Promise<{ event: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { event: eventSlug } = await params;
  const manifest = await getFriendsManifest();
  const event = findEvent(manifest, eventSlug);
  return { title: event?.label ?? "Event" };
}

export default async function EventPage({ params }: Props) {
  const { event: eventSlug } = await params;

  // `returnTo` so signing in from a stale bookmark lands back on this event, not the index.
  const grant = await requireGrant(`/friends/${eventSlug}`);

  const manifest = await getFriendsManifest();
  const event = findEvent(manifest, eventSlug);
  // Unknown event or a grant scoped to a different one: 404 either way, so a wrong-scoped grant
  // can't probe which other events exist (only matters once per-event passwords exist — D5).
  if (!event || !grantAllowsEvent(grant, event.slug)) notFound();

  const photos = listEventPhotos(manifest, event.slug);
  const previewUrls = await presignPreviews(photos);

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-6 py-16 sm:py-24">
      <header className="mb-10">
        <h1 className="text-2xl font-light tracking-tight">{event.label}</h1>
        <p className="mt-3 text-sm text-muted">
          {photos.length} photo{photos.length === 1 ? "" : "s"} · full resolution on download
        </p>
      </header>

      {photos.length === 0 ? (
        <p className="text-base leading-relaxed text-muted">Nothing in this event yet.</p>
      ) : (
        <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
          {photos.map((photo) => (
            <PhotoCard key={photo.id} photo={photo} previewUrls={previewUrls} />
          ))}
        </div>
      )}
    </div>
  );
}

function PhotoCard({
  photo,
  previewUrls,
}: {
  photo: FriendsPhoto;
  previewUrls: Map<string, string>;
}) {
  const urlFor = (rendition: Rendition) => previewUrls.get(rendition.key) ?? "";
  const fallback = fallbackRendition(photo.preview);
  const takenAt = formatTakenAt(photo.takenAt);

  return (
    <figure className="group relative mb-4 overflow-hidden break-inside-avoid bg-surface">
      <PhotoImage
        renditions={photo.preview}
        alt={photo.filename}
        width={fallback.width}
        height={fallback.height}
        blurDataUrl={photo.blurDataUrl}
        sizes={GRID_SIZES}
        urlFor={urlFor}
        className="w-full"
      />

      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-ink/85 to-transparent p-4">
        <span className="min-w-0">
          {takenAt && <span className="block truncate text-xs text-muted">{takenAt}</span>}
        </span>
        <a
          href={`/api/friends/download/${encodeURIComponent(photo.id)}`}
          // A real, taps-to-navigate link — not a scripted click(). iOS Safari can silently
          // drop JS-triggered downloads; a plain `<a>` doesn't have that problem (D6).
          className="pointer-events-auto shrink-0 border border-line bg-ink/60 px-3 py-1.5 text-xs text-paper transition-colors hover:border-paper"
        >
          Download
        </a>
      </figcaption>
    </figure>
  );
}

/** One pre-signed URL per unique preview rendition key, across every photo in the event. */
async function presignPreviews(photos: FriendsPhoto[]): Promise<Map<string, string>> {
  const keys = new Set<string>();
  for (const photo of photos) {
    for (const rendition of photo.preview) keys.add(rendition.key);
  }
  if (keys.size === 0) return new Map();

  const storage = await getStorage();
  const entries = await Promise.all(
    [...keys].map(async (key) => {
      const url = await storage.presignGet("private", key, { expiresIn: PREVIEW_URL_TTL_SECONDS });
      return [key, url] as const;
    }),
  );
  return new Map(entries);
}
