/**
 * The friends index: one card per event.
 *
 * `requireGrant()` is the real access check — the proxy redirect is only cosmetic (see `proxy.ts`).
 * It runs before anything reads the manifest, so an unauthenticated request never causes a fetch
 * against the private bucket at all.
 *
 * **No cover images yet.** Previews live in the private bucket, which by design has no anonymous
 * read, so they can't be plain `<img src>` the way public gallery images are — every preview needs
 * a presigned URL. That's the right design but it can't be verified without a real bucket
 * answering, so it lands with the rest of the browse UI once the Pi is up. See PLAN.md M3.
 */
import { requireGrant } from "@/lib/auth";
import { getFriendsManifest, listEvents, listEventPhotos } from "@/lib/content";
import { isStorageConfigured } from "@/lib/storage";

export const metadata = { title: "Your photos" };

export default async function FriendsPage() {
  await requireGrant();

  // Development convenience only: in production a missing storage config must be a loud failure,
  // not a friendly notice that hides a broken deploy.
  if (!isStorageConfigured() && process.env.NODE_ENV !== "production") {
    return (
      <Shell>
        <p className="text-base leading-relaxed text-muted">
          Signed in — the auth flow works. There are no events to list because object storage
          isn&rsquo;t configured in this environment yet; see <code>docs/PI-SETUP.md</code>.
        </p>
      </Shell>
    );
  }

  const manifest = await getFriendsManifest();
  const events = listEvents(manifest);

  if (events.length === 0) {
    return (
      <Shell>
        <p className="text-base leading-relaxed text-muted">
          Nothing here yet. I&rsquo;ll let you know when I&rsquo;ve uploaded something.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ul className="divide-y divide-line border-t border-line">
        {events.map((event) => {
          const count = listEventPhotos(manifest, event.slug).length;
          return (
            <li key={event.slug} className="py-6">
              <a
                href={`/friends/${encodeURIComponent(event.slug)}`}
                className="group flex items-baseline justify-between gap-6"
              >
                <span>
                  <span className="text-lg font-light tracking-tight transition-colors group-hover:text-paper">
                    {event.label}
                  </span>
                  {event.date && (
                    <time dateTime={event.date} className="mt-1 block text-sm text-muted">
                      {new Date(`${event.date}T00:00:00Z`).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        timeZone: "UTC",
                      })}
                    </time>
                  )}
                </span>
                <span className="shrink-0 text-sm text-muted tabular-nums">
                  {count} photo{count === 1 ? "" : "s"}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-16 sm:py-24">
      <h1 className="text-2xl font-light tracking-tight">Your photos</h1>
      <p className="mt-3 mb-10 text-sm text-muted">
        Full resolution, exactly as they came off the camera.
      </p>
      {children}
    </div>
  );
}
