/**
 * Optimistic guard for the friends section.
 *
 * Called `proxy.ts` because Next 16 renamed Middleware to Proxy; same mechanism, same
 * `config.matcher`.
 *
 * **This is not the security boundary.** The Next docs are explicit that Proxy should be used for
 * cheap optimistic checks, not as the authorisation layer — and it's easy to see why: it runs
 * before the page, on the Edge, with no access to the data being protected. Its job here is purely
 * that an unauthenticated visitor gets sent to the login form instead of briefly rendering a
 * private page shell. `requireGrant()` inside each page and route handler is what actually protects
 * the photos, and it runs regardless of what happened here.
 *
 * It does verify the signature rather than just checking the cookie exists, because that's a few
 * microseconds of local HMAC and it means an expired session redirects to login cleanly instead of
 * being noticed one layer deeper.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { readSessionToken, SESSION_COOKIE } from "@/lib/auth/token";

/** The one path inside the section that must stay reachable without a session. */
const LOGIN_PATH = "/friends/login";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const grant = await readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === LOGIN_PATH) {
    // Already signed in? Skip the form. Anything else about the login page is the page's business.
    if (grant) return NextResponse.redirect(new URL("/friends", request.url));
    return NextResponse.next();
  }

  if (!grant) {
    const login = new URL(LOGIN_PATH, request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  /*
   * `/friends` itself plus everything under it. `/api/friends/*` is listed too so the download
   * route gets the same treatment once it exists — a 302 to login is a friendlier answer to an
   * expired session than whatever a fetch would otherwise get.
   */
  matcher: ["/friends", "/friends/:path*", "/api/friends/:path*"],
};
