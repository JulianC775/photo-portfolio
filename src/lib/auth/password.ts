/**
 * Password checking. The only place that knows how a password is stored or compared.
 *
 * **scrypt, not a plain hash.** The stored value is a deliberately slow key derivation, so a leaked
 * hash can't be reversed by hashing a wordlist at GPU speed. And it's a *hash* that is stored —
 * per event in the friends manifest, or in `FRIENDS_PASSWORD_HASH` for the owner's master — so the
 * plaintext never sits readable on the Pi or in the Vercel dashboard (docs/PLAN.md D5).
 *
 * **Node-only.** scrypt comes from `node:crypto`, which the Edge runtime doesn't have. That's fine
 * and intentional: passwords are only ever checked in a Server Action, never in `proxy.ts`.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { Grant } from "./grant";

/**
 * Cost parameters. N=16384 keeps a single check around a few tens of milliseconds on modest
 * hardware — slow enough to matter to an attacker, fast enough that a friend doesn't notice.
 *
 * These are only defaults for *new* hashes: the parameters used are stored inside each hash, so
 * raising them later doesn't invalidate existing ones.
 */
const DEFAULTS = { N: 16384, r: 8, p: 1, keyLength: 32 };

/** `scrypt$N$r$p$salt$key`, all base64url. Self-describing so the cost can change later. */
const PREFIX = "scrypt";

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keyLength } = DEFAULTS;
  const salt = randomBytes(16);
  // scryptSync, not promisify(scrypt): @types/node doesn't resolve the options-overload through
  // promisify, so the promisified call rejects a 4th (options) argument at the type level even
  // though it's valid at runtime. Sync sidesteps that entirely and is still just as async to every
  // caller here, since this function stays `async`.
  const key = scryptSync(password.normalize("NFKC"), salt, keyLength, { N, r, p });
  return [PREFIX, N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/**
 * Verify a password against a stored hash, in constant time with respect to the key bytes.
 *
 * A malformed stored hash throws — that's a deployment error worth surfacing loudly, not a failed
 * login. A wrong password returns false.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    throw new Error("Stored password hash is not a valid scrypt hash. Regenerate it: npm run passwords (events) or npm run hash-password (master)");
  }

  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    throw new Error("Stored password hash has unreadable scrypt parameters. Regenerate it.");
  }

  const salt = Buffer.from(rawSalt, "base64url");
  const expected = Buffer.from(rawKey, "base64url");
  const actual = scryptSync(password.normalize("NFKC"), salt, expected.length, {
    N,
    r,
    p,
    // 128 * N * r is scrypt's working memory; Node's default cap is lower than what a raised N
    // would need, so it's derived rather than left at the default.
    maxmem: 256 * N * r,
  });

  // Lengths always match here (we derived to `expected.length`), so timingSafeEqual can't throw.
  return timingSafeEqual(actual, expected);
}

/**
 * The single entry point the login flow uses: a password in, a **grant or null** out.
 *
 * Two kinds of secret can match (docs/PLAN.md D5):
 *
 * - the **event's own password**, whose hash lives on the event in the friends manifest (set with
 *   `npm run passwords`) and grants `{ scope: { event } }` — one friend, one gallery;
 * - the owner's optional **master password**, `FRIENDS_PASSWORD_HASH`, which grants everything.
 *
 * Both are tried even when the first matches, so a login takes the same time whichever it was —
 * a small thing, but it means the response time can't reveal which kind of password was entered.
 *
 * `event` is passed in rather than looked up here because `src/lib/content.ts` is the only module
 * allowed to read manifests (CLAUDE.md boundaries); the login action reads it and hands over just
 * what auth needs.
 */
export async function checkPassword(
  input: string,
  event?: { slug: string; passwordHash?: string },
): Promise<Grant | null> {
  if (!input) return null;

  let granted: Grant | null = null;
  for (const candidate of candidates(event)) {
    if ((await verifyPassword(input, candidate.hash)) && !granted) granted = candidate.grant;
  }
  return granted;
}

type Candidate = { hash: string; grant: Grant };

function candidates(event?: { slug: string; passwordHash?: string }): Candidate[] {
  const list: Candidate[] = [];
  if (event?.passwordHash) {
    list.push({ hash: event.passwordHash, grant: { scope: { event: event.slug } } });
  }
  // Optional: a master password for the owner. Unset is fine now that events carry their own.
  const master = process.env.FRIENDS_PASSWORD_HASH;
  if (master) list.push({ hash: master, grant: { scope: "all" } });
  return list;
}
