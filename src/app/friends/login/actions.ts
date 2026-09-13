"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  checkPassword,
  clearAttempts,
  clientKey,
  isSafeReturnPath,
  recordAttempt,
  startSession,
  type Grant,
} from "@/lib/auth";
import { findEvent, getFriendsManifest } from "@/lib/content";

export type LoginState = { error?: string };

/**
 * Check a password against one event and start a session.
 *
 * Order matters: **rate limit first, then verify**. Verifying first would mean every blocked
 * request still paid for a scrypt derivation, turning the rate limiter into an amplifier for the
 * attack it exists to stop.
 *
 * The event comes from a hidden field the login page set; it is looked up in the manifest here,
 * never trusted from the form — an unknown slug simply has no hash to check against, so it
 * fails like a wrong password (the owner's master password still gets through, as it should).
 */
export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const eventSlug = String(formData.get("event") ?? "");
  const requested = String(formData.get("next") ?? "");

  const key = clientKey(await headers());
  const limit = recordAttempt(key);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterSeconds / 60));
    return { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const manifest = await getFriendsManifest();
  const event = eventSlug ? findEvent(manifest, eventSlug) : undefined;

  const grant = await checkPassword(password, event);
  if (!grant) {
    // One message for wrong-and-empty alike: nothing here should help someone work out whether
    // they're close.
    return { error: "That password doesn't match this event. Ask for the current one." };
  }

  clearAttempts(key);
  await startSession(grant);

  // Where to land: the requested page if it's safe *and* this grant can see it, else the event
  // just unlocked (a friend with a one-event grant has nothing else to see), else the index (the
  // owner's master password). The scope check stops a stale or crafted `?next=` from dropping an
  // event-scoped friend onto another gallery's 404 instead of their own photos.
  if (isSafeReturnPath(requested) && grantCanReach(grant, requested)) redirect(requested);
  if (event) redirect(`/friends/${encodeURIComponent(event.slug)}`);
  redirect("/friends");
}

function grantCanReach(grant: Grant, path: string): boolean {
  if (grant.scope === "all") return true;
  const prefix = `/friends/${encodeURIComponent(grant.scope.event)}`;
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
}
