# Photo / Timelapse Portfolio — Plan

**Status:** M0 built and deployed — `catellolens.com` is live on Vercel. M1 done: the upload CLI
(`scripts/upload.ts`) is verified end-to-end against the live Pi bucket, including a real
GPS-tagged fixture proving invariant 2's assertion actually fires (see Part 5 Phase 4). M2 built
against generated fixtures (`npm run seed`) and still needs real photographs to be judged. **M3 is
now also built**: auth, session, rate limiting, event browsing (`/friends/[event]`), and the
per-photo download route — and as of **2026-09-13** it has both real photos and **per-event
passwords**. The first friends upload went up that day: `IMG_5159.JPG` into event
`monge-graduation`, downloaded back and confirmed byte-identical to the original, so invariant 3 is
demonstrated now rather than argued. D5's "per-event later" is also now: every event carries its own
scrypt hash in the friends manifest, written by `npm run passwords` from a gitignored
`friends-passwords.json`, and `FRIENDS_PASSWORD_HASH` has become an *optional* master password for
the owner. Pi bring-up (`docs/PI-SETUP.md`) is fully done: MinIO, buckets, tunnel, DNS, and cache
rules (including the `content/` bypass rule added after Phase 3 testing surfaced a stale-edge-cache
gap — see Part 5) are all live and verified, and the app's storage key has been rotated at least
once since. Not yet confirmed: Vercel's production environment variables are filled in with the real
Pi values (the deploy above predates them), and a large-file multipart upload has never been
exercised. Next: fill in the Vercel env vars, then sign in to `monge-graduation` on the deployed
site (Part 5 Phase 6).

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
- Read-modify-write races are not a concern — single uploader. But note that only holds if the
  uploader's own read is actually current: `getPublicManifest()` goes through the same
  Cloudflare-edge-cached path (`max-age=60`) pages use, so the CLI reading through it could work
  from a manifest that's already stale by write time and silently drop a just-uploaded item.
  `getPublicManifestDirect()` in `src/lib/content.ts` reads straight from the bucket instead — the
  CLI's read-modify-write uses that exclusively; pages keep using the cached one.

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

### Hybrid: private bucket on Cloudflare R2 (done 2026-09-13)

The "upstream bandwidth" risk above bit on the first real event: the 1.36 GB zip pulled through
the tunnel at ~1 MB/s (measured; the house's upload line is ~2.5 MB/s and cloudflared got under
half of it), so "Download all" took twenty-odd minutes. The fallback this section used to describe
was the other way round — public on R2, private on the Pi — but the public side never needed it:
edge caching already keeps the Pi out of the request path there. It's the *private* bucket whose
every byte is deliberately uncached and therefore leaves the house. So:

- **`portfolio-private` is on Cloudflare R2**; `portfolio-public` stays on the Pi. R2 egress is
  free and fast from anywhere; 10 GB storage is free, then ~$0.015/GB-month.
- **Config, not code:** `PRIVATE_STORAGE_*` in `.env.example`. `src/lib/storage/s3.ts` holds one
  S3 client per bucket role and falls back to the shared `STORAGE_*` connection when the private
  set is blank — the all-on-the-Pi layout still works unchanged. No page or component changed.
- **The cap is in the CLI.** Cloudflare has no "stop at free" switch and wants a card on file, so
  `scripts/lib/quota.ts` refuses any upload or zip rebuild that would pass
  `PRIVATE_STORAGE_CAP_GB` (default 9.5 when R2 is configured), and every run prints the room left.
  The CLI is the only writer, so this is a ceiling, not an alert. `npm run remove-event` deletes an
  event's objects to free room; the originals are on the PC and the Pi is no longer the serving
  copy for private data, so nothing is lost.
- **Uploads now leave the house once** (PC → R2 over the upload line, ~10 min per 1.4 GB event)
  instead of every time a friend downloads. The zip rebuild streams R2 → PC → R2.
- The Pi keeps its copy of `content/friends.json` from before the move as a historical backup; the
  live one is on R2, mirrored locally like before (invariant 7).

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

## D5. Auth — a password per event, hashed into the manifest

`checkPassword(input, event?)` returns a **grant**, not a boolean:

```ts
type Grant = { scope: 'all' } | { scope: { event: string } };
```

Two kinds of secret produce one, and both are checked on every attempt:

- an **event's own password** → `{ scope: { event: slug } }`. One friend, one gallery: the camping
  trip's password opens the camping trip and nothing else.
- the owner's **master password**, `FRIENDS_PASSWORD_HASH` → `{ scope: 'all' }`. Optional now that
  events carry their own, it works from any event's form and is the only grant that sees the
  `/friends` index.

The signed cookie stores the grant, so authorisation is answered from the session without a second
lookup, and `grantAllowsEvent` is the one check every event page and download goes through. The
grant type is why this landed as an extra candidate hash rather than a rework: nothing about the
cookie, the guard or the pages changed shape.

**Why the hashes live in the manifest and not in env vars.** Events are data, not code (D10,
invariant 8) — giving a new event a password must not mean editing Vercel's environment and waiting
out a redeploy. So each event carries a `passwordHash` field in `content/friends.json`, written by
`npm run passwords` (`scripts/set-passwords.ts`) through `writeFriendsManifest`, so the backup and
the local mirror happen like any other manifest write (invariant 7). A hash in the private bucket is
no more exposed than one in the Vercel dashboard: that manifest is never served to a browser, and
scrypt means a leak isn't reversible at wordlist speed. The plaintext lives only in
`friends-passwords.json` on the owner's PC (gitignored), and that file is the source of truth — an
event dropped from it loses its hash on the next run, so revoking access is deleting a line. The
master password stays an env var precisely because it *isn't* event data: it shouldn't be reachable
by anything that can write a manifest.

- Hashes are **scrypt**, compared timing-safely. Both candidates are derived even when the first one
  matches, so the response time can't reveal which kind of password was entered.
- Login is two steps on one URL: `/friends/login` lists the events that have a password
  (`listUnlockableEvents`) as links to `/friends/login?event=<slug>`, which shows that event's form.
  Plain links, no client state, and a friend can bookmark their own. Event *names* are therefore
  visible to anyone who opens the page — accepted deliberately, because the alternative is friends
  guessing which gallery their password belongs to. The photos stay behind the password.
- An event with no password can't be signed into by anyone but the owner, and isn't listed.
- Sign-in lands on `/friends/<slug>`; `/friends` redirects an event-scoped grant straight to its
  event, since an index of one is a detour.
- Session cookie: `httpOnly`, `secure`, `sameSite=lax`, signed with `jose`, ~7 day expiry. Changing
  a password does **not** revoke sessions already issued — they keep working until they expire.
- Rate limit login attempts per IP *before* verifying (fixed window, in-memory is acceptable to
  start given single-instance traffic; note the limitation in the code). Verifying first would make
  the limiter an amplifier: every blocked request would still pay for a scrypt derivation.
- `proxy.ts` guards `/friends/*` except `/friends/login`.
- `/friends/*` sets `noindex` and is excluded from `sitemap.ts`.

## D6. Downloads

`GET /api/friends/download/[id]` verifies the session grant, then **302-redirects to a short-lived
presigned URL** with `response-content-disposition: attachment; filename="..."` set as a query
parameter on the presign. The file bytes never pass through Vercel — no function duration or
response size limit applies.

- iOS Safari can be unreliable with JS-triggered downloads. The Download control must be a real
  `<a href>` the user taps, not a scripted `click()`.
- **"Download all" is a pre-built zip** (built 2026-09-13, pulled forward from M5). The CLI builds
  it after every friends upload — `scripts/lib/archive.ts`, streamed *from the bucket* into a
  multipart upload of `friends/<event>/<event>.zip`, stored not deflated (JPEGs don't compress) —
  and records `{ key, bytes, photoCount }` on the event. `GET /api/friends/archive/[event]` is then
  the same 302-to-presigned-URL as a single photo, so a 1.4 GB download still costs Vercel one
  redirect. `npm run zip -- "Event"` rebuilds by hand. Never stream a zip through a serverless
  function. Multi-GB downloads remain unreliable on mobile; per-photo download stays the fallback.
- **"Download selected"** (checkboxes, `selectable-grid.tsx`) fires one per-photo download per
  selection, each in a hidden iframe pointed at `/api/friends/download/[id]`, staggered 400 ms.
  No zip for an arbitrary selection: it would have to be built either on Vercel (invariant 6) or in
  the browser from every byte first. Chrome asks once to allow multiple downloads; iOS Safari may
  honour only the first — again, the per-photo buttons are the fallback.

## D7. Video

Start with one well-compressed 1080p H.264 MP4 per timelapse, served from the public bucket with
range requests (Garage/MinIO support these, so seeking works). Compress *before* upload — a raw
multi-GB export will store fine and play badly.

**Implemented in `scripts/upload.ts` (2026-09-13).** The compression is the CLI's job, not a
manual ffmpeg invocation, so every timelapse gets the same treatment: `ffmpeg`/`ffprobe` via
`child_process` (no npm dependency, no service), `scale=-2:1080` when the source is taller than
1080 (never upscaled), `libx264 -crf 23 -preset slow`, `-pix_fmt yuv420p`, AAC audio copied when it already
is AAC, re-encoded when it isn't and dropped when there is no audio track at all, and `-movflags +faststart` — the moov atom has
to be at the front or the browser fetches the end of the file before it can paint a frame, which
is what makes range requests useful rather than merely supported. One transcode runs at a time
even in a batch, since x264 already uses every core.

The poster frame is pulled from the *transcoded* file and then run through the same
400/1200/2400 AVIF+WebP ladder and blur placeholder that photos use, so a timelapse carries an
ordinary rendition list and the grid renders it with the photo component (`kind` only matters on
the detail page and the home hero). `durationSeconds` comes from ffprobe; `takenAt` comes only
from the container's `creation_time` tag and stays empty when there isn't one — an export's mtime
would be a confidently wrong date. Keys: `timelapses/<id>/1080.mp4` and
`timelapses/<id>/poster-<width>.<format>`, public bucket, `immutable`. Videos are public-only:
a friends event is full-resolution photos people download (D4), so `--event` refuses a video.

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

### M0 — Scaffold ✅ (deployed at catellolens.com)
Next.js 16 + React 19 + TS + Tailwind v4, dark shell, nav + footer with the friends link, home
hero (gradient placeholder), About and Gallery placeholder pages, `robots.ts` + `sitemap.ts` with
`/friends` excluded from both, `.env.example`.

Placeholder `/gallery` and `/friends` pages exist purely so the first deploy has no dead links;
both are replaced in M2/M3. `/friends` already carries `noindex` — it is never crawlable at any
point in the project's history.

**Done:** deployed to Vercel at `catellolens.com`, `NEXT_PUBLIC_SITE_URL` set.

### M1 — Storage + content layer ✅ (verified against the live Pi; first real *public* photo still pending)
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

**`scripts/upload.ts` is done and verified end-to-end against the live Pi bucket** (D4: EXIF read,
derivative ladder + GPS-strip assertion for the public path, byte-for-byte original + one preview
size for the friends path, blur placeholder, manifest append/backup/mirror, revalidate ping — one
manifest write per file so an interrupted batch resumes on re-run). Two real bugs were found and
fixed during that verification — `exifr.gps()` silently no-op'd on AVIF/WebP derivatives (fixed by
reading EXIF via `sharp`'s own metadata instead), and a Cloudflare-edge-cache race could let a
second upload within the manifest's 60s TTL clobber the first (fixed with `getPublicManifestDirect()`
in `content.ts`, used only by the CLI's read-modify-write). **See Part 5 Phase 3–4** for the full
verification trail. Still untried: a large-file multipart upload, and a real photo through the
now-deployed site.

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
  image and a sitemap entry; an overlay gets none of those. The overlay treatment is still an M5
  line item and can be layered on these routes without changing them. M5's keyboard navigation
  didn't wait for it: Esc closes and the arrow keys move between photos on the page itself
  (2026-09-13, see M5).
- **No `next/image`.** Plain `<picture>` with pre-generated renditions, per D8 — see the reasoning
  at the top of `src/lib/media.ts`.

**Not done, and waiting on real photographs rather than on code:** judging how the grid *feels*
(crop, density, whether the type competes), and the `srcset`/LCP tuning pass. Fixtures are
procedural gradients — faithful in dimensions, formats and file layout, but they cannot tell you
whether the gallery looks good. Treat the layout as provisional until real photos are in.

### M3 — Friends section ✅ (built; first real event verified 2026-09-13)
Login screen, grant + session cookie, proxy guard, rate limiting, event folders, per-photo
download via presigned redirect, `noindex` — all built, and exercised against real storage on
2026-09-13: `IMG_5159.JPG` in event `monge-graduation` came back from its presigned download
byte-identical to the original (invariant 3).

**Per-event passwords are in** (D5), which this milestone had deferred. Each event's scrypt hash
lives on the event in the friends manifest; `npm run passwords` writes them there from a gitignored
`friends-passwords.json` on the owner's PC, so a new event's password costs no deploy and revoking
one is deleting a line. `FRIENDS_PASSWORD_HASH` is now an optional master password rather than the
only way in, and `/friends/login` lists the unlockable events so a friend picks their gallery
instead of guessing which password is theirs. Still open: signing in on the *deployed* site, which
waits on Vercel's env vars — Part 5 Phase 6.

One divergence from the wording above: **no pagination.** CLAUDE.md's simplicity constraint
("don't add pagination... the current volume doesn't need [it]") overrides the requirements
doc's "nice-to-have" — an event's grid is a plain masonry layout like the public gallery, same
reasoning as M2. Revisit only if a single event actually grows large enough to matter.

Event preview images are pre-signed on every page render (they live in the private bucket, so
`PhotoImage`'s public `urlFor` default doesn't apply — see the note at the top of
`src/app/friends/[event]/page.tsx`), at a longer expiry (1 hour) than the download redirect's
short-lived default, since a friend may browse for a while before tapping Download.

### M4 — CLI hardening
Batch mode across both destinations, EXIF-strip assertion, resume/skip behaviour, video path,
manifest backups.

- **The video path is done (2026-09-13)** — `npm run upload -- ./clip.mp4 --public --category …`
  transcodes and publishes a `kind: "timelapse"` item; the settings and the reasoning are in D7.
  First real timelapse published the same day (58 MB source → 21.6 MB 1080p, 8 s to encode).

### M5 — Polish
Timelapse player, LCP/perf pass, `rclone` backup job on the Pi. (Per-event zips moved into M3 —
see D6.)

- **Keyboard navigation is done (2026-09-13)** — on the detail *page*, not in an overlay, since the
  page is what M2 built. `src/app/gallery/[id]/close-controls.tsx` is a small Client Component
  rendering an X in the corner as a real `<Link>` back to `/gallery?category=…`; the same component
  listens for Escape (which pushes that href — never `history.back()`, which does the wrong thing
  for a visitor who arrived from a shared link) and for ArrowLeft/ArrowRight, matching the prev/next
  links. It is the only client JavaScript on the page, and only the shortcuts depend on it.

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

- [x] Booting from the SSD, not the SD card. **Verified 2026-08-18:** `sda2` (953.4 GB) mounted at
      `/` — the whole root filesystem lives on the SSD; there's no separate SD card or `/mnt/ssd`
      partition. See the note in `docs/PI-SETUP.md` §1 — every `/mnt/ssd/...` path in that doc was
      adjusted to a plain path under `/home` as a result.
- [x] **UASP actually negotiated:** `lsusb -t` shows `uas`, not `usb-storage`. Without it,
      throughput and latency under concurrent uploads degrade badly (D3) — and it's a silent
      failure, so check rather than assume. **Verified 2026-08-18.**
- [x] Clock is NTP-synced. S3 SigV4 rejects requests more than ~15 minutes out, and a Pi with a
      drifted clock produces authentication errors that look like bad credentials. **Verified
      2026-08-18** (`timedatectl`: synchronized, active NTP service).
- [x] Garage (preferred) or MinIO running under Docker, set to restart on boot — a power cut
      should bring the site back without a keyboard. **Done 2026-08-18: MinIO**, not Garage — see
      `docs/PI-SETUP.md` §2 for why MinIO was the recommended first choice (anonymous read on the
      public bucket in one command vs. Garage's separate `s3_web` endpoint). Container policy is
      `restart: unless-stopped`.

## Phase 2 — Buckets, keys, tunnel, DNS

- [x] Buckets `portfolio-public` and `portfolio-private` created. **Done 2026-08-18** via `mc mb`.
- [x] `portfolio-public`: anonymous read **on**. `portfolio-private`: anonymous read **off**.
      **Verified 2026-08-18**, both via `mc anonymous get` and a direct `curl` against the local S3
      API: public path 404s (reachable, object just doesn't exist yet), private path 403s.
- [x] Access key issued with read+write on both buckets. **Done 2026-08-18** — a scoped `portfolio`
      user via `mc admin user add` + `readwrite` policy, not the MinIO root credentials. Region is
      MinIO's default `us-east-1` (unset in config) → goes in `STORAGE_REGION`. Values live in
      `~/media/.credentials` on the Pi (mode 600, not in git) — copy into `.env.local` and Vercel
      per `docs/PI-SETUP.md` §5.
- [x] Domain at Cloudflare Registrar; `cloudflared` tunnel live on `media.catellolens.com`,
      **proxied** (orange) — D9. **Done 2026-08-19.** `catellolens.com` registered at Cloudflare;
      tunnel `photo-media` (id `593262c3-5a5b-472f-9283-f25a89d6bd75`) created, DNS CNAME added via
      `cloudflared tunnel route dns`, config at `/etc/cloudflared/config.yml` points
      `media.catellolens.com` → `http://localhost:9000` (MinIO's S3 API). Installed as a systemd
      service (`enabled`, `active`) so it survives reboots. Verified through the live domain: public
      bucket answers anonymously (404 on a missing key), private bucket returns 403.
      **Not yet done:** Vercel's apex + `www` records — that's a Vercel-domain-connection step, out
      of scope for this Pi pass; see D9's table when the app gets its custom domain.
- [x] Cloudflare cache rules per D3: aggressive `immutable` on the media prefixes, **bypass** on
      the private bucket path, and **`content/` excluded from the aggressive rule** (or the rule
      set to respect origin `Cache-Control`). Getting this wrong means new photos never appear.
      **Done and verified live 2026-08-19** by uploading real test objects with the app's actual
      `CACHE_CONTROL` values (`src/lib/storage/index.ts`) and requesting each 3x through
      `media.catellolens.com`:
      - `portfolio-private/*` → `cf-cache-status: BYPASS` on every request.
      - `portfolio-public/content/*` (`max-age=60`) → MISS then HIT, origin TTL preserved.
      - `portfolio-public/media/*` (`immutable`) → MISS then HIT, origin TTL preserved.

      **Bug caught and fixed:** the content/ rule initially served `max-age=14400` instead of the
      origin's `max-age=60` — not a rule-expression problem but the zone-level **Browser Cache
      TTL** setting (Caching → Configuration) overriding origin headers. Fixed by setting it to
      respect existing headers. Worth knowing if this ever regresses: a correctly-scoped cache rule
      can still be defeated by that zone-wide setting, so if manifest updates ever stop appearing
      promptly again, check there before re-auditing the rules themselves.
      Range requests also verified: `curl -r 0-1023` → `206` with correct `content-range`.

## Phase 3 — Smoke-test the M1 layer before writing the CLI

Each line maps to something already written that has never met a real bucket. A `tsx` one-liner
against `src/lib/` is enough for most of them — no CLI needed.

- [x] `.env.local` filled in: `STORAGE_*`, `NEXT_PUBLIC_MEDIA_URL`, `REVALIDATE_SECRET`,
      `STORAGE_ENDPOINT` pointed at the Pi's LAN address per D4/Phase 4. **Done.**
      `LOCAL_MANIFEST_MIRROR` is set — it had to be before the first real upload, since the CLI
      refuses to write a manifest without it (invariant 7).
- [ ] Same vars set in Vercel **except `LOCAL_MANIFEST_MIRROR`**, which is local-only, plus
      `NEXT_PUBLIC_SITE_URL`. Then redeploy. (`SESSION_SECRET` is required for M3's login;
      `FRIENDS_PASSWORD_HASH` is optional — see Phase 6.) Not done — the site isn't deployed yet
      (M0).
- [x] Anonymous `GET https://media.catellolens.com/portfolio-public/…` succeeds; the same shape of
      request against `portfolio-private` is **denied**. **Verified**: public 404s (reachable, key
      just doesn't exist), private 403s.
- [x] `getPublicManifest()` against an empty bucket returns an empty manifest (the 404 path) rather
      than throwing. **Verified.**
- [x] Hand-write a small `content/public.json`, upload it, and read it back through
      `getPublicManifest()` — proves schema, fetch path and media URL all agree. **Verified**, via
      `writePublicManifest`/`getPublicManifest` round-tripping a real category through the bucket.
- [x] Break that manifest on purpose (unknown category) and confirm the failure is loud and names
      the field. **Verified** — rejected before ever reaching the bucket, field path included.
- [x] `presignGet` on a private object: the URL downloads, and it **saves under the original
      filename** rather than opening in the browser. **Verified** — `response-content-disposition`
      works on MinIO; the object-metadata fallback wasn't needed.
- [x] A presigned URL returns `cf-cache-status: BYPASS`/`DYNAMIC`, never `HIT`. **Verified.**
- [x] `content/public.json` is **not** served as `immutable` — re-upload it and confirm the change
      is visible through the media domain within a minute. **Verified**: `max-age=60`, and a fresh
      write shows up on the next request past that TTL.
- [x] Range requests work through the tunnel (`curl -r 0-1023`) — video seeking depends on it (D7).
      **Verified**: `206` with a correct `content-range`.
- [ ] `POST /api/revalidate` on the **deployed** site with the real secret returns 200, and a wrong
      secret returns 401. Still only verified locally (`route.ts`'s own logic); the deployed env
      var is untested since the site isn't deployed. The CLI's revalidate step is wired up and
      warns without failing the run if the site is unreachable — confirmed by running it against
      `http://localhost:3000` with nothing listening.

## Phase 4 — Finish M1: the upload CLI

- [x] `npm i sharp exifr`, add `"upload": "tsx scripts/upload.ts"`. **Done.**
- [x] Build `scripts/upload.ts` per D4: EXIF read → derivatives (public) / byte-for-byte original
      (friends) → blur placeholder → upload → manifest append, backup, write, mirror → revalidate
      ping. **Done.** Interactive prompts (`node:readline/promises`) fill in anything not passed
      as a flag — category label on first use, event name, per-photo title — and files within one
      run are processed with up to 6 in flight at once (D4 step 5).
- [x] **Decide the upload endpoint.** `STORAGE_ENDPOINT` in `.env.local` is the Pi's LAN address
      (`192.168.1.72:9000`); the deployed site keeps using the tunnel. **Confirmed already
      configured correctly.**
- [x] **The GPS assertion** (invariant 2): re-read a generated derivative and fail the upload if
      any GPS tag survived. **Done and verified against a real GPS-tagged fixture** — with one
      correction along the way: `exifr.gps()` throws `Unknown file format` on the AVIF/WebP
      derivatives this pipeline actually produces (it only sniffs GPS reliably out of JPEG), and
      the original code's `.catch(() => undefined)` silently turned that error into "no GPS
      found" — making the assertion a no-op for every derivative it exists to check. Fixed by
      reading `sharp(derivative).metadata().exif` instead (present only when metadata was kept)
      and stripping its 6-byte JPEG-APP1 prefix before handing the raw TIFF payload to
      `exifr.gps()`, which works regardless of the container format. Verified all four cases:
      GPS correctly detected in a forced-leak derivative (both formats), and correctly absent for
      both a clean derivative and a GPS-less source (both formats).
- [x] Confirm the friends original is byte-for-byte identical to the source (compare hashes) with
      full EXIF intact (invariant 3). **Verified** — SHA-256 of the uploaded original matches the
      source file exactly.
- [x] Confirm `content/backups/<name>-<timestamp>.json` appears before each overwrite, and that
      `LOCAL_MANIFEST_MIRROR` receives the new manifest in the same command (invariant 7).
      **Verified**, both buckets.
- [x] Re-run the same command and confirm it skips everything — interrupted batches must resume
      (D4). **Verified**, including the partial case (uploaded to one destination, not the
      other). One bug found and fixed along the way: the CLI's pre-write read used
      `getPublicManifest()` — the same Cloudflare-edge-cached read (`max-age=60`) pages use — so a
      second upload run within that window could read a stale manifest and silently clobber the
      first run's item on write. Fixed by adding `getPublicManifestDirect()` in
      `src/lib/content.ts`, which reads straight from the bucket; the CLI now uses that
      exclusively for its own read-modify-write. `getPublicManifest()` is unchanged and pages
      keep using it — that cache is what makes the gallery fast for everyone else.
- [ ] One large file end-to-end, to see multipart actually engage. Not yet tried — every test
      photo so far has been small; worth doing once real originals are available.
- [ ] Upload one real photo, ping revalidate, and see it on the live site. Revalidate itself is
      wired up and warns (without failing the run) if it can't reach `NEXT_PUBLIC_SITE_URL` — not
      yet tried against a deployed site, since the site isn't deployed yet (M0's "deploy
      outstanding" is still outstanding). That's the actual remainder of M1.

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

## Phase 6 — Per-event passwords

Built, unit-tested (`src/lib/auth/auth.test.ts`) and pushed to the Pi on 2026-09-13, so
`monge-graduation`'s hash is real. What's left needs the deployed site:

- [ ] Fill in Vercel's env vars, then sign in to `monge-graduation` on `catellolens.com` with the
      password from `friends-passwords.json`. The whole flow has only ever run locally.
- [ ] `FRIENDS_PASSWORD_HASH` is **optional** on Vercel now that events carry their own hashes.
      Either set it as the owner's master password — it's the only grant that sees the `/friends`
      index — or leave it blank deliberately. Don't carry an old shared password over assuming it's
      still required.
- [ ] Confirm the scope holds on real data: with an event-scoped session, `/friends` should redirect
      to that event, and another event's URL should bounce back to the login.
- [ ] Change a password, re-run `npm run passwords`, and check both halves: the old password stops
      working, and a friend already signed in keeps their session until it expires (~7 days).

## Then

M3 is built, and as of 2026-09-13 proven against the Pi: a real original downloads back
byte-identical, on top of Phase 3's finding that MinIO honours `response-content-disposition`. What
remains is M4 (CLI hardening — multipart on a genuinely large file is the untested path) and M5
(polish), plus the deployed-site checks in Phases 5 and 6.
