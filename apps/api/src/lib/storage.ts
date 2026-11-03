import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
  S3ServiceException,
  type S3ClientConfig,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  type PhotoContentType,
  type VideoContentType,
} from "@photo-app/shared";

export interface UploadPost {
  url: string;
  fields: Record<string, string>;
}

export interface UploadTarget {
  key: string;
  contentType: PhotoContentType;
  sizeBytes: number;
}

export interface DownloadTarget {
  key: string;
  /** Saved under this name (FR-DL-2). */
  fileName: string;
}

/** A video's multipart upload (FR-VID-2): its original key and S3's upload ID. */
export interface MultipartUpload {
  key: string;
  uploadId: string;
}

export interface PartToSign {
  partNumber: number;
  /** Exact size of this part; signed into the URL, so S3 refuses any other length. */
  sizeBytes: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * `completed`; `no-such-upload` (completed before, aborted, or expired); `invalid-parts` (a part
 * missing, an ETag that doesn't match, or a part too small).
 */
export type CompleteResult = "completed" | "no-such-upload" | "invalid-parts";

/** The photo bucket as the API needs it. Routes depend on this interface; tests use a fake. */
export interface PhotoStorage {
  /** Pre-signed POST for exactly one original (FR-UP-4, NFR-SEC-6). */
  createUploadPost(target: UploadTarget): Promise<UploadPost>;
  /** Starts a video's multipart upload (FR-VID-2); returns S3's upload ID. */
  createMultipartUpload(target: { key: string; contentType: VideoContentType }): Promise<string>;
  /** Pre-signed `PUT` URL per part, 15 min, each pinned to its exact size (§9). Local signing. */
  createUploadPartUrls(
    upload: MultipartUpload,
    parts: PartToSign[],
  ): Promise<{ partNumber: number; url: string }[]>;
  /** Assembles the parts into the original (parts in any order). */
  completeMultipartUpload(upload: MultipartUpload, parts: UploadedPart[]): Promise<CompleteResult>;
  /** Drops the upload and its parts; one that no longer exists is fine. */
  abortMultipartUpload(upload: MultipartUpload): Promise<void>;
  /** Pre-signed GET that downloads as an attachment, valid for 5 min (FR-DL-1/2). */
  createDownloadUrl(target: DownloadTarget): Promise<string>;
  /** Deletes the objects; keys that don't exist are fine (FR-DEL-1). */
  deleteObjects(keys: string[]): Promise<void>;
  /**
   * Copies an original inside the bucket, bytes and metadata unchanged (FR-SHR-10): a shared photo
   * saved to the recipient's gallery. The new object starts the thumbnail Lambda like an upload.
   */
  copyObject(from: string, to: string): Promise<void>;
  /**
   * Whether the object is in the bucket (6.11: did an abandoned upload's original ever arrive?).
   * Needs `s3:ListBucket` besides `s3:GetObject`: without it S3 answers 403 for a missing key.
   */
  exists(key: string): Promise<boolean>;
  /** The stored size, or null if there is no such object (same permissions as `exists`). */
  objectSize(key: string): Promise<number | null>;
}

/**
 * The S3 client for the API and the purge Lambda. Checksums only where S3 requires them: by
 * default the SDK puts a CRC32 of the (empty) body into pre-signed `UploadPart` URLs, and S3 then
 * rejects the part the browser sends (FR-VID-2).
 */
export function createS3Client(config: S3ClientConfig = {}): S3Client {
  return new S3Client({ ...config, requestChecksumCalculation: "WHEN_REQUIRED" });
}

/** S3 errors by name (the SDK has classes for only some of them). */
const s3ErrorName = (err: unknown) => (err instanceof S3ServiceException ? err.name : undefined);

export function s3PhotoStorage(client: S3Client, bucket: string): PhotoStorage {
  async function objectSize(key: string): Promise<number | null> {
    try {
      const output = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return output.ContentLength ?? 0;
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  }

  return {
    async createUploadPost({ key, contentType, sizeBytes }) {
      // Signing is local (no S3 call). The policy pins key, type and exact size, so the declared
      // size the quota check used is the size that gets stored.
      return createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Fields: {
          "Content-Type": contentType,
          // Lifecycle filters can't match users/*/originals/, so the class is set here (§8.1).
          "x-amz-storage-class": "INTELLIGENT_TIERING",
        },
        Conditions: [
          ["eq", "$Content-Type", contentType],
          ["eq", "$x-amz-storage-class", "INTELLIGENT_TIERING"],
          ["content-length-range", sizeBytes, sizeBytes],
        ],
        Expires: UPLOAD_URL_TTL_SECONDS,
      });
    },

    async createMultipartUpload({ key, contentType }) {
      const output = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          // As for photo uploads (§8.1): lifecycle filters can't match users/*/originals/.
          StorageClass: "INTELLIGENT_TIERING",
        }),
      );
      if (!output.UploadId) throw new Error(`No UploadId for ${key}`);
      return output.UploadId;
    },

    async createUploadPartUrls({ key, uploadId }, parts) {
      return Promise.all(
        parts.map(async ({ partNumber, sizeBytes }) => ({
          partNumber,
          url: await getSignedUrl(
            client,
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              ContentLength: sizeBytes,
            }),
            // The browser sends Content-Length itself; signing it pins the part's size, so the
            // parts together can't exceed the declared size the quota reserved.
            { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(["content-length"]) },
          ),
        })),
      );
    },

    async completeMultipartUpload({ key, uploadId }, parts) {
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              // S3 wants them ascending.
              Parts: [...parts]
                .sort((a, b) => a.partNumber - b.partNumber)
                .map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })),
            },
          }),
        );
        return "completed";
      } catch (err) {
        const name = s3ErrorName(err);
        if (name === "NoSuchUpload") return "no-such-upload";
        if (name === "InvalidPart" || name === "InvalidPartOrder" || name === "EntityTooSmall") {
          return "invalid-parts";
        }
        throw err;
      }
    },

    async abortMultipartUpload({ key, uploadId }) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
        );
      } catch (err) {
        if (s3ErrorName(err) !== "NoSuchUpload") throw err;
      }
    },

    async createDownloadUrl({ key, fileName }) {
      // Local signing again. S3 sends the disposition back because it is part of the signed URL.
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: attachmentDisposition(fileName),
        }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      );
    },

    async deleteObjects(keys) {
      if (keys.length === 0) return;
      const output = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      // DeleteObjects reports per-key failures in the body rather than throwing.
      const failed = output.Errors ?? [];
      if (failed.length > 0) {
        throw new Error(`Failed to delete ${failed.map((e) => `${e.Key} (${e.Code})`).join(", ")}`);
      }
    },

    async copyObject(from, to) {
      // Server-side, so the bytes never pass through the Lambda (one request up to 5 GB; videos
      // are at most 2 GB, FR-VID-1). The storage
      // class is set again, as on upload (§8.1); Content-Type and EXIF come with the object.
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
          Key: to,
          StorageClass: "INTELLIGENT_TIERING",
        }),
      );
    },

    async exists(key) {
      return (await objectSize(key)) !== null;
    },

    objectSize,
  };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `Content-Disposition: attachment` with the original file name (FR-DL-2, RFC 6266): an ASCII
 * `filename` for old clients plus the exact name UTF-8 encoded in `filename*` (RFC 8187).
 */
export function attachmentDisposition(name: string): string {
  // JSON can carry unpaired surrogates, which encodeURIComponent rejects.
  const fileName = name.replace(LONE_SURROGATE, "\uFFFD");
  const fallback = fileName.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
