# Pi setup — runbook

Everything needed to turn the Raspberry Pi into the media backend, in order, with a clear split
between what only you can do and what I do once credentials exist.

`docs/PLAN.md` Part 5 is the checklist view of the same work. This file is the *how* — actual
commands and config. Where they disagree, this file is more specific and PLAN.md is more current
on intent.

> **On confidence.** The commands here are written from the shape these tools normally take, not
> from a run on your hardware — I can't reach the Pi. Treat them as a strong starting point, expect
> one or two to need a flag adjusted for your versions, and check anything that fails against the
> upstream docs rather than fighting it. The parts I'm least sure about are flagged inline with
> **verify**.

---

## Who does what

**You** — anything physical, networked, or credential-bearing:

- SSD, OS, Docker, the S3 server, buckets, access keys
- Cloudflare: domain, tunnel, DNS, cache rules
- Filling `.env.local` and the Vercel environment variables

**Me** — anything that is code or verification:

- The smoke tests in PLAN.md Phase 3, once credentials exist
- `scripts/upload.ts`, the last piece of M1
- Any config shape that turns out to need changing (bucket URL layout, endpoint, cache policy)

**Never paste a secret key into chat.** Put it straight into `.env.local` and tell me "keys are in".
I don't need to see them to write or test code — everything reads from the environment.

---

## 1. Hardware and OS

```bash
# Confirm you're booted from the SSD, not the SD card
lsblk
findmnt /

# UASP check — this is the one that silently costs you throughput (PLAN.md D3)
lsusb -t          # want "Driver=uas", NOT "Driver=usb-storage"

# Clock — S3 SigV4 rejects requests skewed more than ~15 minutes, and the failure
# looks exactly like bad credentials, which will waste an hour if you skip this
timedatectl status    # want "System clock synchronized: yes"
```

If `lsusb -t` says `usb-storage`, the enclosure isn't negotiating UASP. Usually a firmware quirk;
worth searching your specific ASMedia chipset before accepting it.

**Verified on the real hardware (2026-08-18):** `lsblk` shows `sda2` (953.4 GB) mounted at `/` —
the Pi boots the *entire root filesystem* from the SSD, there is no separate SD card and no
separate `/mnt/ssd` partition. `lsusb -t` confirmed `Driver=uas`. Clock was NTP-synced. **This
means every `/mnt/ssd/...` path below is wrong for this box** — data directories in §2 use a plain
path under `/home` instead, since the whole disk *is* the SSD already. If you're following this
runbook on different hardware that does have a separate data partition, use that mount instead.

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"      # log out and back in
docker run --rm hello-world
```

---

## 2. Choose the S3 server — read this before you install

PLAN.md D3 prefers **Garage**, and for storage that's still the right call: single binary, light,
ARM64-native. But there's one requirement it handles differently from what the plan assumed, and
it's worth knowing before you build on it:

**The public bucket needs anonymous read** — the whole point of invariant 6 is that browsers fetch
images straight from the media domain with no credentials.

- **MinIO** does this over the normal S3 endpoint with one command
  (`mc anonymous set download …`). Path-style URLs, so `NEXT_PUBLIC_MEDIA_URL` keeps the
  `/portfolio-public` suffix already in `.env.example`. Nothing else changes.
- **Garage** does not implement S3 bucket policies for anonymous GET. Public access goes through
  its **separate web endpoint** (`s3_web`, default port 3902), which picks the bucket from the
  `Host` header. That works fine, but it means the tunnel points at 3902 for public reads and 3900
  for the credentialed S3 API, and public URLs lose the bucket path segment — so
  `NEXT_PUBLIC_MEDIA_URL` becomes `https://media.catellolens.com` with no suffix. **verify** against
  the Garage docs for your version.

**My recommendation: MinIO for the first setup.** Not because Garage is worse, but because it costs
one command instead of a second endpoint plus a Host-based routing rule, and you have enough moving
parts today. The app genuinely does not care — `src/lib/storage/` is one file behind an interface,
and both are pure config. Switching later is an afternoon, not a rewrite.

Either way, tell me which you picked and what the public URL ends up looking like; the only thing I
change is `NEXT_PUBLIC_MEDIA_URL`.

### 2a. MinIO (recommended path)

`~/media/docker-compose.yml`:

```yaml
services:
  minio:
    image: minio/minio:latest
    container_name: minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: admin
      MINIO_ROOT_PASSWORD: <a long random password>
    volumes:
      - /home/<user>/media/minio-data:/data
    ports:
      - "9000:9000"   # S3 API
      - "9001:9001"   # web console — keep this LAN-only, never through the tunnel
```

```bash
mkdir -p ~/media/minio-data && cd ~/media && docker compose up -d

# mc = MinIO's CLI. Install once. sudo mv to /usr/local/bin needs an interactive password —
# if that's not available (e.g. running from an agent session), just keep it in ~/media/mc
# and invoke it by path instead.
curl -sSLo mc https://dl.min.io/client/mc/release/linux-arm64/mc
chmod +x mc && sudo mv mc /usr/local/bin/ || mv mc ~/media/mc   # verify

mc alias set pi http://localhost:9000 admin '<that password>'

mc mb pi/portfolio-public
mc mb pi/portfolio-private

# Anonymous read on the public bucket ONLY. Verify the private one stays closed (step 6).
mc anonymous set download pi/portfolio-public

# A scoped key for the app + CLI, rather than using the root credentials
mc admin user add pi portfolio '<a long random secret>'
mc admin policy attach pi readwrite --user portfolio
```

`STORAGE_REGION` for MinIO is `us-east-1` unless you've set one explicitly.

**Done on this Pi (2026-08-18).** Docker, MinIO, both buckets, anonymous read on
`portfolio-public`, and a scoped `portfolio` access key all exist and were verified locally
(`mc anonymous get`, plus a direct `curl` against `localhost:9000` — public 404s as reachable,
private 403s). Root and app credentials are in `~/media/.credentials` on the Pi (mode `600`,
gitignored path, never committed) — copy `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`
from there into `.env.local` and Vercel per §5 below. `docker-compose.yml` lives at
`~/media/docker-compose.yml`; data is at `~/media/minio-data` (see the §1 note on why this isn't
under `/mnt/ssd`). Still open: the Cloudflare tunnel, DNS, and cache rules (§3–4) — those need an
interactive Cloudflare login only the owner can do.

### 2b. Garage (if you prefer it)

`/etc/garage.toml` — **verify** every key against the docs for your Garage version, these move
between releases:

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir     = "/home/<user>/media/garage-data"
db_engine    = "lmdb"

replication_factor = 1          # single node

rpc_bind_addr = "[::]:3901"
rpc_secret    = "<openssl rand -hex 32>"

[s3_api]
s3_region     = "garage"        # this exact string goes in STORAGE_REGION
api_bind_addr = "[::]:3900"

[s3_web]                        # the anonymous-read endpoint discussed above
bind_addr   = "[::]:3902"
root_domain = ".web.catellolens.com"

[admin]
admin_token = "<openssl rand -hex 32>"
```

```bash
docker compose up -d
garage status
garage layout assign -z home -c 900G <node-id>
garage layout apply --version 1

garage bucket create portfolio-public
garage bucket create portfolio-private
garage key create portfolio-app
garage bucket allow --read --write --key portfolio-app portfolio-public
garage bucket allow --read --write --key portfolio-app portfolio-private

# Public read via the web endpoint, plus an alias so the bucket answers on the media domain
garage bucket website --allow portfolio-public
garage bucket alias portfolio-public media.catellolens.com
```

---

## 3. Cloudflare Tunnel

```bash
# Install cloudflared (arm64), then:
cloudflared tunnel login
cloudflared tunnel create photo-media
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel UUID>
credentials-file: /home/<user>/.cloudflared/<tunnel UUID>.json

ingress:
  - hostname: media.catellolens.com
    service: http://localhost:9000      # MinIO S3 API (Garage: 3902 for public reads)
  - service: http_status:404
```

```bash
cloudflared tunnel route dns photo-media media.catellolens.com
sudo cloudflared service install     # so it survives a reboot
sudo systemctl status cloudflared
```

This creates the DNS record itself, proxied (orange cloud) — which is what you want for media.
Do **not** proxy the apex/`www` records that point at Vercel; those stay grey-cloud (PLAN.md D9).

**Never route the MinIO console (9001) through the tunnel.** It's an admin login; keep it LAN-only.

**Done on this Pi (2026-08-19).** Tunnel `photo-media` (id `593262c3-5a5b-472f-9283-f25a89d6bd75`)
created and routed to `media.catellolens.com`. Installed as a systemd service — not the plain
`cloudflared tunnel run` shown above — since that survives reboots the same way the MinIO
container's `restart: unless-stopped` does. One difference from the steps above worth knowing:
`cloudflared service install` reads its config from `/etc/cloudflared/`, not the user's
`~/.cloudflared/`, because the systemd service runs as root. So the actual sequence used was:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
sudo cp ~/media/bin/cloudflared /usr/local/bin/cloudflared   # binary was fetched by direct
                                                                # download, not apt — see below
sudo cloudflared service install
sudo systemctl status cloudflared
```

Verified through the live domain (not just locally): `curl -sI https://media.catellolens.com/portfolio-public/<missing-key>`
returns 404 (reachable, anonymous), the same request against `/portfolio-private/` returns 403.

**Also worth knowing:** `cloudflared` was installed by downloading the `linux-arm64` release binary
directly (`~/media/bin/cloudflared`) rather than via `apt`, since most of the tunnel setup —
`login`, `create`, `route dns` — runs as a normal user and doesn't need `sudo` at all this way. Only
the final "install as a service" step needs root, to write into `/etc/cloudflared/` and register
with systemd.

---

## 4. Cloudflare cache rules

Three rules, in this order. The third is the one that will silently break "new photos appear in
seconds" if you skip it.

| # | Match | Action | Why |
|---|---|---|---|
| 1 | `http.host eq "media.catellolens.com"` and `http.request.uri.path contains "/portfolio-private/"` | **Bypass cache** | Presigned URLs must never sit in a shared cache — that's a private photo served to whoever asks |
| 2 | `http.host eq "media.catellolens.com"` and `http.request.uri.path contains "/content/"` | **Respect origin TTL** (or bypass) | `content/public.json` is a *mutable object at a stable key*. Cached as immutable, the gallery freezes forever |
| 3 | `http.host eq "media.catellolens.com"` | **Cache everything**, Edge TTL: respect origin | Derivative keys are content-addressed, so the `immutable` header the CLI sets is safe and does the work |

Simplest correct setup: make every rule **respect the origin `Cache-Control`**. The code already
sends the right header per object type — `immutable` for derivatives, `max-age=60` for manifests,
`private, no-store` for the private bucket (see `CACHE_CONTROL` in `src/lib/storage/index.ts`) — so
honouring the origin gets all three right without encoding the policy twice.

---

## 5. Environment variables

**`.env.local` on your PC** (never committed):

```bash
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Point at the Pi's LAN address, NOT the tunnel — see the note below
STORAGE_ENDPOINT=http://192.168.x.x:9000
STORAGE_REGION=us-east-1          # MinIO default; "garage" if you chose Garage
STORAGE_ACCESS_KEY_ID=portfolio
STORAGE_SECRET_ACCESS_KEY=<secret>
STORAGE_FORCE_PATH_STYLE=true
STORAGE_BUCKET_PUBLIC=portfolio-public
STORAGE_BUCKET_PRIVATE=portfolio-private

NEXT_PUBLIC_MEDIA_URL=https://media.catellolens.com/portfolio-public

REVALIDATE_SECRET=<openssl rand -hex 32>
LOCAL_MANIFEST_MIRROR=D:/Photos/portfolio-manifests
```

**Why the LAN address for uploads.** PLAN.md D3 assumes uploads run at gigabit because you're on
the same network as the Pi. If `STORAGE_ENDPOINT` points at the tunnel, a home upload goes out to
Cloudflare and back — slower, and Cloudflare's free plan caps request bodies at 100 MB.
`@aws-sdk/lib-storage` uses 5 MB multipart chunks so it wouldn't actually fail, but there's no
reason to send your own bytes on a round trip. The site on Vercel uses the tunnel; only your CLI
uses the LAN address.

**In the Vercel dashboard** — the same values, with two differences:

- `NEXT_PUBLIC_SITE_URL` = your real site URL
- `STORAGE_ENDPOINT` = `https://media.catellolens.com` (Vercel isn't on your LAN)
- **omit `LOCAL_MANIFEST_MIRROR` entirely.** It's local-only. A manifest write refuses to run
  without it, which is deliberate — the app should never be writing manifests anyway.

`FRIENDS_PASSWORD_HASH` and `SESSION_SECRET` are M3; leave them blank for now.

Then redeploy so the new variables are picked up.

---

## 6. Verify before building on it

Run these yourself, or tell me the keys are in and I'll do the equivalent from the code side
(PLAN.md Part 5, Phase 3 — it's the same list, expressed as things the code has to do).

```bash
# Public bucket readable anonymously
curl -sI https://media.catellolens.com/portfolio-public/content/public.json

# Private bucket NOT readable anonymously — must be 403/404, never 200
curl -sI https://media.catellolens.com/portfolio-private/content/friends.json

# Range requests work through the tunnel (video seeking needs this)
curl -sI -r 0-1023 https://media.catellolens.com/portfolio-public/<some file>

# Cache behaviour: derivatives may HIT, anything under content/ must not be immutable
curl -sI https://media.catellolens.com/portfolio-public/<some derivative> | grep -i 'cf-cache-status\|cache-control'
```

The one that matters most is the second: if the private bucket answers `200` to an anonymous
request, the friends section has no security model and nothing else is worth testing yet.

---

## 7. Switching the site off seeded data

Development currently runs against generated fixtures (`npm run seed` + `npm run dev:media`,
serving `.dev-media/` on port 4321). To move to the real thing:

1. Set `NEXT_PUBLIC_MEDIA_URL` in `.env.local` to the real media URL.
2. Stop the `dev:media` server — nothing needs it any more.
3. `rm -rf .dev-media` whenever you like; it's gitignored and regenerable.

Keep the seed script. It stays useful for working on layout offline, and for reproducing a bug
without touching real photos.

---

## 8. Then: the upload CLI

That's M1 finished except `scripts/upload.ts`, which I'll write once the above is real. It needs a
live bucket because its entire job is proving one photo end-to-end: EXIF read, derivative
generation, **the GPS-strip assertion** (invariant 2 — and test it against a photo you know has GPS,
since an assertion that never fires proves nothing), byte-for-byte original upload, manifest append
with backup and local mirror, then the revalidate ping.

When you're ready, the useful message is just: **"keys are in, MinIO/Garage, public URL looks like
X"** — and I'll take it from there.
