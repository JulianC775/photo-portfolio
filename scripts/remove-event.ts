/**
 * Remove one event from the friends section, freeing its space in the private bucket.
 *
 *   npm run remove-event -- "Camping Trip 2026"     # by display name or slug
 *
 * Deletes every object under `friends/<slug>/` (originals, previews, the zip) and drops the event
 * and its photos from the manifest. Nothing is lost: the originals are on your PC (the archive of
 * record) and can be re-uploaded any time with `npm run upload`. Exists because the private bucket
 * has a size cap (scripts/lib/quota.ts) and this is how you make room under it.
 *
 * Asks for confirmation. Remove the event's line from friends-passwords.json afterwards, or
 * `npm run passwords` will complain it can't find the event.
 */
import { createInterface } from "node:readline/promises";

import { getFriendsManifestDirect, writeFriendsManifest } from "../src/lib/content";
import { getStorage } from "../src/lib/storage";
import { describePrivateUsage, privateUsageBytes } from "./lib/quota";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Fine if the vars are already exported.
}

async function main() {
  const name = process.argv.slice(2).join(" ").trim();
  if (!name) {
    console.error('Usage: npm run remove-event -- "Event Name"');
    process.exitCode = 1;
    return;
  }

  const manifest = await getFriendsManifestDirect();
  const event = manifest.events.find(
    (e) => e.slug === name || e.slug === name.toLowerCase() || e.label.toLowerCase() === name.toLowerCase(),
  );
  if (!event) {
    const known = manifest.events.map((e) => `  ${e.slug}  ("${e.label}")`).join("\n");
    throw new Error(`No event matches "${name}".\nKnown events:\n${known}`);
  }

  const storage = await getStorage();
  const prefix = `friends/${event.slug}/`;
  const objects = await storage.list("private", prefix);
  const bytes = objects.reduce((sum, o) => sum + o.bytes, 0);
  const photoCount = manifest.photos.filter((p) => p.event === event.slug).length;

  console.log(
    `"${event.label}": ${photoCount} photo(s), ${objects.length} object(s), ${(bytes / 1e9).toFixed(2)} GB in the private bucket.`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Delete them from storage and the manifest? Originals on your PC are untouched. [y/N]: ")).trim();
  rl.close();
  if (answer.toLowerCase() !== "y") {
    console.log("Nothing changed.");
    return;
  }

  // Manifest first: the moment it no longer lists the event, the site can't hand out a link to
  // an object that is about to vanish. A crash between the two leaves orphaned objects, which
  // `list` will still count against the cap — re-running this command cleans them up.
  manifest.events = manifest.events.filter((e) => e.slug !== event.slug);
  manifest.photos = manifest.photos.filter((p) => p.event !== event.slug);
  await writeFriendsManifest(manifest);
  console.log("Manifest written.");

  await storage.remove("private", objects.map((o) => o.key));
  console.log(`Deleted ${objects.length} object(s).`);
  console.log(describePrivateUsage(await privateUsageBytes(storage)));
  console.log(`\nNow delete the "${event.label}" line from friends-passwords.json.`);
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
