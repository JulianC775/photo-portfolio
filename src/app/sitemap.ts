import type { MetadataRoute } from "next";

import { getPublicManifest } from "@/lib/content";
import { site } from "@/lib/site";

/**
 * Public routes only. `/friends` is deliberately absent and must stay absent (invariant 4) — the
 * per-photo routes below come from the *public* manifest, which by construction never contains
 * friends-only media, so there is no path by which a private photo reaches this file.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const manifest = await getPublicManifest();

  const pages = ["", "/gallery", "/about"].map((path) => ({
    url: `${site.url}${path}`,
    lastModified: new Date(manifest.updatedAt),
  }));

  const items = manifest.items.map((item) => ({
    url: `${site.url}/gallery/${item.id}`,
    // The item's own date, so re-crawls are driven by real changes rather than by deploy time.
    lastModified: new Date(item.addedAt),
  }));

  return [...pages, ...items];
}
