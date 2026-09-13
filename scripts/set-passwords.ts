/**
 * Push friends' per-event passwords to the Pi (docs/PLAN.md D5).
 *
 *   npm run passwords
 *
 * Reads `friends-passwords.json` at the repo root — gitignored, plaintext, the owner's PC only —
 * and writes an scrypt hash of each password onto the matching event in the friends manifest.
 * The file is the source of truth: an event missing from it has its password removed, so
 * revoking access is deleting a line and re-running.
 *
 *   {
 *     "Monge Graduation": "the passphrase you hand them",
 *     "camping-trip-2026": "another one"
 *   }
 *
 * Keys may be the event's slug or its display name (case-insensitive). Keys starting with `_`
 * are ignored, so the example file's `_comment` can be copied as-is.
 *
 * Why the manifest and not an env var: events are data, not code (invariant 8), and giving a
 * new event a password must not need a Vercel edit and a redeploy. The manifest write goes through
 * `writeFriendsManifest`, so it is backed up and mirrored locally like every other write
 * (invariant 7). Only the hash leaves this machine.
 *
 * Unchanged passwords are left alone (the existing hash still verifies), so re-running is cheap
 * and doesn't churn the manifest.
 */
import { readFile } from "node:fs/promises";

import { hashPassword, verifyPassword } from "../src/lib/auth/password";
import { getFriendsManifest, writeFriendsManifest } from "../src/lib/content";

const FILE = "friends-passwords.json";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Fine if the vars are already exported; storageConfig() names what's missing otherwise.
}

async function main() {
  const entries = await readPasswordFile();
  const manifest = await getFriendsManifest();

  if (manifest.events.length === 0) {
    console.log("The friends manifest has no events yet. Upload one first: npm run upload -- <files> --event \"Name\"");
    return;
  }

  const wanted = new Map<string, string>(); // slug → password
  const unknown: string[] = [];
  for (const [name, password] of entries) {
    const event = manifest.events.find(
      (e) => e.slug === name || e.slug === name.toLowerCase() || e.label.toLowerCase() === name.toLowerCase(),
    );
    if (!event) {
      unknown.push(name);
      continue;
    }
    if (password.length < 8) {
      throw new Error(`Password for "${event.label}" is under 8 characters. Pick something longer.`);
    }
    if (wanted.has(event.slug)) {
      throw new Error(`"${event.label}" appears twice in ${FILE} (as slug and as name?). Keep one.`);
    }
    wanted.set(event.slug, password);
  }

  if (unknown.length > 0) {
    const known = manifest.events.map((e) => `  ${e.slug}  ("${e.label}")`).join("\n");
    throw new Error(
      `No event matches ${unknown.map((n) => `"${n}"`).join(", ")} in ${FILE}.\nKnown events:\n${known}`,
    );
  }

  let changed = 0;
  for (const event of manifest.events) {
    const password = wanted.get(event.slug);

    if (!password) {
      if (event.passwordHash) {
        delete event.passwordHash;
        changed++;
        console.log(`  ${event.slug}: password removed (not in ${FILE})`);
      } else {
        console.log(`  ${event.slug}: no password — nobody can sign in to it yet`);
      }
      continue;
    }

    if (event.passwordHash && (await verifyPassword(password, event.passwordHash))) {
      console.log(`  ${event.slug}: unchanged`);
      continue;
    }

    const had = Boolean(event.passwordHash);
    event.passwordHash = await hashPassword(password);
    changed++;
    console.log(`  ${event.slug}: password ${had ? "changed" : "set"}`);
  }

  if (changed === 0) {
    console.log("\nNothing to write — the Pi already matches the file.");
    return;
  }

  await writeFriendsManifest(manifest);
  console.log(`\nFriends manifest written: ${changed} event(s) updated. Live immediately — no deploy needed.`);
  console.log("Note: friends already signed in keep their session (up to 7 days) until they sign out.");
}

async function readPasswordFile(): Promise<[string, string][]> {
  let raw: string;
  try {
    raw = await readFile(FILE, "utf8");
  } catch {
    throw new Error(
      `${FILE} not found in the project root.\n` +
        `Copy friends-passwords.example.json to ${FILE} and fill it in — it is gitignored.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${FILE} must be an object of "event": "password" pairs.`);
  }

  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("_")) continue;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${FILE}: the password for "${key}" must be a non-empty string.`);
    }
    entries.push([key.trim(), value]);
  }
  return entries;
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
