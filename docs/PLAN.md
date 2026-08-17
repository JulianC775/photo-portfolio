# Photo / Timelapse Portfolio — Plan

**Status:** M0 built. M1 built except the upload CLI, which waits on the Pi. M2 built against
generated fixtures (`npm run seed`) and needs real photographs to be judged. Next: the Pi
(`docs/PI-SETUP.md`), then the CLI, then M3 — most of which needs no storage either.

This doc has five parts:

1. **Requirements** — the original brief. Treat as the source of truth for *what* to build.
2. **Decisions** — the architectural choices made in discussion, with reasoning. Treat as the
   source of truth for *how*.
3. **Milestones** — build order and what "done" means for each.
4. **Confirmed environment** — hardware, domain, and what's still undecided.
5. **Once the Pi is live** — the checklist for the day the storage backend exists. Everything
   currently blocked on credentials is written down there so none of it has to be remembered.

If a decision here turns out wrong during the build, change this doc in the same commit as the
code that diverges from it.

---

# Part 1 — Requirements

## Project overview

A personal portfolio website with two distinct purposes:

1. **Public gallery** — showcases photos and timelapses I've taken (landscape/astro photography,
   timelapses of the night sky). This is the main landing experience.
2. **Private friends section** — a password-protected area, linked from a small banner (not the
   main nav), where friends browse and download photos I've taken *of them*. Should feel separate
   from the public portfolio, not a prominent feature.

## Scale & content volume

- **Public gallery:** small and curated — around 40 photos to start, only favourites/most
  meaningful shots. Grows slowly and deliberately, not in bulk batches. Design for a curated feel;
  a clean grid is enough at this volume — no heavy pagination/infinite-scroll machinery. **Do not
  hardcode a "40" limit anywhere.**
- **Friends section:** much higher volume — hundreds of photos, organised into folders/events.
  Needs to handle bulk browsing and downloading well (pagination or lazy-loading within folders).

## Design direction

- Minimal, dark theme, photo-forward — images dominate, UI chrome stays out of the way. Thin/subtle
  nav, generous negative space, no busy borders or heavy card treatments.
- Typography clean and understated — supporting the photos, not competing with them.

## Feature requirements

### About / bio page
- Short bio, what kind of photography I do (landscape, astro, timelapses), a couple of
  career/contact links.
- Linked from the main nav alongside the gallery. Minimal, consistent with the dark aesthetic.

### Public portfolio
- Home/landing page with a hero section (featured photo or timelapse video).
- Gallery grid, filterable/sortable by category (Astro, Landscape, Timelapses).
- Individual photo/timelapse detail view — larger image or video player, caption, location/date
  metadata where available.
- Timelapses served efficiently (compressed/streamed, not raw multi-hundred-MB files).
- Responsive — mobile and desktop.
- Small, unobtrusive banner or footer link ("Friends — get your photos here") leading to the
  private section.
- Basic SEO metadata (title, description, OG image) on public pages **only**. The private section
  must not be indexable — `noindex`, absent from the sitemap.
- **Strip GPS/location EXIF** from any image served on the public gallery before it's viewable at
  full size or downloadable. Friends-only downloads keep full original metadata.

### Private friends section
- Reached only via the banner link, at a distinct route (`/friends`).
- Password entry screen before any content loads.
- After correct password, a gallery of downloadable photos.
- Clear per-photo **Download** button serving the full-resolution original, not the web preview.
- Downloads must work reliably on mobile (iOS Safari/Chrome, Android Chrome) and desktop. Use
  `Content-Disposition: attachment` so files save rather than opening an in-browser preview. Flag
  mobile-specific quirks (iOS Safari sometimes needs a direct link tap rather than a JS-triggered
  download).
- Bulk "download whole event as zip" is a **nice-to-have**. Less reliable on mobile;
  individual-photo download must always work as the fallback.
- Photos organised into folders/events ("Birthday 2026", "Camping Trip") — not one giant dump.
- Session persists for a reasonable window (browser session or a few days) so friends aren't
  re-entering the password every visit.
- Password check protected from brute-forcing.

### Admin / upload workflow
- A straightforward way to add photos/timelapses to both sections **without hand-editing code**.
- Metadata per photo: title, category/tags, date taken, location (optional), public vs friends-only.

## Constraints & preferences

- Keep it simple. Personal project, not enterprise software. Avoid over-engineering.
- Owner has ~2.5–3 years Python, ~1.5 years React/JS. Idiomatic modern React/TypeScript is fine;
  **explain any non-obvious architectural decision**.
- Prioritise image/video load performance — it needs to feel fast despite large media.
- **No hardcoded secrets.** Passwords, API keys, storage credentials all via environment variables,
  documented in `.env.example`.
- **Cost-sensitive.** Prefer self-hosted/free options over recurring paid services. See the storage
  decision below.

---

# Part 2 — Decisions

## D1. Stack

- Next.js (App Router) + React + TypeScript
- Tailwind CSS
- `sharp` for image derivatives, `exifr` for EXIF reads (both used in the CLI, not at request time)
- `zod` for manifest validation
- `jose` for signed session cookies
- `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` for storage (S3 API — provider-agnostic)
- Deployed on **Vercel**. Media is *not* served by Vercel (see D3).

## D2. Metadata storage — JSON manifests in object storage, not in git

Two manifests, stored as objects alongside the media:

```
<public bucket>/  content/public.json
<private bucket>/ content/friends.json
```

**Why manifests and not a database.** 40 public photos and low hundreds of friends photos is not a
database problem. JSON gives zero infra, no connection setup in serverless, and a schema that's
readable by hand. Validate with `zod` on load so a malformed manifest fails loudly.

**Why in the bucket and not in git.** Committing the manifest would mean a commit + redeploy every
time a photo is added — explicitly unwanted. Storing it next to the media means the upload CLI
writes it directly and the site picks it up with no deploy.

**Consequences to handle:**

- Gallery pages become ISR rather than static-at-build. Visually identical, still cache-served.
- Loss of git history on metadata. Mitigate: the CLI writes
  `content/backups/<manifest>-<timestamp>.json` before every write (a few KB each, keep them all),
  and validates the new manifest against the zod schema *before* uploading. Rollback = copy a
  backup over the live file.
- Freshness: `fetch` the manifest with `cache: 'force-cache'` and
  `next: { revalidate: 300, tags: ['content'] }`, and expose `POST /api/revalidate`
  (shared-secret guarded) calling `revalidateTag('content')`. The CLI pings it as its final step,
  so uploads appear within seconds instead of waiting out the TTL.
- Read-modify-write races are not a concern — single uploader.

**Two Next 16 details this depends on** (both differ from older App Router material):

- `fetch` caching is **opt-in**. Without an explicit `cache: 'force-cache'` the manifest would be
  refetched on every render, and the tag would have nothing to invalidate.
- `revalidateTag` now takes a cache-life profile as a second argument. The recommended `'max'`
  gives stale-while-revalidate, which means the first visitor after an upload — usually the owner
  checking their own work — still sees the old gallery. We pass `{ expire: 0 }` instead, so that
  visitor pays one small blocking JSON fetch and sees the new photo. Cheap at this traffic level,
  and it's what "appears within seconds" is meant to mean.

Cache Components (`cacheComponents` + `'use cache'`) is deliberately **not** enabled. The
fetch-option caching above is fully supported, and one tagged fetch is not enough surface to
justify adopting a different caching model.

### Durability — the manifest is the only irreplaceable data

Since the Pi is a serving copy and originals live on the PC (D3), everything on the Pi is
regenerable from the PC — **except the manifests**. Titles, categories, captions, locations and
curation decisions exist nowhere else. Losing the SSD without a manifest copy means re-typing every
photo's metadata by hand.

Therefore the CLI **must mirror each manifest to the local machine after every successful write**,
to a configurable path (`LOCAL_MANIFEST_MIRROR`) that sits inside the owner's normal PC backup
scope — ideally beside the originals. Treat this as a hard requirement of the upload command, not a
separate housekeeping step, and add a `restore` command in M4 that rebuilds a bucket's manifest from
the local mirror.

`src/lib/content.ts` is the **only** module that reads manifests. Swapping to a real database later
is a one-file change, and only becomes necessary if mutable per-photo state is needed (view counts,
per-person access grants, uploads by someone who isn't the owner).

## D3. Media storage — self-hosted Raspberry Pi, S3-compatible

The owner already has a Raspberry Pi and wants to avoid recurring storage cost. All storage access
goes through a provider interface (`src/lib/storage/index.ts`) so the backend is configuration, not
code.

### Confirmed hardware

- **Raspberry Pi 5 (8 GB)**, booting from a **1 TB TEAMGROUP T-Force Vulcan Z SATA SSD** in a UGREEN
  USB 3.0 enclosure (ASMedia chipset, UASP). Not booting from SD card. Confirm UASP is actually
  negotiated (`lsusb -t` should show `uas`, not `usb-storage`) — without it, throughput and latency
  under concurrent uploads degrade badly.
- 1 TB is far beyond the projected need (tens of GB), so storage headroom is not a constraint.

### Target setup

- **Garage** or **MinIO** in Docker as the S3 server. Garage preferred: single binary, light,
  ARM64-native, built for exactly this. Both speak the S3 API, so the app code is identical.
  - **One caveat found while writing the setup runbook:** Garage does not implement S3 bucket
    policies for anonymous GET, so the public bucket's anonymous read goes through its separate
    `s3_web` endpoint (bucket chosen by `Host` header) rather than the S3 API. That works, but it
    means two tunnel targets and public URLs without the bucket path segment. MinIO does anonymous
    read on the normal endpoint in one command. Recommendation is therefore **MinIO for the first
    setup** — see `docs/PI-SETUP.md` §2. Storage is an interface either way; the only thing that
    changes is `NEXT_PUBLIC_MEDIA_URL`.
- Two buckets: `portfolio-public` (anonymous read) and `portfolio-private` (no anonymous access;
  reachable only via presigned URLs).
- **Cloudflare Tunnel** (`cloudflared`) mapping `media.<domain>` → the Garage endpoint. No port
  forwarding, no exposed home IP, free TLS.
- Cloudflare cache rules: cache the public bucket path aggressively (paths are content-addressed,
  so `immutable` + long `max-age` is safe). **Explicitly bypass cache for the private bucket path**
  — presigned URLs must never be served from a shared cache.
- **One exception inside the public bucket: `content/`.** Media keys are content-addressed, but
  `content/public.json` is a *mutable object at a stable key*. If the aggressive rule swallows it,
  new photos stop appearing regardless of what `/api/revalidate` does. Either scope the immutable
  rule to the media prefixes or set the rule to respect the origin `Cache-Control` — the CLI writes
  the manifest with `max-age=60` and derivatives with `immutable` (see `CACHE_CONTROL` in
  `src/lib/storage/index.ts`), so honouring the origin gets both right on its own.
- `STORAGE_FORCE_PATH_STYLE=true` — Garage/MinIO use path-style addressing, unlike R2/S3.

### Why this works better than expected

- **Uploads run over LAN.** The CLI talks to the Pi at gigabit speeds when you're home, so the
  hours-long upload of a big shoot over home upstream simply doesn't happen.
- **Edge caching absorbs public traffic.** Most public gallery requests are served by Cloudflare
  and never reach the Pi, so home upstream bandwidth is not the bottleneck for the portfolio.

### Known risks — accept knowingly

- **Uptime.** A power cut or ISP outage takes the site's images down. This matters more for the
  public portfolio (linked from career/contact links) than for the friends section.
- **Upstream bandwidth on cache misses.** A friend bulk-downloading an event pulls full-resolution
  originals straight from home upstream — private-bucket traffic is deliberately uncached.
- **Backup — resolved.** The **owner's PC is the archive of record**; full-resolution originals live
  there. The Pi/SSD is a **serving copy only**. If the SSD dies, the recovery path is re-running the
  upload CLI against the originals on the PC — no photo data is lost. See D2 for the one piece of
  data this does *not* cover.

### Documented fallback

Cloudflare R2 has a 10 GB free tier and zero egress fees, so the public side would be free at this
scale. If Pi uptime becomes a problem, the intended move is **hybrid**: public bucket on R2, friends
archive on the Pi. Because storage is an interface, that's two provider instances with different
config — no page or component changes. Do not pre-build for this; just don't design against it.

## D4. Upload workflow — local CLI, not an admin page

`scripts/upload.ts`, run from the owner's machine.

```bash
# public gallery — curated, a few at a time
npm run upload -- ./DSC_4821.jpg --public --category astro --title "Milky Way over Sedona"

# friends event — bulk
npm run upload -- ./camping-trip/*.jpg --event "Camping Trip 2026"
```

Both flags together uploads the same source twice, processed differently for each destination.
Flags may be omitted; the CLI prompts.

**Per file:**

1. Read EXIF (date taken, camera, GPS) with `exifr`.
2. **Public path:** generate 400 / 1200 / 2400w AVIF + WebP with `sharp`. `sharp` drops metadata by
   default — that *is* the EXIF strip, but **assert it**: re-read one output and fail the upload if
   any GPS tag survives. Do not trust the default silently.
3. **Friends path:** upload the original byte-for-byte with full EXIF intact (that's the point of
   the download), plus one web-preview size so the browse grid isn't loading 25 MB files.
4. Generate a ~20px base64 blur placeholder for LQIP.
5. Upload with `@aws-sdk/lib-storage` (auto-multipart above ~100 MB), 6–8 concurrent.
6. Append to the manifest, back it up, validate, write, ping revalidate.

**Idempotent:** files already present in the manifest are skipped, so an interrupted batch resumes
by re-running the same command.

**Why not an admin page.** A browser uploader can't commit or easily own the manifest write path
without extra infrastructure, uploads would have to route around Vercel's request body limit via
presigned URLs anyway, and image processing would need to happen client-side or in a queue instead
of on a machine with `sharp` and no time limit. The CLI is a fraction of the work and the owner is
the only uploader. Note that D2 (runtime-writable manifest) leaves the door open to add an admin
page later without a database — but don't build it now.

## D5. Auth — shared password now, per-event later

`checkPassword(input)` returns a **grant**, not a boolean:

```ts
type Grant = { scope: 'all' } | { scope: { event: string } };
```

The signed cookie stores the grant. Today one shared password yields `{ scope: 'all' }`; moving to
per-event passwords later means adding entries to a map, not restructuring the auth flow.

- Password stored as a **scrypt hash** in an env var, compared timing-safely — so the raw password
  isn't sitting readable in the Vercel dashboard.
- Session cookie: `httpOnly`, `secure`, `sameSite=lax`, signed with `jose`, ~7 day expiry.
- Rate limit login attempts per IP (fixed window, in-memory is acceptable to start given single-
  instance traffic; note the limitation in the code).
- `middleware.ts` guards `/friends/*` except `/friends/login`.
- `/friends/*` sets `noindex` and is excluded from `sitemap.ts`.

## D6. Downloads

`GET /api/friends/download/[id]` verifies the session grant, then **302-redirects to a short-lived
presigned URL** with `response-content-disposition: attachment; filename="..."` set as a query
parameter on the presign. The file bytes never pass through Vercel — no function duration or
response size limit applies.

- iOS Safari can be unreliable with JS-triggered downloads. The Download control must be a real
  `<a href>` the user taps, not a scripted `click()`.
- Zip-per-event is deferred to M5. When built, generate the zip **at upload time** and store it as
  an object, so download is a plain presigned URL — do not stream a zip through a serverless
  function. Multi-GB downloads remain unreliable on mobile; per-photo download stays the fallback.

## D7. Video

Start with one well-compressed 1080p H.264 MP4 per timelapse, served from the public bucket with
range requests (Garage/MinIO support these, so seeking works). Compress *before* upload — a raw
multi-GB export will store fine and play badly.

If timelapses become a substantial part of the site, the upgrade path is Cloudflare Stream or Mux
for HLS/adaptive bitrate. A single MP4 means every viewer gets one bitrate; that's an acceptable
trade at low volume.

## D8. Image delivery — bypass Vercel image optimisation entirely

The CLI pre-generates every size, so images are served as plain `<img srcset>` / `next/image` with
`unoptimized`, straight from the media domain. Vercel does zero image work: no transformation
quota, no bandwidth, no function in the path.

## D9. Domain & DNS — registered at Cloudflare, served by Vercel

**Domain: `catellolens.com`** (registering now). Media host: `media.catellolens.com`.

Buy the domain at **Cloudflare Registrar**, not through Vercel.

**Why.** `cloudflared` requires the DNS zone to live on Cloudflare. Registering through Vercel would
mean moving nameservers to Cloudflare afterwards anyway to make `media.<domain>` work, so this just
removes a step. Cloudflare Registrar also sells at wholesale cost with no markup and no first-year
promotional pricing — roughly $10–12/yr for a `.com`, and the only recurring cost in this setup.

Vercel still serves the app; its records are simply created in Cloudflare's dashboard rather than
Vercel's. Vercel's domain setup flow states the exact values.

| Record | Target | Cloudflare proxy |
|---|---|---|
| apex + `www` | Vercel | **DNS only** (grey cloud) — Vercel advises against proxying in front of it |
| `media.<domain>` | Cloudflare Tunnel | **Proxied** (orange cloud) — `cloudflared` creates this record itself |

Notes:

- Cloudflare Registrar doesn't support every TLD. `.com`, `.net`, `.org`, `.dev`, `.io` are fine;
  for anything exotic, register elsewhere and point the nameservers at Cloudflare — same end state.
- The apex record being grey-cloud means the *site* is not behind Cloudflare's cache. That's
  intended: Vercel does its own edge caching, and the media domain — the part that actually needs
  aggressive caching — is proxied separately.
- **Not needed for M0.** Vercel's free `*.vercel.app` URL covers the scaffold and first deploy. The
  domain becomes necessary at M1, when the tunnel needs a stable hostname.

## D10. Categories are data, not code

Astro / Landscape / Timelapses is the **starting** set, not the final one. Adding a category must
never require a code change or a deploy.

- The manifest carries an explicit `categories` array (slug + display label + sort order) alongside
  the photos. Explicit rather than derived-from-photos so labels and ordering stay controllable, and
  so an empty category can exist without a photo in it yet.
- Schema uses `category: z.string()` validated as a **reference into that array** — never
  `z.enum([...])`. A photo naming an unknown category is a manifest validation error.
- The gallery filter UI renders from the manifest. No category strings anywhere in JSX, no union
  types of literals, no `switch` on category.
- `--category <new-slug>` in the CLI prompts to create the category (asking for a display label)
  and appends it to the manifest.

The same rule applies to friends' events, which are already modelled this way.

---

# Part 3 — Milestones

### M0 — Scaffold ✅ (deploy outstanding)
Next.js 16 + React 19 + TS + Tailwind v4, dark shell, nav + footer with the friends link, home
hero (gradient placeholder), About and Gallery placeholder pages, `robots.ts` + `sitemap.ts` with
`/friends` excluded from both, `.env.example`.

Placeholder `/gallery` and `/friends` pages exist purely so the first deploy has no dead links;
both are replaced in M2/M3. `/friends` already carries `noindex` — it is never crawlable at any
point in the project's history.

**Remaining:** owner deploys to Vercel and sets `NEXT_PUBLIC_SITE_URL`. Deploying now means
deployment is never a big-bang step later. *Needs no credentials.*

### M1 — Storage + content layer
Prerequisites (owner): domain registered at Cloudflare (D9); SSD mounted, Garage/MinIO running, two
buckets created, `cloudflared` tunnel live on `media.<domain>`, cache rules set, access keys issued.
Then: types, zod manifest schema, `StorageProvider` interface + S3 implementation,
`src/lib/content.ts`, `/api/revalidate`, and a first working version of the upload CLI proving one
real photo end-to-end.

**Built, no credentials needed** — everything except the CLI, since none of it has to talk to a real
bucket to be written or tested:

| | |
|---|---|
| `src/lib/manifest.ts` | zod schemas + inferred types for both manifests |
| `src/lib/storage/index.ts` | `StorageProvider` interface, lazy config, cache policies, `publicMediaUrl` |
| `src/lib/storage/s3.ts` | the S3 implementation — the only file importing an S3 client |
| `src/lib/content.ts` | manifest read/write, pure view helpers, local mirror |
| `src/app/api/revalidate/route.ts` | shared-secret guarded `revalidateTag` |
| `src/lib/*.test.ts` | 26 tests: schema rules and the read path with `fetch` stubbed (`npm test`) |

Two things fell out of building it that are worth knowing:

- Storage env vars are validated **lazily, on first use**, not at module load. The site is deployed
  before the Pi exists, and pages that don't touch storage have to keep rendering with these vars
  unset — module-level validation would turn "not configured yet" into "app won't boot".
- A manifest write **refuses to run at all** if `LOCAL_MANIFEST_MIRROR` is unset, rather than
  writing and warning. Invariant 7 is about the one piece of unregenerable data in the system, so
  the failure belongs before the write, not after it.

**Remaining:** `scripts/upload.ts` — needs live credentials to be worth writing, since its whole
job is proving one real photo end-to-end (`sharp` derivatives, the GPS-strip assertion, presigned
reads, the revalidate ping). **See Part 5** for the full checklist of what to do the day the Pi
comes up, including the smoke tests that prove the layer above before the CLI is stacked on it.

### M2 — Public gallery
Hero, filterable grid, detail view / lightbox, blur placeholders, `srcset` tuning, SEO + OG image +
sitemap + robots. The site becomes real here.

**Built** against generated fixtures (`npm run seed`), since the Pi doesn't exist yet:

| | |
|---|---|
| `src/lib/media.ts` | renditions → `<picture>`/`srcset`, format preference, OG image choice |
| `src/components/photo-image.tsx` | one responsive image: intrinsic dimensions, LQIP background, explicit `sizes` |
| `src/components/photo-grid.tsx` | CSS-columns masonry, hover captions, timelapse badge |
| `src/components/category-filter.tsx` | filter as links, labels and counts from the manifest |
| `src/app/gallery/page.tsx` | grid + filter, one manifest read per render |
| `src/app/gallery/[id]/page.tsx` | detail view, `generateStaticParams`, per-item OG, prev/next |
| `src/app/page.tsx` | hero from the newest `featured` item, gradient fallback when there is none |
| `src/app/sitemap.ts` | now includes every public item |

Three decisions worth recording, two of them divergences from the wording above:

- **The category filter is links, not a Client Component.** `/gallery?category=astro` is a real URL —
  linkable, bookmarkable, indexable — ships no JavaScript, and keeps the page a Server Component.
  Next's client-side navigation makes it feel like local state anyway. Consequence: `/gallery` is
  server-rendered per request rather than static, because it reads `searchParams`. The manifest
  fetch is still cached, so the per-request work is JSX only.
- **The detail view is a page, not an overlay lightbox.** A route gets a shareable URL, its own OG
  image and a sitemap entry; an overlay gets none of those. The overlay treatment with keyboard
  navigation is already an M5 line item and can be layered on these routes without changing them.
- **No `next/image`.** Plain `<picture>` with pre-generated renditions, per D8 — see the reasoning
  at the top of `src/lib/media.ts`.

**Not done, and waiting on real photographs rather than on code:** judging how the grid *feels*
(crop, density, whether the type competes), and the `srcset`/LCP tuning pass. Fixtures are
procedural gradients — faithful in dimensions, formats and file layout, but they cannot tell you
whether the gallery looks good. Treat the layout as provisional until real photos are in.

### M3 — Friends section
Login screen, grant + session cookie, middleware guard, rate limiting, event folders, paginated
grid, per-photo download via presigned redirect, `noindex`.

### M4 — CLI hardening
Batch mode across both destinations, EXIF-strip assertion, resume/skip behaviour, video path,
manifest backups.

### M5 — Polish
Timelapse player, keyboard navigation in the lightbox, LCP/perf pass, optional pre-generated
per-event zips, `rclone` backup job on the Pi.

---

# Part 4 — Confirmed environment

| | |
|---|---|
| Domain | `catellolens.com`, Cloudflare Registrar. Media at `media.catellolens.com` |
| Server | Raspberry Pi 5 (8 GB), boots from 1 TB SATA SSD over USB 3.0 (UGREEN/ASMedia, UASP) |
| Archive of record | **The owner's PC.** The Pi is a serving copy — see D2 durability and D3 |
| Categories | Astro / Landscape / Timelapses to start, extensible without a deploy — see D10 |

## Still open

- Root `README.md` was deleted and a copy now lives in `docs/`. Restore one at the root?
- Bio copy, contact/career links, and the featured hero image for the About and home pages —
  placeholders until supplied.

---

# Part 5 — Once the Pi is live

Everything that is blocked on real storage existing, in the order it wants doing. Phase 3 is the
part worth not skipping: it proves the code written in M1 against a real backend *before* the
upload CLI is layered on top, so a failure has one obvious cause instead of two.

**`docs/PI-SETUP.md` is the companion runbook** — the same work with actual commands, config files,
and the split between what only the owner can do and what happens in code. This part stays the
checklist; that file is the how.

## Phase 1 — Verify the Pi itself

- [ ] Booting from the SSD, not the SD card.
- [ ] **UASP actually negotiated:** `lsusb -t` shows `uas`, not `usb-storage`. Without it,
      throughput and latency under concurrent uploads degrade badly (D3) — and it's a silent
      failure, so check rather than assume.
- [ ] Clock is NTP-synced. S3 SigV4 rejects requests more than ~15 minutes out, and a Pi with a
      drifted clock produces authentication errors that look like bad credentials.
- [ ] Garage (preferred) or MinIO running under Docker, set to restart on boot — a power cut
      should bring the site back without a keyboard.

## Phase 2 — Buckets, keys, tunnel, DNS

- [ ] Buckets `portfolio-public` and `portfolio-private` created.
- [ ] `portfolio-public`: anonymous read **on**. `portfolio-private`: anonymous read **off**.
- [ ] Access key issued with read+write on both buckets. Note the region name Garage is
      configured with — it goes in `STORAGE_REGION` and SigV4 signing fails if it disagrees.
- [ ] Domain at Cloudflare Registrar; Vercel's apex + `www` records added as **DNS only** (grey
      cloud); `cloudflared` tunnel live on `media.catellolens.com`, **proxied** (orange) — D9.
- [ ] Cloudflare cache rules per D3: aggressive `immutable` on the media prefixes, **bypass** on
      the private bucket path, and **`content/` excluded from the aggressive rule** (or the rule
      set to respect origin `Cache-Control`). Getting this wrong means new photos never appear.

## Phase 3 — Smoke-test the M1 layer before writing the CLI

Each line maps to something already written that has never met a real bucket. A `tsx` one-liner
against `src/lib/` is enough for most of them — no CLI needed.

- [ ] `.env.local` filled in: `STORAGE_*`, `NEXT_PUBLIC_MEDIA_URL`, `REVALIDATE_SECRET`
      (`openssl rand -hex 32`), `LOCAL_MANIFEST_MIRROR`. Point the mirror **inside your PC's
      normal backup scope** — ideally beside the originals (invariant 7).
- [ ] Same vars set in Vercel **except `LOCAL_MANIFEST_MIRROR`**, which is local-only, plus
      `NEXT_PUBLIC_SITE_URL`. Then redeploy. (`FRIENDS_PASSWORD_HASH` / `SESSION_SECRET` are M3 —
      not needed yet.)
- [ ] Anonymous `GET https://media.catellolens.com/portfolio-public/…` succeeds; the same shape of
      request against `portfolio-private` is **denied**. This is the whole security model of the
      public/private split — verify it directly, don't infer it from config.
- [ ] `getPublicManifest()` against an empty bucket returns an empty manifest (the 404 path) rather
      than throwing.
- [ ] Hand-write a small `content/public.json`, upload it, and read it back through
      `getPublicManifest()` — proves schema, fetch path and media URL all agree.
- [ ] Break that manifest on purpose (unknown category) and confirm the failure is loud and names
      the field. The "fail loudly" promise in D2 is only real if it's been seen once.
- [ ] `presignGet` on a private object: the URL downloads, and it **saves under the original
      filename** rather than opening in the browser. If Garage ignores
      `response-content-disposition`, the fallback is setting `Content-Disposition` as object
      metadata at upload time instead — D6 depends on one of the two working.
- [ ] A presigned URL returns `cf-cache-status: BYPASS`/`DYNAMIC`, never `HIT`. A cached presigned
      URL is a private photo served to whoever asks.
- [ ] `content/public.json` is **not** served as `immutable` — re-upload it and confirm the change
      is visible through the media domain within a minute.
- [ ] Range requests work through the tunnel (`curl -r 0-1023`) — video seeking depends on it (D7).
- [ ] `POST /api/revalidate` on the **deployed** site with the real secret returns 200, and a wrong
      secret returns 401. Already verified locally; the deployed env var is the untested half.

## Phase 4 — Finish M1: the upload CLI

- [ ] `npm i sharp exifr`, add `"upload": "tsx scripts/upload.ts"`.
- [ ] Build `scripts/upload.ts` per D4: EXIF read → derivatives (public) / byte-for-byte original
      (friends) → blur placeholder → upload → manifest append, backup, write, mirror → revalidate
      ping.
- [ ] **Decide the upload endpoint.** D3 assumes uploads run over LAN at gigabit, but
      `STORAGE_ENDPOINT` as documented points at the tunnel — which sends a home upload out to
      Cloudflare and back. Set `STORAGE_ENDPOINT` in `.env.local` to the Pi's **LAN address**
      (the site on Vercel keeps using the tunnel), or accept upstream speed for uploads. Worth
      knowing either way: Cloudflare's free plan caps request bodies at 100 MB, so anything large
      *must* go over LAN or through multipart — `lib-storage`'s 5 MB default parts stay under it.
- [ ] **The GPS assertion** (invariant 2): re-read a generated derivative and fail the upload if
      any GPS tag survived. Test it with a photo you know has GPS — a passing assertion that never
      fires proves nothing.
- [ ] Confirm the friends original is byte-for-byte identical to the source (compare hashes) with
      full EXIF intact (invariant 3).
- [ ] Confirm `content/backups/<name>-<timestamp>.json` appears before each overwrite, and that
      `LOCAL_MANIFEST_MIRROR` receives the new manifest in the same command (invariant 7).
- [ ] Re-run the same command and confirm it skips everything — interrupted batches must resume
      (D4).
- [ ] One large file end-to-end, to see multipart actually engage.
- [ ] Upload one real photo, ping revalidate, and see it on the live site. That's M1 done.

## Phase 5 — First real photos: what to re-check

M2 was built against fixtures, so the first genuine upload is also the first honest look at it.
Specifically:

- [ ] Switch `NEXT_PUBLIC_MEDIA_URL` off the seed server and stop `npm run dev:media`
      (`docs/PI-SETUP.md` §7). `.dev-media/` can be deleted; keep the seed script.
- [ ] Look at the grid with real photographs and say what's wrong with it. Column count, gutters,
      hover caption, whether the masonry reading order (down, not across) bothers you.
- [ ] Check what `srcset` actually picks at a few window widths (DevTools → Network → the chosen
      rendition). The `sizes` strings in `photo-grid.tsx` and the hero are educated guesses; real
      files are where a wrong one shows up as a 2400px download in a 400px slot.
- [ ] Run Lighthouse on the home page and one detail page. LCP is the number that matters, and the
      hero is the element to watch.
- [ ] Confirm a real photo's `blurDataUrl` looks like the photo. A wrong-aspect placeholder is
      visible as a flash on load.

## Then

M3 (friends section) is the remaining milestone, and most of it — login, grant, session cookie,
middleware, rate limiting — needs no storage at all. Only the download redirect touches the Pi, and
`presignGet` is already written and waiting for the Phase 3 check that Garage or MinIO honours
`response-content-disposition`.
