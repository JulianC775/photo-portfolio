import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description:
    "About the photographer — landscape, astrophotography and night-sky timelapses.",
};

// TODO(owner): replace the placeholder bio and links below with real copy.
const links = [
  { label: "Email", href: "mailto:hello@catellolens.com" },
  { label: "Instagram", href: "#" },
  { label: "GitHub", href: "https://github.com/JulianC775" },
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 sm:py-32">
      <h1 className="text-3xl font-light tracking-tight">About</h1>

      <div className="mt-10 space-y-6 text-base leading-relaxed text-muted">
        <p>
          Placeholder bio. A few sentences on who you are, where you shoot, and what pulls
          you outside at 2am — enough to give the photographs context without competing
          with them.
        </p>
        <p>
          Placeholder second paragraph. What you shoot: landscapes, astrophotography, and
          timelapses of the night sky. Gear, process, or the reason you started, if any of
          that is worth saying.
        </p>
      </div>

      <ul className="mt-12 flex flex-wrap gap-x-8 gap-y-3 text-sm">
        {links.map((link) => (
          <li key={link.label}>
            <a
              href={link.href}
              className="border-b border-line pb-0.5 text-paper transition-colors hover:border-paper"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
