import type { Metadata } from "next";

/**
 * The private section must never be indexed — see CLAUDE.md invariant 4. Setting it here
 * from the very first deploy means no version of this route is ever crawlable, including
 * this placeholder. M3 moves this to the segment layout when the real routes land.
 */
export const metadata: Metadata = {
  title: "Friends",
  robots: { index: false, follow: false },
};

export default function FriendsPlaceholderPage() {
  return (
    <div className="mx-auto flex min-h-[60svh] max-w-md flex-col justify-center px-6 py-24">
      <h1 className="text-2xl font-light tracking-tight">Friends</h1>
      <p className="mt-5 text-base leading-relaxed text-muted">
        This is where you&rsquo;ll find photos of you, sorted by event, ready to download.
        It isn&rsquo;t ready yet — check back soon.
      </p>
    </div>
  );
}
