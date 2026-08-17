import Link from "next/link";
import { site } from "@/lib/site";

/**
 * Thin, translucent top bar. Sticky so navigation is always reachable while scrolling a
 * long gallery, but low-contrast enough to stay out of the way of the images behind it.
 */
export function SiteNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-ink/70 backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="text-[0.8rem] uppercase tracking-[0.2em] text-paper transition-opacity hover:opacity-70"
        >
          {site.name}
        </Link>

        <ul className="flex items-center gap-8">
          {site.nav.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="text-sm text-muted transition-colors hover:text-paper"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
