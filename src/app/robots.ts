import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

/**
 * Present from the first deploy so /friends is never crawlable at any point in the build,
 * not just once M3 lands. The per-page `robots` metadata is the real guarantee; this is
 * defence in depth for crawlers that honour robots.txt but arrive before a page renders.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/friends" },
    sitemap: `${site.url}/sitemap.xml`,
  };
}
