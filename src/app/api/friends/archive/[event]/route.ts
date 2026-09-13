/**
 * `GET /api/friends/archive/[event]` — "Download all" for one event.
 *
 * Same shape as the per-photo route: verify the grant, then 302 to a short-lived presigned URL
 * for the zip the CLI built at upload time (docs/PLAN.md D6). The zip is a stored object, so
 * a multi-GB download costs Vercel one redirect (invariant 6). No archive yet means 404 — the
 * page doesn't render the button in that case, so this only answers a hand-typed URL.
 */
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";

import { grantAllowsEvent, requireGrant } from "@/lib/auth";
import { findEvent, getFriendsManifest } from "@/lib/content";
import { getStorage } from "@/lib/storage";

type Props = { params: Promise<{ event: string }> };

export async function GET(_request: Request, { params }: Props) {
  const grant = await requireGrant();

  const { event: eventSlug } = await params;
  const manifest = await getFriendsManifest();
  const event = findEvent(manifest, eventSlug);
  // Wrong-scoped grants get the same 404 as a missing event, so nothing here confirms that
  // another event exists (same reasoning as the event page).
  if (!event?.archive || !grantAllowsEvent(grant, event.slug)) notFound();

  const storage = await getStorage();
  const url = await storage.presignGet("private", event.archive.key, {
    downloadFilename: `${event.label}.zip`,
  });

  return NextResponse.redirect(url, 302);
}
