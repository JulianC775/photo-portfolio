import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gallery",
  description:
    "Landscape and astrophotography, and timelapses of the night sky.",
};

// Placeholder so the nav has no dead link before M2. Replaced by the manifest-driven,
// category-filtered grid — see docs/PLAN.md M2 and D10.
export default function GalleryPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
      <h1 className="text-3xl font-light tracking-tight">Gallery</h1>
      <p className="mt-6 max-w-md text-base leading-relaxed text-muted">
        Nothing here yet — photographs arrive once storage is connected.
      </p>
    </div>
  );
}
