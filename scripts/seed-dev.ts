/**
 * Generates fake-but-faithful gallery content into `.dev-media/`, so M2 can be built and looked
 * at before the Pi exists.
 *
 *   npm run seed
 *
 * **Faithful in the ways that matter.** Real AVIF and WebP files at the real size ladder
 * (400/1200/2400w per docs/PLAN.md D4), real intrinsic dimensions, real base64 blur placeholders,
 * varied aspect ratios including a portrait and a panorama, and a manifest validated by the same
 * schema the site uses. That means `srcset`, `<picture>` format negotiation, layout stability and
 * the category filter all get exercised for real — the things that are annoying to discover are
 * broken later.
 *
 * **Fake in one way that matters.** These are procedural gradients, not photographs. Judgements
 * about how the grid *feels* — crop, spacing, whether the type competes with the images — have to
 * wait for real photos. Treat the layout as provisional until then.
 *
 * **No timelapses.** Generating a valid MP4 needs ffmpeg, and a video source pointing at a
 * missing key would just render as a broken player. The `timelapses` category is seeded as a
 * declared-but-empty category instead, which is worth having anyway: an empty category has to
 * render cleanly, and D10 explicitly allows one to exist before it has anything in it.
 *
 * Output is gitignored and disposable — delete `.dev-media/` and re-run any time. Nothing here
 * ships, and it must never be pointed at the real buckets: it only ever writes to local disk.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp, { type Sharp } from "sharp";

import { MANIFEST_KEYS, serializePublicManifest, type PublicManifestInput } from "../src/lib/content";
import type { Rendition } from "../src/lib/manifest";

const OUT = join(process.cwd(), ".dev-media");

/** The ladder from D4. A rendition is only generated if the source is at least that wide. */
const WIDTHS = [400, 1200, 2400];
const FORMATS = ["avif", "webp"] as const;

type Seed = {
  id: string;
  title: string;
  category: string;
  caption?: string;
  location?: string;
  takenAt: string;
  featured?: boolean;
  /** Source dimensions, chosen to give the grid a realistic mix to cope with. */
  width: number;
  height: number;
  /** Base hue, 0-360. Only affects what the placeholder looks like. */
  hue: number;
  /** Astro shots get a star field so the two categories are visually distinguishable. */
  stars?: boolean;
};

const CATEGORIES = [
  { slug: "astro", label: "Astro", order: 0 },
  { slug: "landscape", label: "Landscape", order: 1 },
  { slug: "timelapses", label: "Timelapses", order: 2 },
];

const SEEDS: Seed[] = [
  {
    id: "milky-way-over-sedona",
    title: "Milky Way over Sedona",
    category: "astro",
    caption: "Twenty-five stacked exposures, shot from the Cathedral Rock trailhead just after moonset.",
    location: "Sedona, Arizona",
    takenAt: "2026-05-14T04:12:00.000Z",
    featured: true,
    width: 2400,
    height: 1600,
    hue: 250,
    stars: true,
  },
  {
    id: "andromeda-rising",
    title: "Andromeda Rising",
    category: "astro",
    caption: "Two hours of integration on a night cold enough that the intervalometer gave up before I did.",
    location: "Cherry Springs, Pennsylvania",
    takenAt: "2026-02-08T02:40:00.000Z",
    width: 2400,
    height: 1600,
    hue: 215,
    stars: true,
  },
  {
    id: "core-over-the-pines",
    title: "Core over the Pines",
    category: "astro",
    location: "Big Bend, Texas",
    takenAt: "2026-06-02T03:55:00.000Z",
    width: 1600,
    height: 2400,
    hue: 280,
    stars: true,
  },
  {
    id: "orion-through-cloud",
    title: "Orion Through Cloud",
    category: "astro",
    caption: "Not the plan, but the cloud did something the clear sky wouldn't have.",
    takenAt: "2026-01-19T23:15:00.000Z",
    width: 2400,
    height: 1350,
    hue: 200,
    stars: true,
  },
  {
    id: "first-light-on-the-ridge",
    title: "First Light on the Ridge",
    category: "landscape",
    caption: "Twenty minutes of alpenglow, most of it spent changing lenses.",
    location: "Glacier National Park, Montana",
    takenAt: "2026-07-21T12:34:00.000Z",
    featured: true,
    width: 2400,
    height: 1600,
    hue: 25,
  },
  {
    id: "low-tide-long-exposure",
    title: "Low Tide, Long Exposure",
    category: "landscape",
    caption: "Thirty seconds at f/11. The tripod sank about an inch during the frame.",
    location: "Bandon, Oregon",
    takenAt: "2026-04-03T01:20:00.000Z",
    width: 2400,
    height: 1600,
    hue: 195,
  },
  {
    id: "switchbacks",
    title: "Switchbacks",
    category: "landscape",
    location: "Dolomites, Italy",
    takenAt: "2025-09-11T16:05:00.000Z",
    width: 1600,
    height: 2400,
    hue: 150,
  },
  {
    id: "valley-panorama",
    title: "Valley Panorama",
    caption: "Seven frames stitched. The seam is in the left third if you go looking for it.",
    category: "landscape",
    location: "Yosemite, California",
    takenAt: "2025-10-28T15:45:00.000Z",
    width: 2400,
    height: 900,
    hue: 40,
  },
  {
    id: "granite-and-fog",
    title: "Granite and Fog",
    category: "landscape",
    takenAt: "2025-11-30T14:10:00.000Z",
    width: 2000,
    height: 1500,
    hue: 210,
  },
  {
    id: "the-last-of-the-light",
    title: "The Last of the Light",
    category: "landscape",
    caption: "Handheld at 1/15s, which is why this is the only frame of six that's sharp.",
    location: "Big Sur, California",
    takenAt: "2026-03-17T02:05:00.000Z",
    width: 2400,
    height: 1600,
    hue: 15,
  },
];

async function main() {
  // Start clean so a re-run can't leave stale renditions behind that the manifest doesn't list.
  await rm(OUT, { recursive: true, force: true });

  const items: PublicManifestInput["items"] = [];

  for (const seed of SEEDS) {
    process.stdout.write(`  ${seed.id} `);
    const source = sourceImage(seed);

    const renditions: Rendition[] = [];
    for (const width of WIDTHS) {
      if (width > seed.width) continue;
      const height = Math.round((width / seed.width) * seed.height);
      for (const format of FORMATS) {
        const key = `photos/${seed.id}/${width}.${format}`;
        const buffer = await source
          .clone()
          .resize(width, height)
          .toFormat(format, { quality: format === "avif" ? 50 : 78 })
          .toBuffer();
        await write(key, buffer);
        renditions.push({ key, format, width, height, bytes: buffer.length });
        process.stdout.write(".");
      }
    }

    items.push({
      kind: "photo",
      id: seed.id,
      title: seed.title,
      category: seed.category,
      caption: seed.caption,
      location: seed.location,
      takenAt: seed.takenAt,
      featured: seed.featured ?? false,
      // Staggered so "newest first" ordering is visibly doing something.
      addedAt: new Date(Date.parse(seed.takenAt) + 86_400_000).toISOString(),
      width: seed.width,
      height: seed.height,
      renditions,
      blurDataUrl: await blurPlaceholder(source, seed),
      sourceFilename: `${seed.id.toUpperCase().replace(/-/g, "_")}.ARW`,
    });
    process.stdout.write(" ok\n");
  }

  // Through content.ts, so the fixture is validated by the same schema the site reads with and
  // formatted byte-identically to a real manifest.
  const body = serializePublicManifest({ version: 1, categories: CATEGORIES, items });
  await write(MANIFEST_KEYS.public, body);

  const files = items.reduce((total, item) => total + ("renditions" in item ? item.renditions.length : 0), 0);
  console.log(`\nSeeded ${items.length} photos (${files} image files) into .dev-media/`);
  console.log("Next: npm run dev:media  (one terminal)  +  npm run dev  (another)");
}

/**
 * A procedural stand-in for a photograph: a diagonal two-tone gradient, a soft vignette, and
 * optionally a star field. Built as a raw pixel buffer because sharp has no gradient primitive,
 * and a solid colour makes it impossible to tell whether the right rendition is being served.
 */
function sourceImage(seed: Seed) {
  const { width, height, hue } = seed;
  const pixels = Buffer.allocUnsafe(width * height * 3);

  const top = hsl(hue, 0.45, 0.28);
  const bottom = hsl((hue + 35) % 360, 0.5, 0.06);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Diagonal so a wrongly-rotated or squashed rendition is obvious at a glance.
      const t = (y / height) * 0.8 + (x / width) * 0.2;
      const dx = x / width - 0.5;
      const dy = y / height - 0.5;
      const vignette = 1 - Math.min(1, (dx * dx + dy * dy) * 1.1);

      const offset = (y * width + x) * 3;
      pixels[offset] = clamp((top[0] + (bottom[0] - top[0]) * t) * vignette);
      pixels[offset + 1] = clamp((top[1] + (bottom[1] - top[1]) * t) * vignette);
      pixels[offset + 2] = clamp((top[2] + (bottom[2] - top[2]) * t) * vignette);
    }
  }

  if (seed.stars) {
    // Deterministic so re-seeding doesn't churn every file — the same seed gives the same stars.
    let state = hashOf(seed.id);
    const count = Math.round((width * height) / 2600);
    for (let i = 0; i < count; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const x = state % width;
      state = (state * 1664525 + 1013904223) >>> 0;
      const y = state % height;
      state = (state * 1664525 + 1013904223) >>> 0;
      const brightness = 120 + (state % 136);

      const offset = (y * width + x) * 3;
      pixels[offset] = clamp(brightness);
      pixels[offset + 1] = clamp(brightness);
      pixels[offset + 2] = clamp(brightness * 0.98);
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

/** ~20px wide WebP as a data URI — the LQIP from D4 step 4. */
async function blurPlaceholder(source: Sharp, seed: Seed): Promise<string> {
  const width = 20;
  const height = Math.max(1, Math.round((width / seed.width) * seed.height));
  const buffer = await source.clone().resize(width, height).webp({ quality: 40 }).toBuffer();
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}

async function write(key: string, body: Buffer | string) {
  const target = join(OUT, key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

/** Minimal HSL→RGB. Only used to give each placeholder a distinct colour. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
