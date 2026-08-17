import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

/**
 * Public routes only. /friends is deliberately absent and must stay absent — when M2 adds
 * per-photo detail routes they come from the public manifest, which by construction never
 * contains friends-only media.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/gallery", "/about"].map((path) => ({
    url: `${site.url}${path}`,
    lastModified: new Date(),
  }));
}
