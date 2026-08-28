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
} from "@/lib/auth";

export type LoginState = { error?: string };

/**
 * Check a password and start a session.
 *
 * Order matters: **rate limit first, then verify**. Verifying first would mean every blocked
 * request still paid for a scrypt derivation, turning the rate limiter into an amplifier for the
 * attack it exists to stop.
 */
export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const requested = String(formData.get("next") ?? "");
  const destination = isSafeReturnPath(requested) ? requested : "/friends";

  const key = clientKey(await headers());
  const limit = recordAttempt(key);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterSeconds / 60));
    return { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  const grant = await checkPassword(password);
  if (!grant) {
    // One message for wrong-and-empty alike: nothing here should help someone work out whether
    // they're close, and there is only one password to be wrong about.
    return { error: "That password doesn't match. Ask for the current one." };
  }

  clearAttempts(key);
  await startSession(grant);
  redirect(destination);
}
