/**
 * The friends login, in two steps on one URL:
 *
 *   /friends/login                → pick your gallery (a list of events that have a password)
 *   /friends/login?event=<slug>   → the password form for that one gallery
 *
 * Each event has its own password (docs/PLAN.md D5), so the form has to know which event it is
 * checking against — hence the pick-first step. The list is plain links, not a `<select>` plus
 * state: real URLs, no JavaScript, and a friend can bookmark their own gallery's login.
 *
 * Only events with a password set are offered (`listUnlockableEvents`), so uploading an event
 * doesn't reveal its name until the owner has decided who gets in. Event *names* are visible to
 * anyone who finds this page — the trade-off for letting friends pick rather than guess. The photos
 * behind them are not.
 *
 * Metadata (including noindex) comes from the friends layout — see the note there.
 */
import Link from "next/link";

import { isSafeReturnPath } from "@/lib/auth";
import { findEvent, getFriendsManifest, listUnlockableEvents } from "@/lib/content";
import { LoginForm } from "./login-form";

export const metadata = { title: "Friends" };

type Props = { searchParams: Promise<{ next?: string; event?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  const { next, event: requestedEvent } = await searchParams;
  // Sanitised here as well as in the action: this value is about to be rendered into the page, and
  // an unchecked one would be an open-redirect waiting for the form to trust it.
  const returnTo = next && isSafeReturnPath(next) ? next : undefined;

  const manifest = await getFriendsManifest();
  const events = listUnlockableEvents(manifest);

  // A bookmarked event page (`?next=/friends/<slug>`) should land straight on that gallery's
  // password form rather than asking the friend to pick it again.
  const slug = requestedEvent ?? eventSlugFromPath(returnTo);
  const event = slug ? findEvent(manifest, slug) : undefined;

  if (event?.passwordHash) {
    return (
      <Shell>
        <h1 className="text-2xl font-light tracking-tight">{event.label}</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">
          Full-resolution photos from this event. Enter the password I sent you.
        </p>

        <LoginForm event={event.slug} next={returnTo} />

        <p className="mt-10 text-sm">
          <Link href="/friends/login" className="text-muted transition-colors hover:text-paper">
            ← Not your event? Pick another
          </Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-light tracking-tight">Friends</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        Photos of you, at full resolution. Pick your event, then enter the password I sent you.
      </p>

      {events.length === 0 ? (
        <p className="mt-8 text-sm leading-relaxed text-muted">
          Nothing to open yet. I&rsquo;ll let you know when your photos are up.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-line border-t border-line">
          {events.map((item) => (
            <li key={item.slug}>
              <a
                href={`/friends/login?event=${encodeURIComponent(item.slug)}`}
                className="group flex items-baseline justify-between gap-6 py-4"
              >
                <span className="text-base font-light tracking-tight transition-colors group-hover:text-paper">
                  {item.label}
                </span>
                {item.date && (
                  <time dateTime={item.date} className="shrink-0 text-sm text-muted">
                    {new Date(`${item.date}T00:00:00Z`).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "long",
                      timeZone: "UTC",
                    })}
                  </time>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/** `/friends/<slug>` → `<slug>`; anything else → undefined. */
function eventSlugFromPath(path: string | undefined): string | undefined {
  const match = path?.match(/^\/friends\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[/?#]|$)/);
  return match?.[1];
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[70svh] w-full max-w-sm flex-col justify-center px-6 py-24">
      {children}
    </div>
  );
}
