/**
 * The gallery: filterable grid, driven entirely by the manifest.
 *
 * One manifest read per render, passed to the view helpers — see the note on
 * `src/lib/content.ts` about reading once and deriving from that snapshot.
 */
import type { Metadata } from "next";

import { CategoryFilter } from "@/components/category-filter";
import { PhotoGrid } from "@/components/photo-grid";
import { getPublicManifest, listCategories, listItems } from "@/lib/content";

export const metadata: Metadata = {
  title: "Gallery",
  description: "Landscape and astrophotography, and timelapses of the night sky.",
};

// `searchParams` is a Promise in Next 15+; the filter arrives as a query string so each filtered
// view is its own URL (see category-filter.tsx).
type Props = { searchParams: Promise<{ category?: string }> };

export default async function GalleryPage({ searchParams }: Props) {
  const [{ category }, manifest] = await Promise.all([searchParams, getPublicManifest()]);

  const categories = listCategories(manifest);
  // An unrecognised ?category= is treated as no filter rather than an error: a stale bookmark or a
  // category that was renamed should show the whole gallery, not a 404.
  const active = categories.some((c) => c.slug === category) ? category : undefined;
  const items = listItems(manifest, { category: active });

  const counts = new Map<string, number>();
  for (const item of manifest.items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
      <header className="mb-10">
        <h1 className="text-3xl font-light tracking-tight">Gallery</h1>
        {categories.length > 0 && (
          <div className="mt-8">
            <CategoryFilter
              categories={categories}
              active={active}
              counts={counts}
              total={manifest.items.length}
            />
          </div>
        )}
      </header>

      {manifest.items.length === 0 ? (
        // The empty-manifest path is a real state, not an error: the site is deployed before any
        // photo is uploaded (docs/PLAN.md Part 5).
        <p className="max-w-md text-base leading-relaxed text-muted">
          Nothing here yet — photographs arrive once storage is connected.
        </p>
      ) : (
        <PhotoGrid items={items} />
      )}
    </div>
  );
}
