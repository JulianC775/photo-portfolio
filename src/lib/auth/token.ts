/**
 * Signing and verifying the session token. Nothing else in `auth/` is allowed to touch `jose`.
 *
 * **Kept free of `next/headers` on purpose.** `proxy.ts` runs on the Edge runtime and cannot use
 * `cookies()`; it reads the cookie off the request object instead. Splitting the token primitives
 * out from the cookie helpers in `session.ts` is what lets both the proxy and Server Components
 * verify the same token without one of them importing something it can't run.
 *
 * A signed JWT rather than a server-side session store because there is nothing to store: the
 * grant *is* the whole session, and a stateless cookie needs no database, no Redis and no shared
 * state between serverless instances (docs/PLAN.md D5).
 */
import { jwtVerify, SignJWT } from "jose";

import { isGrant, type Grant } from "./grant";

export const SESSION_COOKIE = "friends_session";

/** Seven days, per D5 — long enough that friends aren't re-entering a password every visit. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Not a general-purpose issuer: the audience and issuer claims make a token from this app
 * unusable elsewhere, and vice versa, in the event the signing key is ever shared.
 */
const ISSUER = "catellolens";
const AUDIENCE = "catellolens:friends";

function signingKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — see .env.example. Generate with: openssl rand -hex 32");
  }
  // A short secret would make the HMAC brute-forceable, so it's a hard failure rather than a
  // warning. 32 hex chars is 16 bytes; the intended value is 64 hex chars.
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET is too short — use at least 32 characters (openssl rand -hex 32)");
  }
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(grant: Grant): Promise<string> {
  return new SignJWT({ grant })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(signingKey());
}

/**
 * The grant carried by a valid token, or `null` for anything else — bad signature, expired, wrong
 * issuer, or a payload this version of the code doesn't recognise.
 *
 * Returns `null` rather than throwing because every caller's response to "no valid session" is the
 * same (send them to the login page), and a thrown error there would be an error page instead of a
 * login form.
 */
export async function readSessionToken(token: string | undefined): Promise<Grant | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"], // pinned: never let the token's own header choose the algorithm
    });
    return isGrant(payload.grant) ? payload.grant : null;
  } catch {
    return null;
  }
}
