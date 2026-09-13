/**
 * One event's photos: browse + download.
 *
 * **Every preview image needs a pre-signed URL**, not a plain `<img src>`. Unlike the public
 * gallery, friends' previews live in the *private* bucket (no anonymous read, by design — D3), so
 * this page signs one URL per photo up front.
 *
 * **One preview rendition per photo, and the cards are rendered by the client grid from compact
 * data.** Both are about page weight, and both were measured, not guessed: with `<picture>` markup
 * for two formats rendered on the server and handed to the grid as nodes, a 212-photo event was
 * 1.4 MB of HTML — every 500-character presigned URL appeared three times (`<source>`, `<img>`,
 * and again in the hydration payload, which repeats any server-rendered tree), and the 212 cards'
 * markup twice. Rendering the card *inside* the Client Component means the hydration payload
 * carries only this small data shape, and a single WebP rendition means one URL per photo. The
 * preview ladder has one width anyway, so `srcset` was buying nothing. AVIF still gets generated
 * by the CLI; it's just not the browse format here.
 *
 * Those preview signatures get a longer expiry than the download redirect's. A friend might sit on
 * this page for a while scrolling before tapping Download; the images are already embedded in the
 * HTML by then, so a short-lived signature would just mean broken thumbnails, not a meaningfully
 * smaller exposure window. The download link itself (`/api/friends/download/[id]`) is signed fresh
 * on click and stays on the short default (D6: "short-lived").
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { grantAllowsEvent, requireGrant } from "@/lib/auth";
import { findEvent, getFriendsManifest, listEventPhotos } from "@/lib/content";
import { formatTakenAt } from "@/lib/media";
import type { Rendition } from "@/lib/manifest";
import { getStorage } from "@/lib/storage";
import { SelectableGrid, type GridItem } from "./selectable-grid";

/** Preview images are viewed, not downloaded — an hour outlives any normal browsing session. */
const PREVIEW_URL_TTL_SECONDS = 3600;

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
  // can't probe which other events exist (D5).
  if (!event || !grantAllowsEvent(grant, event.slug)) notFound();

  const photos = listEventPhotos(manifest, event.slug);
  const storage = await getStorage();

  const items: GridItem[] = await Promise.all(
    photos.map(async (photo) => {
      const preview = browseRendition(photo.preview);
      return {
        id: photo.id,
        filename: photo.filename,
        takenAt: formatTakenAt(photo.takenAt),
        width: preview.width,
        height: preview.height,
        blurDataUrl: photo.blurDataUrl,
        src: await storage.presignGet("private", preview.key, { expiresIn: PREVIEW_URL_TTL_SECONDS }),
      };
    }),
  );

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
        <SelectableGrid
          items={items}
          archive={
            event.archive && {
              href: `/api/friends/archive/${encodeURIComponent(event.slug)}`,
              bytes: event.archive.bytes,
              photoCount: event.archive.photoCount,
            }
          }
        />
      )}
    </div>
  );
}

/**
 * The one rendition to browse with: WebP (every current browser) over anything else. Not a
 * `switch` on format — an unknown-format-only manifest still renders its first entry.
 */
function browseRendition(renditions: Rendition[]): Rendition {
  return renditions.find((r) => r.format === "webp") ?? renditions[0];
}
