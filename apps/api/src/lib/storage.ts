import type { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { UPLOAD_URL_TTL_SECONDS, type AllowedContentType } from "@photo-app/shared";

export interface UploadPost {
  url: string;
  fields: Record<string, string>;
}

export interface UploadTarget {
  key: string;
  contentType: AllowedContentType;
  sizeBytes: number;
}

/**
 * The photo bucket as the API needs it. Routes depend on this interface; tests use a fake.
 * 5.8 (download URL) and 5.9 (delete objects) extend it.
 */
export interface PhotoStorage {
  /** Pre-signed POST for exactly one original (FR-UP-4, NFR-SEC-6). */
  createUploadPost(target: UploadTarget): Promise<UploadPost>;
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
  };
}
