/**
 * Tests for the public manifest read path, with `fetch` stubbed.
 *
 * The two behaviours worth pinning down are the ones a page depends on but nobody would notice
 * breaking until it mattered: a *missing* manifest must degrade to an empty gallery (so the site
 * works before the first upload), and a *broken* one must throw rather than quietly serve half a
 * gallery (docs/PLAN.md D2).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getPublicManifest, MANIFEST_KEYS } from "./content";

const originalFetch = globalThis.fetch;

/** Replaces `fetch` with one that always answers the same way, and records the URL it was given. */
function stubFetch(body: string, init: ResponseInit = { status: 200 }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(body, init);
  }) as typeof fetch;
  return calls;
}

describe("getPublicManifest", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test/portfolio-public";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads the manifest from the media domain, not from Vercel (invariant 6)", async () => {
    const calls = stubFetch(
      JSON.stringify({ version: 1, updatedAt: "2026-08-01T12:00:00.000Z", categories: [], items: [] }),
    );
    await getPublicManifest();
    assert.deepEqual(calls, [`https://media.example.test/portfolio-public/${MANIFEST_KEYS.public}`]);
  });

  it("returns an empty manifest when the object doesn't exist yet", async () => {
    stubFetch("<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const manifest = await getPublicManifest();
    assert.deepEqual(manifest.items, []);
    assert.deepEqual(manifest.categories, []);
  });

  it("throws on malformed JSON instead of serving nothing quietly", async () => {
    stubFetch("{ not json");
    await assert.rejects(getPublicManifest(), /not valid JSON/);
  });

  it("throws with the offending field path when the manifest fails validation", async () => {
    stubFetch(
      JSON.stringify({
        version: 1,
        updatedAt: "2026-08-01T12:00:00.000Z",
        categories: [],
        items: [
          {
            kind: "photo",
            id: "orphan",
            title: "Orphan",
            category: "astro",
            addedAt: "2026-08-01T12:00:00.000Z",
            width: 100,
            height: 100,
            renditions: [{ key: "a.avif", format: "avif", width: 100, height: 100 }],
          },
        ],
      }),
    );
    await assert.rejects(getPublicManifest(), /unknown category "astro"/);
  });

  it("surfaces an unexpected server error rather than pretending the gallery is empty", async () => {
    stubFetch("upstream is down", { status: 502, statusText: "Bad Gateway" });
    await assert.rejects(getPublicManifest(), /502/);
  });
});
