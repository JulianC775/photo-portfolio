import Link from "next/link";
import { site } from "@/lib/site";

/**
 * The friends-section entry point lives here and nowhere else — see site.ts for why.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <p>
          &copy; {new Date().getFullYear()} {site.name}
        </p>

        <Link
          href={site.friends.href}
          className="transition-colors hover:text-paper"
        >
          {site.friends.label}
        </Link>
      </div>
    </footer>
  );
}
