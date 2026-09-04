/**
 * One responsive image, served straight from the media domain (docs/PLAN.md D8).
 *
 * Three things earn their place here and are easy to lose in a refactor:
 *
 * - **`width`/`height` are always set** from the manifest's intrinsic dimensions, so the browser
 *   reserves the right box before any byte arrives. Without them a photo-heavy grid reflows as it
 *   loads, which is both ugly and the main source of a bad CLS score.
 * - **The blur placeholder is a CSS background**, not a second `<img>`. It paints immediately (it's
 *   ~200 bytes of base64 already in the HTML) and the real image covers it as it decodes, so there
 *   is no swap flash and no extra request.
 * - **`sizes` is a required prop**, not defaulted. It has no correct default: it depends entirely
 *   on how wide this image renders in its layout, and getting it wrong silently downloads a 2400px
 *   file into a 300px slot. Making callers state it keeps that decision visible.
 */
import type { Rendition } from "@/lib/manifest";
import { fallbackRendition, imageSources, renditionUrl } from "@/lib/media";

type Props = {
  renditions: Rendition[];
  alt: string;
  /** Intrinsic dimensions of the original, for aspect ratio and layout reservation. */
  width: number;
  height: number;
  /** Base64 LQIP from the manifest. Absent is fine — the box just stays empty. */
  blurDataUrl?: string;
  /** e.g. "(min-width: 768px) 33vw, 100vw". See the note above; there is no sane default. */
  sizes: string;
  className?: string;
  /**
   * Set on the hero and the first row of the grid only. Everything else stays lazy — eagerly
   * loading a full gallery would compete with the image the visitor is actually looking at.
   */
  priority?: boolean;
  /**
   * Overrides how a rendition's URL is built. Defaults to the public bucket's plain URL; the
   * friends section passes a lookup into pre-signed URLs instead, since those previews live in
   * the private bucket (no anonymous read).
   */
  urlFor?: (rendition: Rendition) => string;
};

export function PhotoImage({
  renditions,
  alt,
  width,
  height,
  blurDataUrl,
  sizes,
  className,
  priority = false,
  urlFor = renditionUrl,
}: Props) {
  const sources = imageSources(renditions, urlFor);
  const fallback = fallbackRendition(renditions);

  return (
    <picture>
      {sources.map((source) => (
        <source key={source.format} type={source.type} srcSet={source.srcSet} sizes={sizes} />
      ))}
      <img
        src={urlFor(fallback)}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        loading={priority ? "eager" : "lazy"}
        // fetchPriority is what actually moves the needle on LCP; `loading="eager"` only stops it
        // being deferred, it doesn't move it up the queue.
        fetchPriority={priority ? "high" : "auto"}
        decoding={priority ? "sync" : "async"}
        className={className}
        style={
          blurDataUrl
            ? {
                backgroundImage: `url("${blurDataUrl}")`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      />
    </picture>
  );
}
