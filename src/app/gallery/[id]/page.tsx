/**
 * Detail view for one photo or timelapse.
 *
 * **This is a page, not an overlay lightbox.** The plan lists "detail view / lightbox" together;
 * building it as a real route means every photo has a shareable URL, its own OG image, and a place
 * in the sitemap — none of which an overlay gets — and it needs no client JavaScript. The overlay
 * treatment with keyboard navigation is already scheduled as an M5 item and can be layered on top
 * of these routes later without changing them.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PhotoImage } from "@/components/photo-image";
import { findItem, getPublicManifest, listCategories, listItems } from "@/lib/content";
import type { PublicItem } from "@/lib/manifest";
import { formatTakenAt, largestRendition, renditionUrl } from "@/lib/media";

type Props = { params: Promise<{ id: string }> };

/**
 * Pre-renders every item at build time and revalidates with the manifest's tag, so a detail page
 * is a static file. New photos still work without a deploy — `dynamicParams` defaults to true, so
 * an id that wasn't in the manifest at build time renders on demand and is cached from then on.
 */
export async function generateStaticParams() {
  const manifest = await getPublicManifest();
  return manifest.items.map((item) => ({ id: item.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const item = findItem(await getPublicManifest(), id);
  if (!item) return {};

  // One absolute URL on the media domain — no OG image generation, nothing for Vercel to render.
  const og = largestRendition(item.kind === "photo" ? item.renditions : item.poster);
  const description =
    item.caption ?? [item.location, formatTakenAt(item.takenAt)].filter(Boolean).join(" · ");

  return {
    title: item.title,
    description: description || undefined,
    openGraph: {
      type: "article",
      title: item.title,
      description: description || undefined,
      images: [{ url: renditionUrl(og), width: og.width, height: og.height, alt: item.title }],
    },
    twitter: { card: "summary_large_image" },
  };
}

export default async function ItemPage({ params }: Props) {
  const { id } = await params;
  const manifest = await getPublicManifest();
  const item = findItem(manifest, id);
  if (!item) notFound();

  const category = listCategories(manifest).find((c) => c.slug === item.category);
  const takenAt = formatTakenAt(item.takenAt);
  const siblings = listItems(manifest, { category: item.category });
  const index = siblings.findIndex((sibling) => sibling.id === item.id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;

  return (
    <article className="mx-auto max-w-7xl px-6 py-10 sm:py-16">
      <Media item={item} />

      <div className="mt-8 flex flex-col gap-8 sm:flex-row sm:justify-between">
        <header className="max-w-xl">
          <h1 className="text-2xl font-light tracking-tight">{item.title}</h1>
          {item.caption && (
            <p className="mt-4 text-base leading-relaxed text-muted">{item.caption}</p>
          )}
        </header>

        <dl className="shrink-0 space-y-2 text-sm sm:text-right">
          {category && (
            <div>
              <dt className="sr-only">Category</dt>
              <dd>
                <Link
                  href={`/gallery?category=${encodeURIComponent(category.slug)}`}
                  className="border-b border-line pb-0.5 text-paper transition-colors hover:border-paper"
                >
                  {category.label}
                </Link>
              </dd>
            </div>
          )}
          {/*
            Location is a place name only. Public images have their GPS EXIF stripped
            (invariant 2) and the manifest deliberately has nowhere to put coordinates.
          */}
          {item.location && (
            <div>
              <dt className="sr-only">Location</dt>
              <dd className="text-muted">{item.location}</dd>
            </div>
          )}
          {takenAt && (
            <div>
              <dt className="sr-only">Date taken</dt>
              <dd className="text-muted">
                <time dateTime={item.takenAt}>{takenAt}</time>
              </dd>
            </div>
          )}
        </dl>
      </div>

      <nav className="mt-16 flex items-baseline justify-between border-t border-line pt-6 text-sm">
        {previous ? (
          <Link href={`/gallery/${previous.id}`} className="text-muted transition-colors hover:text-paper">
            ← {previous.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            href={`/gallery/${next.id}`}
            className="text-right text-muted transition-colors hover:text-paper"
          >
            {next.title} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </article>
  );
}

function Media({ item }: { item: PublicItem }) {
  if (item.kind === "timelapse") {
    const poster = largestRendition(item.poster);
    return (
      // `controls` and nothing else: a real player with keyboard handling is M5. Native controls
      // work everywhere today, including the range requests that make seeking possible (D7).
      <video
        controls
        preload="metadata"
        poster={renditionUrl(poster)}
        width={item.width}
        height={item.height}
        className="mx-auto max-h-[82svh] w-auto bg-surface"
      >
        {item.sources.map((source) => (
          <source key={source.key} src={renditionUrl(source)} type={source.contentType} />
        ))}
      </video>
    );
  }

  return (
    <PhotoImage
      renditions={item.renditions}
      alt={item.title}
      width={item.width}
      height={item.height}
      blurDataUrl={item.blurDataUrl}
      // The detail image is the reason the visitor is here: it's the LCP element, so it loads
      // eagerly at high priority. It renders at most one viewport wide.
      sizes="(min-width: 1280px) 1280px, 100vw"
      priority
      className="mx-auto max-h-[82svh] w-auto object-contain"
    />
  );
}
