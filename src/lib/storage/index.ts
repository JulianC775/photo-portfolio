/**
 * The storage boundary: the only place in the app that knows *what* is storing the bytes.
 *
 * Today that's Garage on a Raspberry Pi behind a Cloudflare Tunnel (docs/PLAN.md D3). The
 * documented fallback is a hybrid setup with the public bucket on Cloudflare R2. Because both
 * speak the S3 API and everything above this module talks to `StorageProvider`, that move is
 * config plus one file — no page or component changes. Don't pre-build for it; just don't
 * design against it.
 *
 * Nothing here imports the AWS SDK. `./s3` does, and is loaded lazily by `getStorage()`, which
 * keeps the SDK out of any bundle that only needs `publicMediaUrl()`.
 */
import type { Readable } from "node:stream";
import { z } from "zod";

/**
 * Buckets are referred to by role, not by name. Callers say "the private one"; which actual
 * bucket that is stays configuration (`STORAGE_BUCKET_PRIVATE`).
 */
export type BucketRole = "public" | "private";

export interface PutOptions {
  /** Sent as `Content-Type`. Required — a wrong or missing type breaks in-browser rendering. */
  contentType: string;
  /**
   * Sent as `Cache-Control`. Public derivative keys are content-addressed, so they get a long
   * `immutable` max-age; manifests get a short one; **private objects must never be cached**
   * (D3), which is why this is explicit at every call site rather than defaulted.
   */
  cacheControl?: string;
}

/**
 * The three cache policies this project uses, in one place because getting them wrong is either
 * a stale gallery or a leaked private URL.
 */
export const CACHE_CONTROL = {
  /**
   * Media derivatives. Their keys are content-addressed — a re-processed photo gets a new key —
   * so they can be cached forever (D3).
   */
  immutable: "public, max-age=31536000, immutable",
  /**
   * Manifests. Short, because the *object* is mutable even though media isn't. Freshness comes
   * from the revalidate ping, not from this; the TTL is only the fallback (D2).
   */
  manifest: "public, max-age=60",
  /** Private objects. Presigned URLs must never sit in a shared cache (D3). */
  private: "private, no-store",
} as const;

export interface PresignOptions {
  /** Seconds until the URL stops working. Keep short — these are unauthenticated once issued. */
  expiresIn?: number;
  /**
   * When set, the presigned URL carries `Content-Disposition: attachment; filename="…"`, so
   * the browser saves the file instead of previewing it (D6). Baked into the signature, so a
   * friend can't tamper with it.
   */
  downloadFilename?: string;
}

/**
 * A stream is allowed so the CLI can upload a multi-gigabyte timelapse without reading it into
 * memory. The S3 implementation uses `@aws-sdk/lib-storage`, which switches to multipart on
 * its own once the body is large enough (D4 step 5).
 */
export type PutBody = Uint8Array | string | Readable;

export interface StorageProvider {
  /** Object body as UTF-8 text, or `null` if the key doesn't exist. Only used for manifests. */
  getText(bucket: BucketRole, key: string): Promise<string | null>;
  /**
   * Object body as a Node stream, or `null` if the key doesn't exist. CLI only: it exists so the
   * per-event zip can be built from originals already in the bucket without holding any of them
   * in memory — the originals on the owner's PC may be in a folder the CLI was never pointed at.
   */
  getStream(bucket: BucketRole, key: string): Promise<Readable | null>;
  put(bucket: BucketRole, key: string, body: PutBody, options: PutOptions): Promise<void>;
  /** A short-lived URL granting read access to one private object. */
  presignGet(bucket: BucketRole, key: string, options?: PresignOptions): Promise<string>;
  /** Every object under a prefix (`""` for the whole bucket), with sizes. CLI only. */
  list(bucket: BucketRole, prefix: string): Promise<{ key: string; bytes: number }[]>;
  /** Delete objects by key. Missing keys are not an error. CLI only. */
  remove(bucket: BucketRole, keys: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const flag = z
  .string()
  .optional()
  .transform((v) => v !== "false");

const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.url(),
  STORAGE_REGION: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  /** Garage and MinIO address buckets by path, unlike R2/S3 which use the subdomain (D3). */
  STORAGE_FORCE_PATH_STYLE: flag,
  STORAGE_BUCKET_PUBLIC: z.string().min(1),
  STORAGE_BUCKET_PRIVATE: z.string().min(1),

  /**
   * The private bucket on a different provider (D3, hybrid). When `PRIVATE_STORAGE_ENDPOINT` is
   * set, the private bucket is reached with these instead of the `STORAGE_*` connection above;
   * unset, both buckets share one connection as before. Today: originals and zips on Cloudflare
   * R2, because a friend downloading 1.4 GB from the Pi is throttled by the house's upload line
   * (~1 MB/s measured), and R2 egress is free and fast from anywhere.
   */
  PRIVATE_STORAGE_ENDPOINT: z.url().optional(),
  PRIVATE_STORAGE_REGION: z.string().min(1).optional(),
  PRIVATE_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  PRIVATE_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  PRIVATE_STORAGE_FORCE_PATH_STYLE: flag,
  /**
   * CLI-enforced ceiling on the private bucket, in GB (decimal, like the provider bills). Defaults
   * to 9.5 when the private bucket has its own connection — under R2's 10 GB free tier — and to
   * unlimited otherwise (the Pi has a terabyte). The upload CLI is the only writer, so refusing
   * there is a real cap, not an alert: it cannot cost money it wasn't told it could.
   */
  PRIVATE_STORAGE_CAP_GB: z.coerce.number().positive().optional(),
});

/** One S3 connection: endpoint + credentials. A provider holds one per bucket role. */
export type Connection = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type StorageConfig = z.infer<typeof storageEnvSchema>;

/**
 * Validated storage config, or a thrown error naming exactly what's missing.
 *
 * Deliberately read on first use rather than at module load. The site is deployed to Vercel
 * before the Pi exists (M0 → M1), and pages that never touch storage — About, the home shell —
 * must keep building and rendering with these vars unset. Module-level validation would turn
 * "storage isn't configured yet" into "the whole app fails to boot".
 */
export function storageConfig(): StorageConfig {
  const parsed = storageEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = Object.entries(z.flattenError(parsed.error).fieldErrors)
      .map(([name, errors]) => `  ${name}: ${errors?.join(", ")}`)
      .join("\n");
    throw new Error(`Object storage is not configured.\n${problems}\nSee .env.example.`);
  }
  return parsed.data;
}

/**
 * Whether storage is configured, without throwing.
 *
 * Exists so a page can show "the backend isn't connected yet" in development instead of an error
 * page, while production still fails loudly. Never use it to decide whether to *skip* a security
 * check — it answers a deployment question, not an authorisation one.
 */
export function isStorageConfigured(): boolean {
  return storageEnvSchema.safeParse(process.env).success;
}

export function bucketName(role: BucketRole, config = storageConfig()): string {
  return role === "public" ? config.STORAGE_BUCKET_PUBLIC : config.STORAGE_BUCKET_PRIVATE;
}

/** The connection a bucket role uses. Falls back to the shared `STORAGE_*` one. */
export function connectionFor(role: BucketRole, config = storageConfig()): Connection {
  if (role === "private" && config.PRIVATE_STORAGE_ENDPOINT) {
    const missing = (
      [
        ["PRIVATE_STORAGE_REGION", config.PRIVATE_STORAGE_REGION],
        ["PRIVATE_STORAGE_ACCESS_KEY_ID", config.PRIVATE_STORAGE_ACCESS_KEY_ID],
        ["PRIVATE_STORAGE_SECRET_ACCESS_KEY", config.PRIVATE_STORAGE_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `PRIVATE_STORAGE_ENDPOINT is set but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not. See .env.example.`,
      );
    }
    return {
      endpoint: config.PRIVATE_STORAGE_ENDPOINT,
      region: config.PRIVATE_STORAGE_REGION!,
      accessKeyId: config.PRIVATE_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: config.PRIVATE_STORAGE_SECRET_ACCESS_KEY!,
      forcePathStyle: config.PRIVATE_STORAGE_FORCE_PATH_STYLE,
    };
  }
  return {
    endpoint: config.STORAGE_ENDPOINT,
    region: config.STORAGE_REGION,
    accessKeyId: config.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
  };
}

/** Whether the private bucket lives on its own provider (so its size is worth capping). */
export function privateBucketIsSeparate(config = storageConfig()): boolean {
  return Boolean(config.PRIVATE_STORAGE_ENDPOINT);
}

/** The private-bucket ceiling in bytes, or `null` for unlimited. See the schema note. */
export function privateStorageCapBytes(config = storageConfig()): number | null {
  const gb = config.PRIVATE_STORAGE_CAP_GB ?? (privateBucketIsSeparate(config) ? 9.5 : null);
  return gb === null ? null : Math.round(gb * 1_000_000_000);
}

/**
 * Browser-facing URL for an object in the *public* bucket.
 *
 * Separate from `StorageProvider` on purpose: this is a delivery-path concern, not a storage
 * one. `NEXT_PUBLIC_MEDIA_URL` points at the media domain (through Cloudflare, edge-cached),
 * so these bytes never touch Vercel — invariant 6. Public objects are fetched by plain URL,
 * never presigned; only the private bucket needs signatures.
 */
export function publicMediaUrl(key: string): string {
  // Defaults to production, like `site.url`. Vercel's "sensitive" env-var setting refuses any
  // NEXT_PUBLIC_-prefixed name, so the deployed site can't be given this value at all — and it
  // isn't a secret, just the public media domain. Local dev overrides it with the seed server.
  const base = process.env.NEXT_PUBLIC_MEDIA_URL ?? "https://media.catellolens.com/portfolio-public";
  return `${base.replace(/\/+$/, "")}/${key.replace(/^\/+/, "")}`;
}

// ---------------------------------------------------------------------------
// Provider instance
// ---------------------------------------------------------------------------

let cached: StorageProvider | undefined;

/**
 * The process-wide provider. Cached because the S3 client holds a connection pool that is
 * worth reusing across requests in a warm serverless instance.
 */
export async function getStorage(): Promise<StorageProvider> {
  if (!cached) {
    const { createS3Storage } = await import("./s3");
    cached = createS3Storage(storageConfig());
  }
  return cached;
}
