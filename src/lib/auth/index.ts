/**
 * The auth boundary (CLAUDE.md). Nothing outside `src/lib/auth/` should know that passwords are
 * scrypt hashes, that the session is a JWT, or that the cookie has a particular name.
 *
 * Split by runtime rather than by feature, which is the one non-obvious thing about this folder:
 *
 * | file | runs where | knows about |
 * |---|---|---|
 * | `grant.ts` | anywhere | what a grant is and what it permits |
 * | `token.ts` | anywhere incl. Edge | signing and verifying the JWT (`jose`) |
 * | `password.ts` | Node only | scrypt hashing and comparison (`node:crypto`) |
 * | `session.ts` | Server Components/Actions | the cookie, and `requireGrant()` |
 * | `rate-limit.ts` | anywhere | login attempt windows |
 *
 * `proxy.ts` may only import from `grant.ts` and `token.ts` — the Edge runtime has no
 * `node:crypto` and no `next/headers`.
 */
export { grantAllowsEvent, isGrant, type Grant } from "./grant";
export { checkPassword, hashPassword, verifyPassword } from "./password";
export { clearAttempts, clientKey, recordAttempt, type RateLimitResult } from "./rate-limit";
export { endSession, getGrant, isSafeReturnPath, loginUrl, requireGrant, startSession } from "./session";
export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./token";
