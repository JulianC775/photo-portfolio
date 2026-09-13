"use client";

/**
 * The X in the corner, plus the keyboard shortcuts that go with it.
 *
 * This is the only client-side piece of the detail page, and it exists because keyboard shortcuts
 * cannot be expressed in HTML — a `keydown` listener needs JavaScript. Everything it does is also
 * reachable without it: the X itself is a real `<Link>` (so it works as a link, middle-clicks,
 * opens in a new tab, and renders in the static HTML), and prev/next are the links already at the
 * bottom of the page. If this bundle never loads, the page loses the shortcuts and nothing else.
 *
 * Escape navigates with `router.push(href)` rather than `history.back()` on purpose: a visitor who
 * arrived from a shared link or a search result has no history to go back to, and `back()` would
 * either leave the site or do nothing. Pushing the gallery URL is correct from any entry point.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

type Props = {
  /** Where Escape and the X go — the gallery filtered to this item's category. */
  href: string;
  /** Arrow-key targets. Absent at the ends of the category, same as the prev/next links. */
  previousHref?: string;
  nextHref?: string;
};

export function CloseControls({ href, previousHref, nextHref }: Props) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A modifier means the key belongs to the browser or the OS (Cmd+ArrowLeft is "back",
      // Alt+ArrowRight is "forward"), and a shortcut that fires while someone is typing is a bug.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;

      const target =
        event.key === "Escape"
          ? href
          : event.key === "ArrowLeft"
            ? previousHref
            : event.key === "ArrowRight"
              ? nextHref
              : undefined;
      if (!target) return;

      // Arrow keys would otherwise scroll the page as well as navigate.
      event.preventDefault();
      router.push(target);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, href, previousHref, nextHref]);

  return (
    <Link
      href={href}
      aria-label="Close"
      // Fixed, so it stays reachable down a tall photo, and just below the 56px sticky nav rather
      // than on top of it. 44px square is the minimum comfortable tap target; the glyph inside is
      // smaller than the hit area.
      className="fixed right-3 top-16 z-40 flex h-11 w-11 items-center justify-center text-muted transition-colors hover:text-paper"
    >
      {/* Two strokes, drawn rather than a "×" glyph, so the weight matches the hairline chrome. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        className="h-5 w-5"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </Link>
  );
}

/** True when the keystroke is someone typing (or scrubbing a video), not a page-level shortcut. */
function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  // `video` is here because the timelapse player has native controls: once it has focus, the arrow
  // keys mean seek, and stealing them would break the player.
  return ["INPUT", "TEXTAREA", "SELECT", "VIDEO"].includes(target.tagName);
}
