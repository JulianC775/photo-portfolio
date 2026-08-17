/**
 * Tests for the rendition → markup helpers.
 *
 * These are worth pinning down because the failure mode is invisible: a wrong format order or a
 * mis-built `srcset` still renders a picture, just the wrong file, and nobody notices until a
 * 2400px image is being served to a phone.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Rendition } from "./manifest";
import { fallbackRendition, formatTakenAt, imageSources, largestRendition } from "./media";

// These helpers need a media host. It's read lazily inside `publicMediaUrl` on each call, not at
// import time, so setting it here — before any test body runs — is enough.
process.env.NEXT_PUBLIC_MEDIA_URL = "https://media.example.test/portfolio-public";

const r = (format: string, width: number): Rendition => ({
  key: `photos/x/${width}.${format}`,
  format,
  width,
  height: Math.round(width * (2 / 3)),
});

describe("imageSources", () => {
  it("groups renditions by format and orders them best-compression first", () => {
    const sources = imageSources([r("webp", 400), r("avif", 400), r("jpeg", 400)]);
    assert.deepEqual(
      sources.map((s) => s.format),
      ["avif", "webp", "jpeg"],
    );
  });

  it("builds a width-descriptor srcset per format, ascending", () => {
    const [avif] = imageSources([r("avif", 1200), r("avif", 400)]);
    assert.equal(
      avif.srcSet,
      "https://media.example.test/portfolio-public/photos/x/400.avif 400w, " +
        "https://media.example.test/portfolio-public/photos/x/1200.avif 1200w",
    );
  });

  it("maps formats to MIME types for <source type>", () => {
    const types = imageSources([r("avif", 400), r("webp", 400), r("jpeg", 400)]).map((s) => s.type);
    assert.deepEqual(types, ["image/avif", "image/webp", "image/jpeg"]);
  });

  it("sorts an unknown format last rather than dropping it", () => {
    const sources = imageSources([r("jxl", 400), r("avif", 400)]);
    assert.deepEqual(
      sources.map((s) => s.format),
      ["avif", "jxl"],
    );
    // Still emitted with a plausible type, so a browser that understands it can use it.
    assert.equal(sources[1].type, "image/jxl");
  });
});

describe("fallbackRendition", () => {
  it("picks the most widely supported format, at its largest size", () => {
    const chosen = fallbackRendition([r("avif", 2400), r("jpeg", 400), r("jpeg", 1200)]);
    assert.equal(chosen.format, "jpeg");
    assert.equal(chosen.width, 1200);
  });

  it("falls back to the safest format actually present", () => {
    // Seeded and real manifests may only carry avif + webp; webp is then the safe one.
    assert.equal(fallbackRendition([r("avif", 2400), r("webp", 2400)]).format, "webp");
  });

  it("copes with a single rendition", () => {
    assert.equal(fallbackRendition([r("avif", 400)]).width, 400);
  });
});

describe("largestRendition", () => {
  it("returns the widest regardless of format", () => {
    assert.equal(largestRendition([r("webp", 400), r("avif", 2400), r("jpeg", 1200)]).width, 2400);
  });
});

describe("formatTakenAt", () => {
  it("formats in UTC so server and client agree", () => {
    assert.equal(formatTakenAt("2026-05-14T04:12:00.000Z"), "May 14, 2026");
  });

  it("returns undefined when there is no date", () => {
    assert.equal(formatTakenAt(undefined), undefined);
  });

  it("does not shift the date across a timezone boundary", () => {
    // 23:30 UTC must stay the 14th, not roll to the 15th (or back to the 13th) on a machine
    // in another zone — this is the bug the explicit timeZone exists to prevent.
    assert.equal(formatTakenAt("2026-05-14T23:30:00.000Z"), "May 14, 2026");
  });
});
