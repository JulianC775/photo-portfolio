import Link from "next/link";

import { PhotoImage } from "@/components/photo-image";
import { getPublicManifest, listFeatured } from "@/lib/content";
import { site } from "@/lib/site";
import { largestRendition, renditionUrl } from "@/lib/media";

export default async function HomePage() {
  const manifest = await getPublicManifest();
  // Newest featured item wins. Nothing flagged featured — or nothing uploaded at all — falls back
  // to the gradient, so the page never depends on content existing.
  const hero = listFeatured(manifest)[0];

  return (
    <section className="relative flex h-[82svh] min-h-[30rem] items-end overflow-hidden">
      {hero ? (
        <HeroMedia item={hero} />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(120%_90%_at_70%_10%,#1b2233_0%,#0f1117_45%,#09090b_100%)]"
        />
      )}

      {/* Scrim: the type has to stay readable over an unknown photograph. */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-ink via-ink/70 to-transparent"
      />

      <div className="relative mx-auto w-full max-w-6xl px-6 pb-16">
        <h1 className="max-w-2xl text-4xl leading-tight font-light tracking-tight text-balance sm:text-5xl">
          {site.tagline}
        </h1>
        <p className="mt-5 max-w-md text-base leading-relaxed text-muted">{site.description}</p>

        <div className="mt-8 flex flex-wrap items-baseline gap-x-8 gap-y-3 text-sm tracking-wide">
          <Link
            href="/gallery"
            className="border-b border-line pb-1 text-paper transition-colors hover:border-paper"
          >
            View the gallery
          </Link>
          {hero && (
            <Link
              href={`/gallery/${hero.id}`}
              className="border-b border-transparent pb-1 text-muted transition-colors hover:border-line hover:text-paper"
            >
              Above: {hero.title}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function HeroMedia({ item }: { item: NonNullable<ReturnType<typeof listFeatured>[number]> }) {
  if (item.kind === "timelapse") {
    // Muted, looping, no controls — it's a backdrop, not a player. `playsInline` is what stops iOS
    // taking it fullscreen, and autoplay is only permitted at all because it's muted.
    return (
      <video
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        poster={renditionUrl(largestRendition(item.poster))}
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover"
      >
        {item.sources.map((source) => (
          <source key={source.key} src={renditionUrl(source)} type={source.contentType} />
        ))}
      </video>
    );
  }

  return (
    <div className="absolute inset-0">
      <PhotoImage
        renditions={item.renditions}
        alt={item.title}
        width={item.width}
        height={item.height}
        blurDataUrl={item.blurDataUrl}
        // Full-bleed at every breakpoint, and it is the LCP element on the landing page.
        sizes="100vw"
        priority
        className="h-full w-full object-cover"
      />
    </div>
  );
}
