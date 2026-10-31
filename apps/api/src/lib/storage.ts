import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  type AllowedContentType,
} from "@photo-app/shared";

export interface UploadPost {
  url: string;
  fields: Record<string, string>;
}

export interface UploadTarget {
  key: string;
  contentType: AllowedContentType;
  sizeBytes: number;
}

export interface DownloadTarget {
  key: string;
  /** Saved under this name (FR-DL-2). */
  fileName: string;
}

/** The photo bucket as the API needs it. Routes depend on this interface; tests use a fake. */
export interface PhotoStorage {
  /** Pre-signed POST for exactly one original (FR-UP-4, NFR-SEC-6). */
  createUploadPost(target: UploadTarget): Promise<UploadPost>;
  /** Pre-signed GET that downloads as an attachment, valid for 5 min (FR-DL-1/2). */
  createDownloadUrl(target: DownloadTarget): Promise<string>;
  /** Deletes the objects; keys that don't exist are fine (FR-DEL-1). */
  deleteObjects(keys: string[]): Promise<void>;
  /**
   * Copies an original inside the bucket, bytes and metadata unchanged (FR-SHR-10): a shared photo
   * saved to the recipient's gallery. The new object starts the thumbnail Lambda like an upload.
   */
  copyObject(from: string, to: string): Promise<void>;
}

export function s3PhotoStorage(client: S3Client, bucket: string): PhotoStorage {
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
      // Server-side, so the bytes never pass through the Lambda (≤ 50 MB, one request). The storage
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
