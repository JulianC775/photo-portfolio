/**
 * The session cookie, and the authorisation check every protected page and route goes through.
 *
 * This is the "data access layer" the Next docs recommend: `proxy.ts` does a cheap optimistic
 * redirect so an unauthenticated visitor never sees a flash of a protected page, but it is
 * explicitly *not* the security boundary. `requireGrant()` is, and it runs as close to the data as
 * possible — inside the page or route handler that is about to read private photos.
 *
 * Uses `next/headers`, so it can only be called from Server Components, Server Actions and Route
 * Handlers. The Edge-safe half lives in `./token`.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { Grant } from "./grant";
import { readSessionToken, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, signSessionToken } from "./token";

/**
 * The current grant, or null.
 *
 * Wrapped in React's `cache` so several components in one render — a layout checking whether to
 * show a sign-out link, a page loading events — verify the token once rather than once each.
 */
export const getGrant = cache(async (): Promise<Grant | null> => {
  const store = await cookies();
  return readSessionToken(store.get(SESSION_COOKIE)?.value);
});

/**
 * The grant, or a redirect to the login page. Call this at the top of anything private.
 *
 * `next` carries where the visitor was heading so they land there after signing in instead of on a
 * generic index.
 */
export async function requireGrant(returnTo?: string): Promise<Grant> {
  const grant = await getGrant();
  if (!grant) redirect(loginUrl(returnTo));
  return grant;
}

export async function startSession(grant: Grant): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, await signSessionToken(grant), {
    httpOnly: true, // no JavaScript can read it, so an XSS bug can't exfiltrate the session
    secure: process.env.NODE_ENV === "production", // off on localhost, which has no HTTPS
    sameSite: "lax", // "strict" would drop the cookie when arriving from an emailed link
    path: "/", // not /friends: the download route lives under /api/friends/*
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/**
 * Login URL with a safe return path.
 *
 * Only same-site absolute paths under `/friends` are preserved. Without this check, `?next=` would
 * be an open redirect: a link to our own login page could bounce someone to an attacker's site
 * with our domain in the address bar on the way.
 */
export function loginUrl(returnTo?: string): string {
  if (!returnTo || !isSafeReturnPath(returnTo)) return "/friends/login";
  return `/friends/login?next=${encodeURIComponent(returnTo)}`;
}

export function isSafeReturnPath(path: string): boolean {
  // Must be a rooted path in the friends section, and must not be protocol-relative (`//host`),
  // which browsers treat as absolute.
  return path.startsWith("/friends") && !path.startsWith("//") && !path.includes("\\");
}

export { SESSION_COOKIE } from "./token";
