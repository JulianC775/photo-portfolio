/**
 * Single source of truth for site-level chrome: wordmark, nav, canonical URL.
 *
 * Nothing here is content — photos, categories and events all come from the manifests
 * (see docs/PLAN.md D2 and D10). This file is only for things that genuinely never change
 * without a deploy.
 */
export const site = {
  /** Wordmark shown in the nav. */
  name: "Catello Lens",

  /**
   * Canonical origin, used for metadataBase, OG image URLs and the sitemap.
   * Vercel sets NEXT_PUBLIC_SITE_URL per environment so preview deploys don't
   * advertise production URLs.
   */
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://catellolens.com",

  title: "Catello Lens",
  tagline: "Landscape, astro and timelapse photography",
  description:
    "A small, curated collection of landscape and astrophotography — and timelapses of the night sky.",

  /** Main navigation. Deliberately does not include the friends section. */
  nav: [
    { href: "/gallery", label: "Gallery" },
    { href: "/about", label: "About" },
  ],

  /**
   * The friends section is reachable only from this footer link — never the main nav.
   * See docs/PLAN.md, requirements: it should not feel like a feature of the portfolio.
   */
  friends: { href: "/friends", label: "Friends — get your photos here" },
} as const;
