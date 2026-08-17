/**
 * `POST /api/revalidate` — how a new photo shows up in seconds instead of after the TTL.
 *
 * The public manifest is fetched with `next: { revalidate: 300, tags: ['content'] }`, so without
 * this the site would be up to five minutes stale after an upload. The upload CLI calls this as
 * its final step (docs/PLAN.md D2) and the tag is dropped immediately.
 *
 * Guarded by a shared secret rather than a login: the only caller is a script on the owner's
 * machine, and the blast radius of a leaked secret is "someone can make the site re-read its own
 * manifest".
 *
 *   curl -X POST https://catellolens.com/api/revalidate \
 *     -H "authorization: Bearer $REVALIDATE_SECRET"
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

import { CONTENT_TAG } from "@/lib/content";

export async function POST(request: Request) {
  const expected = process.env.REVALIDATE_SECRET;
  if (!expected) {
    // Unset means the deploy predates storage config. Say so plainly — the CLI's final step
    // failing with a 503 is much easier to diagnose than a silent no-op.
    return Response.json({ error: "REVALIDATE_SECRET is not configured" }, { status: 503 });
  }

  if (!matches(bearerToken(request), expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Next 16 requires a cacheLife profile here, and the choice is a real one. The recommended
  // `"max"` marks the tag stale and serves stale-while-revalidating — so the first person to
  // load the gallery after an upload (usually the owner, checking) still sees the old one.
  // `{ expire: 0 }` expires immediately instead: that visitor pays one small JSON fetch and
  // sees the new photo. At this traffic level the blocking revalidate costs nothing, and it is
  // what "uploads appear within seconds" is supposed to mean.
  revalidateTag(CONTENT_TAG, { expire: 0 });
  return Response.json({ revalidated: CONTENT_TAG, at: new Date().toISOString() });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  return scheme.toLowerCase() === "bearer" ? rest.join(" ").trim() : null;
}

/**
 * Constant-time compare. `timingSafeEqual` throws on length mismatch, which would itself leak
 * the length, so both sides are hashed to a fixed width first — cheap and removes the branch.
 */
function matches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const encoder = new TextEncoder();
  const a = sha256(encoder.encode(provided));
  const b = sha256(encoder.encode(expected));
  return timingSafeEqual(a, b);
}

function sha256(input: Uint8Array): Buffer {
  return createHash("sha256").update(input).digest();
}
