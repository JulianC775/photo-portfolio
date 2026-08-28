/**
 * Password checking. The only place that knows how a password is stored or compared.
 *
 * **scrypt, not a plain hash.** The stored value is a deliberately slow key derivation, so a leaked
 * `FRIENDS_PASSWORD_HASH` can't be reversed by hashing a wordlist at GPU speed. And it's a *hash*
 * in the env var rather than the password itself, so the plaintext never sits readable in the
 * Vercel dashboard (docs/PLAN.md D5).
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
    throw new Error(`FRIENDS_PASSWORD_HASH is not a valid scrypt hash. Regenerate it: npm run hash-password`);
  }

  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    throw new Error("FRIENDS_PASSWORD_HASH has unreadable scrypt parameters. Regenerate it.");
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
 * Written as a list of candidate secrets rather than one `if`, which is what makes the D5 claim
 * true in practice — per-event passwords become another entry in this array, and nothing else in
 * the login flow, the cookie or the pages has to change.
 */
export async function checkPassword(input: string): Promise<Grant | null> {
  if (!input) return null;

  for (const candidate of candidates()) {
    if (await verifyPassword(input, candidate.hash)) return candidate.grant;
  }
  return null;
}

type Candidate = { hash: string; grant: Grant };

function candidates(): Candidate[] {
  const shared = process.env.FRIENDS_PASSWORD_HASH;
  if (!shared) {
    throw new Error(
      "FRIENDS_PASSWORD_HASH is not set, so nobody can sign in.\n" +
        "Generate one with: npm run hash-password -- '<the password>'",
    );
  }
  // Today: one shared password granting everything. Later: one entry per event, whose grant is
  // { scope: { event: slug } }. See D5.
  return [{ hash: shared, grant: { scope: "all" } }];
}
