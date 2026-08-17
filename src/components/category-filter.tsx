/**
 * The category filter.
 *
 * **Links, not client-side state.** The plan anticipated this being a Client Component, and it
 * doesn't need to be: rendering the filter as `<Link href="/gallery?category=astro">` makes each
 * filtered view a real URL that can be linked, bookmarked and indexed, ships no JavaScript, and
 * keeps the page a Server Component. Next's client-side navigation makes it feel identical to
 * local state. If a future filter needs to combine several axes at once without a round trip,
 * revisit — but a single-select filter over ~40 photos does not.
 *
 * Every label comes from the manifest (docs/PLAN.md D10, invariant 8). There are no category names
 * in this file, and adding a category needs no deploy.
 */
import Link from "next/link";

import type { Category } from "@/lib/manifest";

type Props = {
  categories: Category[];
  /** The slug currently filtered on, or undefined for "All". */
  active?: string;
  /** Per-category item counts, so an empty category can be shown as empty rather than hidden. */
  counts: Map<string, number>;
  total: number;
};

export function CategoryFilter({ categories, active, counts, total }: Props) {
  return (
    <nav aria-label="Filter by category" className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
      <FilterLink href="/gallery" label="All" count={total} isActive={active === undefined} />
      {categories.map((category) => (
        <FilterLink
          key={category.slug}
          href={`/gallery?category=${encodeURIComponent(category.slug)}`}
          label={category.label}
          count={counts.get(category.slug) ?? 0}
          isActive={active === category.slug}
        />
      ))}
    </nav>
  );
}

function FilterLink({
  href,
  label,
  count,
  isActive,
}: {
  href: string;
  label: string;
  count: number;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      // aria-current is the accessible signal; the border is the visual one. Both, not either.
      aria-current={isActive ? "page" : undefined}
      className={`border-b pb-1 text-sm tracking-wide transition-colors ${
        isActive
          ? "border-paper text-paper"
          : "border-transparent text-muted hover:border-line hover:text-paper"
      }`}
    >
      {label}
      <span className="ml-1.5 text-xs text-muted tabular-nums">{count}</span>
    </Link>
  );
}
