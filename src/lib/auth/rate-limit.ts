/**
 * Fixed-window rate limiting for login attempts.
 *
 * **In-memory, and that is a known limitation, not an oversight** (docs/PLAN.md D5). On Vercel each
 * serverless instance has its own Map, so the real ceiling is `ATTEMPTS × instances`, and a cold
 * start forgets everything. What it reliably stops is the thing that actually threatens a shared
 * password: someone pointing a script at the login form and working through a wordlist. That
 * becomes minutes-per-guess instead of thousands-per-second, which — combined with scrypt on every
 * attempt — is enough at this scale.
 *
 * The upgrade path, if the friends section ever gets real traffic, is Vercel KV or Upstash with the
 * same function signature. Don't pre-build it.
 */

/** Attempts allowed per window, per key. Generous enough for a mistyped password. */
const ATTEMPTS = 8;

/** Window length. */
const WINDOW_MS = 10 * 60 * 1000;

/** Guards against unbounded growth if this is ever hit by a lot of distinct addresses. */
const MAX_TRACKED_KEYS = 10_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Records an attempt and says whether it may proceed.
 *
 * Called *before* the password is checked, so a blocked request never pays for a scrypt
 * derivation — otherwise the rate limiter would itself be the denial-of-service.
 */
export function recordAttempt(key: string, now = Date.now()): RateLimitResult {
  prune(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: ATTEMPTS - 1 };
  }

  if (existing.count >= ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) };
  }

  existing.count += 1;
  return { allowed: true, remaining: ATTEMPTS - existing.count };
}

/**
 * Clears a key's window after a successful sign-in, so someone who mistyped twice and then got it
 * right isn't still carrying two attempts against them.
 */
export function clearAttempts(key: string): void {
  windows.delete(key);
}

/** Test seam — the module holds process-wide state, which tests need to be able to reset. */
export function resetRateLimit(): void {
  windows.clear();
}

function prune(now: number): void {
  if (windows.size < MAX_TRACKED_KEYS) {
    // Cheap path: only drop expired entries when the map is actually getting big. Iterating the
    // whole map on every attempt would be wasted work.
    return;
  }
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * The rate-limit key for a request: the client IP where we can determine it.
 *
 * On Vercel `x-forwarded-for` is set by the platform and its first entry is the real client. This
 * header is trivially spoofable when the app is *not* behind such a proxy, which is why this is a
 * speed bump on password guessing rather than an access control — nothing security-critical is
 * decided by it.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
  return ip || "unknown";
}
