/**
 * `StorageProvider` over the S3 API — the only file in the project that imports an S3 client.
 *
 * Written against plain S3 semantics, not Garage-specific behaviour, so the same code works
 * against MinIO, R2 or real S3 (docs/PLAN.md D3). The one deployment-specific detail is
 * path-style addressing, and that is a config flag.
 */
import type { Readable } from "node:stream";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  bucketName,
  connectionFor,
  type BucketRole,
  type PutBody,
  type PutOptions,
  type StorageConfig,
  type StorageProvider,
} from "./index";

/** Presigned download links live just long enough to click (D6: "short-lived"). */
const DEFAULT_PRESIGN_SECONDS = 300;

export function createS3Storage(config: StorageConfig): StorageProvider {
  // One client per bucket role. They are the same object when both roles share a connection
  // (the original all-on-the-Pi setup) and different ones in the hybrid layout (D3) — nothing
  // above this line knows or cares which.
  const clients = new Map<string, S3Client>();
  const clientFor = (role: BucketRole): S3Client => {
    const connection = connectionFor(role, config);
    const id = `${connection.endpoint}|${connection.accessKeyId}`;
    let client = clients.get(id);
    if (!client) {
      client = new S3Client({
        endpoint: connection.endpoint,
        region: connection.region,
        forcePathStyle: connection.forcePathStyle,
        credentials: {
          accessKeyId: connection.accessKeyId,
          secretAccessKey: connection.secretAccessKey,
        },
      });
      clients.set(id, client);
    }
    return client;
  };

  const bucket = (role: BucketRole) => bucketName(role, config);

  return {
    async getText(role, key) {
      try {
        const response = await clientFor(role).send(
          new GetObjectCommand({ Bucket: bucket(role), Key: key }),
        );
        // transformToString is provided by the SDK's stream mixin and handles the Node/web
        // stream difference for us.
        return (await response.Body?.transformToString()) ?? null;
      } catch (error) {
        // A missing manifest is a normal state before the first upload, so it is a `null`, not
        // a throw. Some S3 implementations answer 404 without the typed error, hence both checks.
        if (error instanceof NoSuchKey || isNotFound(error)) return null;
        throw error;
      }
    },

    async getStream(role, key) {
      try {
        const response = await clientFor(role).send(
          new GetObjectCommand({ Bucket: bucket(role), Key: key }),
        );
        // In Node the SDK's Body is an IncomingMessage, which is a Readable. The cast is the
        // Node/web-stream union collapsing to the runtime this code only ever runs in (CLI).
        return (response.Body as Readable | undefined) ?? null;
      } catch (error) {
        if (error instanceof NoSuchKey || isNotFound(error)) return null;
        throw error;
      }
    },

    async put(role, key, body: PutBody, options: PutOptions) {
      // `Upload` rather than `PutObjectCommand` for every write, including small manifests:
      // one code path, and it transparently switches to multipart for large originals.
      const upload = new Upload({
        client: clientFor(role),
        params: {
          Bucket: bucket(role),
          Key: key,
          Body: body,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
        },
      });
      await upload.done();
    },

    async presignGet(role, key, options = {}) {
      const command = new GetObjectCommand({
        Bucket: bucket(role),
        Key: key,
        // Set on the *presign*, so it is covered by the signature and the browser saves the
        // file under its original name rather than the object key (D6).
        ResponseContentDisposition: options.downloadFilename
          ? `attachment; filename="${sanitiseFilename(options.downloadFilename)}"`
          : undefined,
      });
      return getSignedUrl(clientFor(role), command, {
        expiresIn: options.expiresIn ?? DEFAULT_PRESIGN_SECONDS,
      });
    },

    async list(role, prefix) {
      const found: { key: string; bytes: number }[] = [];
      let token: string | undefined;
      do {
        const page = await clientFor(role).send(
          new ListObjectsV2Command({ Bucket: bucket(role), Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) found.push({ key: object.Key, bytes: object.Size ?? 0 });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return found;
    },

    async remove(role, keys) {
      // DeleteObjects takes at most 1000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const result = await clientFor(role).send(
          new DeleteObjectsCommand({
            Bucket: bucket(role),
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (result.Errors?.length) {
          const first = result.Errors[0];
          throw new Error(`Failed to delete ${result.Errors.length} object(s): ${first.Key} — ${first.Message}`);
        }
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 404;
}

/**
 * Header values can't contain quotes, CR or LF — an unescaped one would let a filename split
 * the header. Filenames come from the owner's disk, not from users, but this is one line.
 */
function sanitiseFilename(filename: string): string {
  return filename.replace(/[\r\n"\\]/g, "_");
}
