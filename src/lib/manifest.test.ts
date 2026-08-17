/**
 * Tests for the manifest schema and the pure view helpers.
 *
 * Worth testing because the manifests are hand-editable data outside the type system: the
 * category-reference rule (invariant 8) and the "fail loudly" promise (D2) are only real if
 * they're enforced. Run with `npm test`; no network, no credentials.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listCategories, listEventPhotos, listEvents, listItems } from "./content";
import {
  emptyFriendsManifest,
  emptyPublicManifest,
  friendsManifestSchema,
  publicManifestSchema,
  type FriendsManifest,
  type PublicManifest,
} from "./manifest";

const photo = (overrides: Record<string, unknown> = {}) => ({
  kind: "photo",
  id: "milky-way-sedona",
  title: "Milky Way over Sedona",
  category: "astro",
  addedAt: "2026-08-01T12:00:00.000Z",
  width: 2400,
  height: 1600,
  renditions: [{ key: "photos/milky-way-sedona/2400.avif", format: "avif", width: 2400, height: 1600 }],
  ...overrides,
});

const publicManifest = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  updatedAt: "2026-08-01T12:00:00.000Z",
  categories: [{ slug: "astro", label: "Astro", order: 0 }],
  items: [photo()],
  ...overrides,
});

describe("publicManifestSchema", () => {
  it("accepts an empty manifest, so the site works before the first upload", () => {
    assert.equal(publicManifestSchema.safeParse(emptyPublicManifest()).success, true);
  });

  it("applies defaults rather than requiring every field", () => {
    const parsed = publicManifestSchema.parse(publicManifest());
    assert.equal(parsed.items[0].featured, false);
  });

  it("rejects a photo naming a category the manifest doesn't declare", () => {
    const result = publicManifestSchema.safeParse(
      publicManifest({ items: [photo({ category: "portraits" })] }),
    );
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0].message, /unknown category "portraits"/);
    assert.deepEqual(result.error!.issues[0].path, ["items", 0, "category"]);
  });

  it("accepts a category with no photos in it yet", () => {
    const result = publicManifestSchema.safeParse(
      publicManifest({
        categories: [
          { slug: "astro", label: "Astro", order: 0 },
          { slug: "timelapses", label: "Timelapses", order: 1 },
        ],
      }),
    );
    assert.equal(result.success, true);
  });

  it("rejects duplicate ids, which would make a detail URL ambiguous", () => {
    const result = publicManifestSchema.safeParse(
      publicManifest({ items: [photo(), photo({ title: "A copy" })] }),
    );
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0].message, /duplicate item id/);
  });

  it("rejects ids that aren't URL-safe slugs", () => {
    assert.equal(
      publicManifestSchema.safeParse(publicManifest({ items: [photo({ id: "Milky Way!" })] })).success,
      false,
    );
  });

  it("rejects a photo with no renditions, which would render as a broken image", () => {
    assert.equal(
      publicManifestSchema.safeParse(publicManifest({ items: [photo({ renditions: [] })] })).success,
      false,
    );
  });

  it("accepts a timelapse alongside photos", () => {
    const result = publicManifestSchema.safeParse(
      publicManifest({
        categories: [{ slug: "timelapses", label: "Timelapses", order: 0 }],
        items: [
          {
            kind: "timelapse",
            id: "orion-rising",
            title: "Orion Rising",
            category: "timelapses",
            addedAt: "2026-08-01T12:00:00.000Z",
            width: 1920,
            height: 1080,
            sources: [
              { key: "video/orion.mp4", contentType: "video/mp4", width: 1920, height: 1080 },
            ],
            poster: [{ key: "video/orion-poster.avif", format: "avif", width: 1920, height: 1080 }],
          },
        ],
      }),
    );
    assert.equal(result.success, true);
  });

  it("rejects an object key with a leading slash", () => {
    const result = publicManifestSchema.safeParse(
      publicManifest({
        items: [photo({ renditions: [{ key: "/photos/a.avif", format: "avif", width: 100, height: 100 }] })],
      }),
    );
    assert.equal(result.success, false);
  });
});

describe("friendsManifestSchema", () => {
  const friendsPhoto = (overrides: Record<string, unknown> = {}) => ({
    id: "dsc-4821",
    event: "camping-trip-2026",
    filename: "DSC_4821.jpg",
    original: { key: "events/camping-trip-2026/DSC_4821.jpg", bytes: 24_000_000, width: 6000, height: 4000 },
    preview: [{ key: "events/camping-trip-2026/dsc-4821/1200.webp", format: "webp", width: 1200, height: 800 }],
    addedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  });

  const friendsManifest = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    updatedAt: "2026-08-01T12:00:00.000Z",
    events: [{ slug: "camping-trip-2026", label: "Camping Trip 2026", date: "2026-07-04" }],
    photos: [friendsPhoto()],
    ...overrides,
  });

  it("accepts an empty manifest", () => {
    assert.equal(friendsManifestSchema.safeParse(emptyFriendsManifest()).success, true);
  });

  it("accepts a well-formed manifest", () => {
    assert.equal(friendsManifestSchema.safeParse(friendsManifest()).success, true);
  });

  it("rejects a photo in an event the manifest doesn't declare", () => {
    const result = friendsManifestSchema.safeParse(
      friendsManifest({ photos: [friendsPhoto({ event: "birthday-2026" })] }),
    );
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0].message, /unknown event "birthday-2026"/);
  });

  it("rejects a coverPhotoId that isn't a photo in the manifest", () => {
    const result = friendsManifestSchema.safeParse(
      friendsManifest({
        events: [{ slug: "camping-trip-2026", label: "Camping Trip 2026", coverPhotoId: "nope" }],
      }),
    );
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0].message, /coverPhotoId "nope"/);
  });
});

describe("views over a public manifest", () => {
  const manifest = publicManifestSchema.parse(
    publicManifest({
      categories: [
        { slug: "landscape", label: "Landscape", order: 2 },
        { slug: "astro", label: "Astro", order: 1 },
      ],
      items: [
        photo({ id: "older", takenAt: "2025-01-01T00:00:00.000Z" }),
        photo({ id: "newer", takenAt: "2026-01-01T00:00:00.000Z" }),
        photo({ id: "coastline", category: "landscape", takenAt: "2024-01-01T00:00:00.000Z" }),
      ],
    }),
  ) as PublicManifest;

  it("orders categories by the manifest's own order field", () => {
    assert.deepEqual(listCategories(manifest).map((c) => c.slug), ["astro", "landscape"]);
  });

  it("lists items newest first", () => {
    assert.deepEqual(listItems(manifest).map((i) => i.id), ["newer", "older", "coastline"]);
  });

  it("filters by category slug", () => {
    assert.deepEqual(listItems(manifest, { category: "landscape" }).map((i) => i.id), ["coastline"]);
  });

  it("returns nothing for an unknown category instead of throwing", () => {
    assert.deepEqual(listItems(manifest, { category: "does-not-exist" }), []);
  });

  it("does not mutate the manifest while sorting", () => {
    const before = manifest.items.map((i) => i.id);
    listItems(manifest);
    assert.deepEqual(manifest.items.map((i) => i.id), before);
  });
});

describe("views over a friends manifest", () => {
  const manifest = friendsManifestSchema.parse({
    version: 1,
    updatedAt: "2026-08-01T12:00:00.000Z",
    events: [
      { slug: "undated", label: "Undated" },
      { slug: "birthday-2026", label: "Birthday 2026", date: "2026-03-01" },
      { slug: "camping-trip-2026", label: "Camping Trip 2026", date: "2026-07-04" },
    ],
    photos: [
      {
        id: "second",
        event: "camping-trip-2026",
        filename: "b.jpg",
        original: { key: "events/b.jpg", bytes: 1, width: 10, height: 10 },
        preview: [{ key: "events/b-1200.webp", format: "webp", width: 10, height: 10 }],
        takenAt: "2026-07-04T18:00:00.000Z",
        addedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        id: "first",
        event: "camping-trip-2026",
        filename: "a.jpg",
        original: { key: "events/a.jpg", bytes: 1, width: 10, height: 10 },
        preview: [{ key: "events/a-1200.webp", format: "webp", width: 10, height: 10 }],
        takenAt: "2026-07-04T09:00:00.000Z",
        addedAt: "2026-08-01T12:00:00.000Z",
      },
    ],
  }) as FriendsManifest;

  it("orders events newest first, undated last", () => {
    assert.deepEqual(listEvents(manifest).map((e) => e.slug), [
      "camping-trip-2026",
      "birthday-2026",
      "undated",
    ]);
  });

  it("orders photos within an event chronologically", () => {
    assert.deepEqual(listEventPhotos(manifest, "camping-trip-2026").map((p) => p.id), [
      "first",
      "second",
    ]);
  });

  it("returns nothing for an event with no photos", () => {
    assert.deepEqual(listEventPhotos(manifest, "birthday-2026"), []);
  });
});
