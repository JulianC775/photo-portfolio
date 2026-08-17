/**
 * A stand-in for the Pi: serves `.dev-media/` over HTTP so the site has a media host to read
 * from before the real one exists.
 *
 *   npm run dev:media     # terminal 1 — this server
 *   npm run dev           # terminal 2 — the site
 *
 * **Why a separate origin instead of just putting the files in `public/`.** In production the
 * media lives on `media.catellolens.com` and the app lives on Vercel — two origins, and the app
 * reaches the manifest over the network (docs/PLAN.md D3, invariant 6). Serving seed files from
 * the app's own `public/` folder would quietly collapse that into one origin, so the first thing
 * to break on the real setup would be something local development never exercised. A second
 * process on another port is a closer model, and it means `next build` works locally too — the
 * prerender of `/gallery` has a real host to fetch from.
 *
 * Deliberately minimal: no HTTPS, no range requests, no directory listings. It exists to unblock
 * M2 and is deleted from your workflow the moment the Pi is live.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd(), ".dev-media");
const PORT = Number(process.env.DEV_MEDIA_PORT ?? 4321);

/**
 * Mirrors the real cache policy from `src/lib/storage/index.ts`: media is immutable, manifests
 * are not. Kept in sync by hand — the point is that development behaves like production, not
 * that this file is authoritative.
 */
const CACHE_CONTROL = {
  immutable: "public, max-age=31536000, immutable",
  manifest: "public, max-age=60",
} as const;

const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json",
  ".mp4": "video/mp4",
};

const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end("method not allowed\n");
    return;
  }

  const pathname = decodeURIComponent(new URL(request.url ?? "/", `http://localhost:${PORT}`).pathname);
  const target = resolve(join(ROOT, pathname));

  // Path traversal guard. `..` in a URL would otherwise let a request walk out of .dev-media and
  // read anything the process can — harmless on a laptop, but not a habit worth forming.
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    response.writeHead(403).end("forbidden\n");
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");

    const extension = extname(target).toLowerCase();
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "content-length": info.size,
      // Everything under content/ is a mutable object at a stable key — the exact thing the
      // Cloudflare rule has to special-case in production (D3).
      "cache-control": pathname.startsWith("/content/") ? CACHE_CONTROL.manifest : CACHE_CONTROL.immutable,
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(target).pipe(response);
  } catch {
    // A 404 here is meaningful: it's how `getPublicManifest()` decides the manifest doesn't exist
    // yet and falls back to an empty gallery. Delete .dev-media/content/public.json to test that.
    response.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
  }
});

server.listen(PORT, () => {
  console.log(`dev media server → http://localhost:${PORT}  (serving ${ROOT})`);
  console.log("set NEXT_PUBLIC_MEDIA_URL to that URL in .env.local");
});
