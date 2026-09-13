"use client";

/**
 * The event grid with a checkbox on every photo, and the toolbar above it.
 *
 * A Client Component because selection is state that lives only in the browser — there is no
 * URL worth encoding "these 14 photos" into. The photo cards themselves are still rendered on
 * the server (presigned preview URLs, `<picture>` markup) and arrive here as already-rendered
 * `card` nodes; this component only wraps them. That keeps the S3 presigner and the manifest out
 * of the client bundle.
 *
 * **"Download selected" fires one download per photo**, each through the same
 * `/api/friends/download/[id]` redirect the single Download button uses. There is no zip for an
 * arbitrary selection: building one would either stream through Vercel (invariant 6) or need
 * every byte pulled into the browser first. Each download is started in a hidden iframe rather
 * than a scripted `<a>.click()` — the iframe navigates to the 302, the presigned response carries
 * `Content-Disposition: attachment`, and the browser saves it without leaving the page. Chrome
 * asks once to "allow multiple downloads"; the hint under the toolbar says so. iOS Safari may
 * only honour the first; the per-photo Download buttons remain the fallback (D6).
 *
 * "Download all" is different: it is a real link to the pre-built zip, so it works everywhere a
 * link does.
 */
import { useState } from "react";

export type GridItem = {
  id: string;
  filename: string;
  /** Server-rendered `<PhotoCard>`. */
  card: React.ReactNode;
};

type Props = {
  items: GridItem[];
  /** Present once the CLI has built the event's zip (docs/PLAN.md D6). */
  archive?: { href: string; bytes: number; photoCount: number };
};

/** Gap between iframe downloads. Too fast and browsers coalesce or drop them. */
const STAGGER_MS = 400;
/** How long an iframe stays in the DOM. Long enough for the redirect + the save prompt. */
const IFRAME_LIFETIME_MS = 60_000;

export function SelectableGrid({ items, archive }: Props) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [started, setStarted] = useState(0);

  const allSelected = selected.size === items.length && items.length > 0;

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function downloadSelected() {
    const ids = items.map((item) => item.id).filter((id) => selected.has(id));
    ids.forEach((id, index) => {
      window.setTimeout(() => startDownload(id), index * STAGGER_MS);
    });
    setStarted(ids.length);
  }

  return (
    <>
      <div className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-4 text-sm">
        {archive && (
          <a
            href={archive.href}
            // A real link, not a button: the zip is a plain presigned redirect and a tap must
            // survive iOS Safari's dislike of scripted downloads (D6).
            className="border-b border-paper pb-0.5 text-paper transition-colors hover:border-muted hover:text-muted"
          >
            Download all · {archive.photoCount} photos, {formatBytes(archive.bytes)} zip
          </a>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-muted">
          <button
            type="button"
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))
            }
            className="transition-colors hover:text-paper"
          >
            {allSelected ? "Clear selection" : "Select all"}
          </button>

          <button
            type="button"
            onClick={downloadSelected}
            disabled={selected.size === 0}
            className="border-b border-line pb-0.5 text-paper transition-colors hover:border-paper disabled:cursor-not-allowed disabled:border-transparent disabled:text-muted"
          >
            Download selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>

        {started > 0 && (
          <p role="status" className="basis-full text-xs text-muted">
            Starting {started} download{started === 1 ? "" : "s"}. If the browser asks to allow
            multiple downloads, say yes.
          </p>
        )}
      </div>

      <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
        {items.map((item) => {
          const checked = selected.has(item.id);
          return (
            <div
              key={item.id}
              className={`relative mb-4 break-inside-avoid ${checked ? "outline outline-2 outline-paper" : ""}`}
            >
              {item.card}
              <label
                // Sits over the top-left corner of the card. Large hit area on purpose — this is
                // tapped on phones.
                className="absolute top-0 left-0 z-10 flex cursor-pointer items-center p-3"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(item.id)}
                  aria-label={`Select ${item.filename}`}
                  className="h-5 w-5 cursor-pointer accent-paper"
                />
              </label>
            </div>
          );
        })}
      </div>
    </>
  );
}

function startDownload(id: string) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.src = `/api/friends/download/${encodeURIComponent(id)}`;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), IFRAME_LIFETIME_MS);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}
