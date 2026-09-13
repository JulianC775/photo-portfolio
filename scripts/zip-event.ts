/**
 * Rebuild one event's "Download all" zip by hand.
 *
 *   npm run zip -- "Monge Graduation"       # by display name or slug
 *
 * `npm run upload` already does this after every friends upload, so this is for events uploaded
 * before archives existed, or for a rebuild after fixing something in the bucket.
 */
import { getFriendsManifest, writeFriendsManifest } from "../src/lib/content";
import { getStorage } from "../src/lib/storage";
import { buildEventArchive } from "./lib/archive";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Fine if the vars are already exported.
}

async function main() {
  const name = process.argv.slice(2).join(" ").trim();
  if (!name) {
    console.error('Usage: npm run zip -- "Event Name"');
    process.exitCode = 1;
    return;
  }

  const manifest = await getFriendsManifest();
  const event = manifest.events.find(
    (e) => e.slug === name || e.slug === name.toLowerCase() || e.label.toLowerCase() === name.toLowerCase(),
  );
  if (!event) {
    const known = manifest.events.map((e) => `  ${e.slug}  ("${e.label}")`).join("\n");
    throw new Error(`No event matches "${name}".\nKnown events:\n${known}`);
  }

  console.log(`Building archive for "${event.label}"…`);
  const storage = await getStorage();
  event.archive = await buildEventArchive(storage, manifest, event);
  await writeFriendsManifest(manifest);

  const mb = (event.archive.bytes / 1_000_000).toFixed(0);
  console.log(`\nArchive written: ${event.archive.photoCount} photos, ${mb} MB. "Download all" is live.`);
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
