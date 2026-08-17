import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/lib/site";
import "./globals.css";

// next/font self-hosts the font files at build time, so there is no runtime request to
// Google and no layout shift from a late-arriving webface.
const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: `${site.title} — ${site.tagline}`, template: `%s — ${site.title}` },
  description: site.description,
  openGraph: {
    type: "website",
    siteName: site.title,
    title: `${site.title} — ${site.tagline}`,
    description: site.description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="flex min-h-dvh flex-col antialiased">
        <SiteNav />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
