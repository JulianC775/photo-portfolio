/**
 * `StorageProvider` over the S3 API — the only file in the project that imports an S3 client.
 *
 * Written against plain S3 semantics, not Garage-specific behaviour, so the same code works
 * against MinIO, R2 or real S3 (docs/PLAN.md D3). The one deployment-specific detail is
 * path-style addressing, and that is a config flag.
 */
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  bucketName,
  type BucketRole,
  type PutBody,
  type PutOptions,
  type StorageConfig,
  type StorageProvider,
} from "./index";

/** Presigned download links live just long enough to click (D6: "short-lived"). */
const DEFAULT_PRESIGN_SECONDS = 300;

export function createS3Storage(config: StorageConfig): StorageProvider {
  const client = new S3Client({
    endpoint: config.STORAGE_ENDPOINT,
    region: config.STORAGE_REGION,
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
    },
  });

  const bucket = (role: BucketRole) => bucketName(role, config);

  return {
    async getText(role, key) {
      try {
        const response = await client.send(
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

    async put(role, key, body: PutBody, options: PutOptions) {
      // `Upload` rather than `PutObjectCommand` for every write, including small manifests:
      // one code path, and it transparently switches to multipart for large originals.
      const upload = new Upload({
        client,
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
      return getSignedUrl(client, command, {
        expiresIn: options.expiresIn ?? DEFAULT_PRESIGN_SECONDS,
      });
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
