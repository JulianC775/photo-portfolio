/**
 * Build one zip of an event's originals and store it next to them (docs/PLAN.md D6).
 *
 * The zip is built **from the bucket, not from disk**: the CLI streams each original back out
 * of the private bucket and straight into the archive, and the archive straight back up as a
 * multipart upload. Nothing is held in memory and nothing is written to disk, and — the actual
 * reason — the originals for an event may live in a folder the CLI was never pointed at during
 * this run (earlier batch, other camera), while the bucket always has all of them.
 *
 * On the LAN that is a read and a write of the whole event; for a couple of hundred JPEGs it is a
 * minute or two. **Stored, not deflated**: JPEGs don't compress, so deflate would only burn Pi
 * CPU on the way in and the friend's on the way out.
 *
 * Returns the manifest's `archive` entry; the caller writes the manifest. The key is fixed per
 * event so a rebuild overwrites the old zip — private objects are `no-store`, so there is no cache
 * to go stale.
 */
import { ZipArchive } from "archiver";
import { PassThrough, type Readable } from "node:stream";

import type { EventFolder, FriendsManifest } from "../../src/lib/manifest";
import { CACHE_CONTROL, type StorageProvider } from "../../src/lib/storage";

export function archiveKey(eventSlug: string): string {
  return `friends/${eventSlug}/${eventSlug}.zip`;
}

export async function buildEventArchive(
  storage: StorageProvider,
  manifest: FriendsManifest,
  event: EventFolder,
  log: (line: string) => void = console.log,
): Promise<NonNullable<EventFolder["archive"]>> {
  const photos = manifest.photos
    .filter((photo) => photo.event === event.slug)
    .sort((a, b) => a.filename.localeCompare(b.filename));
  if (photos.length === 0) {
    throw new Error(`Event "${event.label}" has no photos to archive.`);
  }

  const key = archiveKey(event.slug);
  const archive = new ZipArchive({ store: true });
  const body = new PassThrough();
  archive.pipe(body);

  // Upload and archive run concurrently — the archive produces, the upload consumes. Both errors
  // are awaited below so a failure on either side surfaces rather than hanging the other.
  const uploading = storage.put("private", key, body, {
    contentType: "application/zip",
    cacheControl: CACHE_CONTROL.private,
  });

  const archiving = (async () => {
    // Filenames inside the zip must be unique; two cameras can both produce IMG_0001.JPG.
    const seen = new Map<string, number>();
    for (const photo of photos) {
      const name = uniqueName(photo.filename, seen);
      // One object stream open at a time, opened only when the archive is ready to drain it.
      // Opening them all up front held two hundred idle HTTPS responses, and the provider reset
      // the ones that sat unread for long enough — an unhandled 'error' that killed the build.
      const source = await storage.getStream("private", photo.original.key);
      if (!source) throw new Error(`${photo.original.key} is missing from the bucket.`);
      log(`  + ${name}`);
      await appendAndDrain(archive, source, { name, date: photo.takenAt ? new Date(photo.takenAt) : undefined });
    }
    await archive.finalize();
  })();

  await Promise.all([archiving, uploading]);

  return {
    key,
    bytes: archive.pointer(),
    photoCount: photos.length,
    generatedAt: new Date().toISOString(),
  };
}

/** Append one entry and resolve once the archive has fully consumed it (or reject on error). */
function appendAndDrain(
  archive: ZipArchive,
  source: Readable,
  data: { name: string; date?: Date },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: { name?: string }) => {
      if (entry.name === data.name) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
      source.off("error", onError);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
    source.on("error", onError);
    archive.append(source, data);
  });
}

function uniqueName(filename: string, seen: Map<string, number>): string {
  const count = seen.get(filename) ?? 0;
  seen.set(filename, count + 1);
  if (count === 0) return filename;
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? `${filename.slice(0, dot)}-${count + 1}${filename.slice(dot)}`
    : `${filename}-${count + 1}`;
}
