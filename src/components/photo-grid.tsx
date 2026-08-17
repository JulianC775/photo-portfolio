/**
 * The gallery grid.
 *
 * A plain CSS columns masonry rather than a JS layout: at ~40 photos there is nothing to
 * virtualise, and `columns` handles mixed portrait/landscape/panorama without measuring anything or
 * shipping a byte of JavaScript. The trade is reading order — `columns` fills top-to-bottom per
 * column, so items read down rather than across. For a gallery with no inherent sequence that's
 * acceptable; if ordering ever becomes meaningful, this is the component to reconsider.
 *
 * A Server Component: no state, no effects, nothing interactive. The links navigate.
 */
import Link from "next/link";

import type { PublicItem } from "@/lib/manifest";
import { formatTakenAt } from "@/lib/media";
import { PhotoImage } from "./photo-image";

/**
 * Matches the `columns-*` classes below. `sizes` has to describe the *rendered* width, so it has
 * to be kept in step with the column count by hand — there is no way to derive one from the other
 * in CSS. Three columns at the widest breakpoint, inside a max-w-7xl container.
 */
const GRID_SIZES = "(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 100vw";

/** How many images load eagerly — roughly the first screenful. */
const EAGER_COUNT = 3;

export function PhotoGrid({ items }: { items: PublicItem[] }) {
  if (items.length === 0) {
    return (
      <p className="py-16 text-base leading-relaxed text-muted">
        Nothing in this category yet.
      </p>
    );
  }

  return (
    <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
      {items.map((item, index) => (
        <GridItem key={item.id} item={item} priority={index < EAGER_COUNT} />
      ))}
    </div>
  );
}

function GridItem({ item, priority }: { item: PublicItem; priority: boolean }) {
  // A timelapse shows its poster frame here and behaves exactly like a photo; only the detail
  // page cares that it is a video. `poster` and `renditions` are both rendition lists, which is
  // why this reads as one line rather than a branch on kind.
  const renditions = item.kind === "photo" ? item.renditions : item.poster;
  const takenAt = formatTakenAt(item.takenAt);

  return (
    <Link
      href={`/gallery/${item.id}`}
      // `break-inside-avoid` stops a column break landing mid-image, which CSS columns will
      // otherwise happily do.
      className="group mb-4 block break-inside-avoid"
    >
      <figure className="relative overflow-hidden bg-surface">
        <PhotoImage
          renditions={renditions}
          alt={item.title}
          width={item.width}
          height={item.height}
          blurDataUrl={item.blurDataUrl}
          sizes={GRID_SIZES}
          priority={priority}
          className="w-full transition-opacity duration-300 group-hover:opacity-85"
        />

        {item.kind === "timelapse" && (
          <span className="absolute top-3 left-3 bg-ink/70 px-2 py-1 text-[0.65rem] tracking-widest text-paper uppercase">
            Timelapse
          </span>
        )}

        {/*
          Caption over the image on hover, and always visible to screen readers. Deliberately
          restrained — the design direction is that chrome stays out of the way of the photograph.
        */}
        <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/85 to-transparent p-4 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="text-sm text-paper">{item.title}</span>
          {takenAt && <span className="mt-0.5 block text-xs text-muted">{takenAt}</span>}
        </figcaption>
      </figure>
    </Link>
  );
}
