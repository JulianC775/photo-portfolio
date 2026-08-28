import type { Metadata } from "next";
import Link from "next/link";

import { getGrant } from "@/lib/auth";
import { signOut } from "./actions";

/**
 * **Invariant 4 lives here.** Every route under `/friends` inherits `noindex, nofollow` from this
 * layout, so a new page in this section cannot accidentally become crawlable — it would have to
 * explicitly override this to leak. The other two halves of the invariant are `sitemap.ts` (which
 * builds from the public manifest only) and `robots.ts` (which disallows the path).
 */
export const metadata: Metadata = {
  title: { default: "Friends", template: "%s — Friends" },
  robots: { index: false, follow: false, nocache: true },
};

export default async function FriendsLayout({ children }: { children: React.ReactNode }) {
  // Only to decide whether to offer a sign-out link. React's `cache` means this shares the token
  // verification with whatever the page does — it isn't a second check.
  const grant = await getGrant();

  return (
    <div className="flex min-h-full flex-col">
      {children}

      {grant && (
        <div className="mx-auto w-full max-w-7xl px-6 pb-12 text-sm">
          <form action={signOut}>
            <button type="submit" className="text-muted transition-colors hover:text-paper">
              Sign out
            </button>
          </form>
        </div>
      )}

      {/*
        A way back to the public site. The reverse link doesn't exist in the main nav by design —
        the friends section is reachable only from the footer (site.ts).
      */}
      <div className="mx-auto w-full max-w-7xl px-6 pb-12 text-sm">
        <Link href="/" className="text-muted transition-colors hover:text-paper">
          ← Back to the portfolio
        </Link>
      </div>
    </div>
  );
}
