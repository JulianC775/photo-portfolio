/**
 * `GET /api/friends/download/[id]` — the only place a friend's full-resolution original leaves
 * the private bucket (docs/PLAN.md D6).
 *
 * Verifies the session grant, then **302-redirects** to a short-lived pre-signed URL carrying
 * `Content-Disposition: attachment; filename="…"`. The bytes never pass through Vercel — no
 * function duration or response size limit applies (invariant 6).
 *
 * Must stay reachable as a real `<a href>` navigation, not a `fetch()` + blob download: iOS
 * Safari is unreliable with JS-triggered downloads (D6), and a plain anchor tap survives the
 * redirect chain because the final response's headers — not the first hop's — are what the
 * browser acts on.
 */
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";

import { grantAllowsEvent, requireGrant } from "@/lib/auth";
import { findFriendsPhoto, getFriendsManifest } from "@/lib/content";
import { getStorage } from "@/lib/storage";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Props) {
  // The real security boundary (proxy.ts is only an optimistic redirect — see its comment).
  const grant = await requireGrant();

  const { id } = await params;
  const manifest = await getFriendsManifest();
  const photo = findFriendsPhoto(manifest, id);
  if (!photo) notFound();

  // Today's shared password always grants `{ scope: 'all' }`, so this never trips yet — but it's
  // the one line that makes per-event passwords (D5) a config change instead of a rewrite.
  if (!grantAllowsEvent(grant, photo.event)) {
    return NextResponse.json({ error: "not authorised for this event" }, { status: 403 });
  }

  const storage = await getStorage();
  const url = await storage.presignGet("private", photo.original.key, {
    downloadFilename: photo.filename,
  });

  return NextResponse.redirect(url, 302);
}
