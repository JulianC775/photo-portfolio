import Link from "next/link";
import { site } from "@/lib/site";

export default function HomePage() {
  return (
    <>
      {/*
        M2 replaces this block with the featured photo or timelapse loaded from the public
        manifest. The gradient is a stand-in so the layout, type scale and spacing can be
        judged before any media exists — it is not a design element to keep.
      */}
      <section className="relative flex h-[82svh] min-h-[30rem] items-end overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 bg-[radial-gradient(120%_90%_at_70%_10%,#1b2233_0%,#0f1117_45%,#09090b_100%)]"
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-ink to-transparent"
        />

        <div className="relative mx-auto w-full max-w-6xl px-6 pb-16">
          <h1 className="max-w-2xl text-4xl leading-tight font-light tracking-tight text-balance sm:text-5xl">
            {site.tagline}
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted">
            {site.description}
          </p>
          <Link
            href="/gallery"
            className="mt-8 inline-block border-b border-line pb-1 text-sm tracking-wide text-paper transition-colors hover:border-paper"
          >
            View the gallery
          </Link>
        </div>
      </section>
    </>
  );
}
