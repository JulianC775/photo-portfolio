/**
 * Turns the manifest's rendition list into the attributes an `<img>`/`<picture>` needs.
 *
 * **Why not `next/image`.** The upload CLI pre-generates every size and format, so there is
 * nothing left for an optimiser to do. Running images through Vercel would add a transformation
 * quota, bandwidth and a function to the request path for zero benefit, and invariant 6 says the
 * bytes never touch Vercel at all (docs/PLAN.md D8). Plain `<picture>` served straight from the
 * media domain is both faster and simpler.
 *
 * Nothing here knows what sizes or formats exist — it groups whatever the manifest lists, so the
 * CLI can add a 3600w tier or swap AVIF for something newer without a code change.
 */
import type { Rendition } from "./manifest";
import { publicMediaUrl } from "./storage";

/**
 * Preference order for `<source>` elements: best compression first, and the browser takes the
 * first type it understands. Formats not listed here still render — they just sort last, so an
 * unknown format degrades to "usable" rather than "invisible".
 */
const FORMAT_PREFERENCE = ["avif", "webp", "jpeg", "png"];

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
};

export type ImageSource = {
  format: string;
  /** `image/avif` etc. — goes straight into `<source type>`. */
  type: string;
  /** `https://media…/400.avif 400w, https://media…/1200.avif 1200w` */
  srcSet: string;
};

/**
 * One `<source>` worth of data per format, in preference order.
 *
 * Sorting inside each format by width matters less than it looks — `srcset` is a set, not a list —
 * but it keeps the generated HTML readable when debugging which rendition a browser picked.
 */
export function imageSources(renditions: Rendition[]): ImageSource[] {
  const byFormat = new Map<string, Rendition[]>();
  for (const rendition of renditions) {
    const group = byFormat.get(rendition.format);
    if (group) group.push(rendition);
    else byFormat.set(rendition.format, [rendition]);
  }

  return [...byFormat.entries()]
    .sort(([a], [b]) => preferenceOf(a) - preferenceOf(b))
    .map(([format, group]) => ({
      format,
      type: MIME_TYPES[format] ?? `image/${format}`,
      srcSet: [...group]
        .sort((a, b) => a.width - b.width)
        .map((rendition) => `${publicMediaUrl(rendition.key)} ${rendition.width}w`)
        .join(", "),
    }));
}

/**
 * The `<img>` fallback inside a `<picture>`: the most widely supported format available, at its
 * largest size. Every browser that reaches this line can decode *something*, and browsers that
 * understood one of the `<source>` types never request it.
 */
export function fallbackRendition(renditions: Rendition[]): Rendition {
  const widest = (group: Rendition[]) =>
    group.reduce((best, rendition) => (rendition.width > best.width ? rendition : best));

  // Reverse preference: JPEG/PNG are the safe fallbacks, AVIF is the least safe.
  const safest = [...renditions].sort((a, b) => preferenceOf(b.format) - preferenceOf(a.format));
  const safestFormat = safest[0].format;
  return widest(renditions.filter((rendition) => rendition.format === safestFormat));
}

/** Takes anything with a key — renditions and video sources both qualify. */
export function renditionUrl(object: { key: string }): string {
  return publicMediaUrl(object.key);
}

/** Largest rendition of any format — used for OG images, where one absolute URL is all that fits. */
export function largestRendition(renditions: Rendition[]): Rendition {
  return renditions.reduce((best, rendition) => (rendition.width > best.width ? rendition : best));
}

function preferenceOf(format: string): number {
  const index = FORMAT_PREFERENCE.indexOf(format);
  return index === -1 ? FORMAT_PREFERENCE.length : index;
}

/**
 * Human-readable shooting date. Explicit UTC because the manifest stores instants and the server
 * and browser must agree — without it, a date can render differently on each and hydration warns.
 */
export function formatTakenAt(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
