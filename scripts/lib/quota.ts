/**
 * The private-bucket size cap (docs/PLAN.md D3, hybrid layout).
 *
 * The private bucket lives on Cloudflare R2, which is free up to 10 GB and then bills. Cloudflare
 * offers no "stop at free" switch, so the cap is enforced here instead — and because the upload
 * CLI is the only thing that ever writes to that bucket, refusing here is a real ceiling, not a
 * notification after the fact. Every CLI run that touches the bucket prints how much room is left.
 *
 * Sizes are decimal GB (1 GB = 1,000,000,000 bytes), the unit providers bill in.
 */
import { privateStorageCapBytes, type StorageProvider } from "../../src/lib/storage";

export async function privateUsageBytes(storage: StorageProvider): Promise<number> {
  const objects = await storage.list("private", "");
  return objects.reduce((sum, object) => sum + object.bytes, 0);
}

/**
 * Throw if adding `incomingBytes` to the private bucket would pass the cap. Returns the current
 * usage so the caller can report it. A `null` cap means unlimited (the Pi).
 */
export async function assertPrivateRoom(
  storage: StorageProvider,
  incomingBytes: number,
  what: string,
): Promise<number> {
  const cap = privateStorageCapBytes();
  const used = await privateUsageBytes(storage);
  if (cap !== null && used + incomingBytes > cap) {
    throw new Error(
      `Private storage is full: ${gb(used)} GB used + ${gb(incomingBytes)} GB for ${what} would pass the ` +
        `${gb(cap)} GB cap.\nFree room with: npm run remove-event -- "Old Event"   (originals stay on your PC and the Pi)\n` +
        `Or raise PRIVATE_STORAGE_CAP_GB in .env.local if you're happy to pay for more.`,
    );
  }
  return used;
}

export function describePrivateUsage(usedBytes: number): string {
  const cap = privateStorageCapBytes();
  if (cap === null) return `Private storage: ${gb(usedBytes)} GB used (no cap).`;
  const left = Math.max(0, cap - usedBytes);
  const warn = left < cap * 0.15 ? "  ← getting full" : "";
  return `Private storage: ${gb(usedBytes)} GB of ${gb(cap)} GB used, ${gb(left)} GB left.${warn}`;
}

function gb(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(2);
}
