"use server";

import { redirect } from "next/navigation";

import { endSession } from "@/lib/auth";

/**
 * Sign out. A Server Action rather than a link, because clearing a session is a state change: a
 * `GET` that logs you out can be triggered by any page that embeds the URL as an image.
 */
export async function signOut() {
  await endSession();
  redirect("/");
}
