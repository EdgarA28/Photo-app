import { z } from "zod";
import { GOOGLE_IMPORT_CALLBACK_PATH, MAX_FILE_NAME_LENGTH } from "../constants";
import { idSchema, isoDateTimeSchema, userIdSchema } from "./common";
import { photoContentTypeSchema } from "./photos";

/**
 * Import from Google Photos (13.5; FR-IMP-1–6 §6.9, §9 `/imports`, §10.1 import worker, §11.5).
 * The user picks photos in Google's Photos Picker; the backend copies the originals into S3.
 */

/** Import IDs are ULIDs, like every other ID the app makes. */
export const importIdSchema = idSchema;

/**
 * picking → listing → copying → done, or cancelled (user, FR-IMP-5) / expired (Google's token or
 * Picker session ran out first). The last three are final.
 */
export const IMPORT_STATUSES = [
  "picking",
  "listing",
  "copying",
  "done",
  "cancelled",
  "expired",
] as const;
export const importStatusSchema = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof importStatusSchema>;

export const FINAL_IMPORT_STATUSES: readonly ImportStatus[] = ["done", "cancelled", "expired"];
export const isFinalImportStatus = (status: ImportStatus) => FINAL_IMPORT_STATUSES.includes(status);

/**
 * Why a picked photo was not imported (§10.1 permanent errors, FR-IMP-3/5). Photos of a type the
 * app doesn't take (videos included, FR-VID-10) are `skipped`, not failed.
 */
export const IMPORT_FAILURE_CODES = [
  "TOO_LARGE",
  "QUOTA_EXCEEDED",
  "NOT_FOUND",
  "EXPIRED",
] as const;
export const importFailureCodeSchema = z.enum(IMPORT_FAILURE_CODES);
export type ImportFailureCode = z.infer<typeof importFailureCodeSchema>;

/**
 * A Google Photos media item ID. Opaque to us, but it ends up in a DynamoDB sort key (upload claim,
 * FR-IMP-6), so only URL-safe characters are let through.
 */
export const googleMediaItemIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,512}$/, "Invalid media item ID");

/**
 * Upload claim of one imported photo (§8.2, FR-IMP-6): a redelivered `copy` message finds the
 * photo its first delivery created instead of making a second one.
 */
export const importClaimId = (importId: string, mediaItemId: string) =>
  `gp-${importId}-${mediaItemId}`;

/** RFC 7636 code verifier: 43–128 unreserved characters. */
export const pkceCodeVerifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9._~-]{43,128}$/, "Invalid code verifier");

/**
 * The redirect URI the browser used, passed on to Google's token exchange (it must match). Only
 * the callback route on an http(s) origin; the API also checks the origin against its own list.
 */
export const importRedirectUriSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  // Zod still runs refinements after the URL check failed, so a non-URL must not throw here.
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.pathname === GOOGLE_IMPORT_CALLBACK_PATH &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}, `Must be the app's ${GOOGLE_IMPORT_CALLBACK_PATH} URL`);

/** POST /imports/google (FR-IMP-1): the Google authorization code from the consent redirect. */
export const startGoogleImportRequestSchema = z.object({
  code: z.string().min(1).max(2048),
  codeVerifier: pkceCodeVerifierSchema,
  redirectUri: importRedirectUriSchema,
});
export type StartGoogleImportRequest = z.infer<typeof startGoogleImportRequestSchema>;

/** 201 of POST /imports/google. The app opens `pickerUri + "/autoclose"` from a tap (§11.5). */
export const startGoogleImportResponseSchema = z.object({
  importId: importIdSchema,
  pickerUri: z.url({ protocol: /^https$/ }),
  /** When the Picker session (and Google's token) runs out. */
  expiresAt: isoDateTimeSchema,
});
export type StartGoogleImportResponse = z.infer<typeof startGoogleImportResponseSchema>;

/** GET /imports/{importId}: progress and summary (FR-IMP-5). Counts are photos, not bytes. */
export const importSchema = z.object({
  status: importStatusSchema,
  /** Photos to copy; 0 until the picked items are listed. */
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Picked items the app doesn't take (videos and other types). */
  skipped: z.number().int().nonnegative(),
  failedReasons: z.partialRecord(importFailureCodeSchema, z.number().int().positive()),
});
export type Import = z.infer<typeof importSchema>;

/**
 * Import queue messages (§10.1). `type` tells the worker's two steps apart: `list` pages the picked
 * items, `copy` copies one photo. Neither carries the Google token: the worker reads it from the
 * Import item, so it never sits in SQS (NFR-SEC-10).
 */
export const importListMessageSchema = z.object({
  type: z.literal("list"),
  userId: userIdSchema,
  importId: importIdSchema,
});
export type ImportListMessage = z.infer<typeof importListMessageSchema>;

export const importCopyMessageSchema = z.object({
  type: z.literal("copy"),
  userId: userIdSchema,
  importId: importIdSchema,
  mediaItemId: googleMediaItemIdSchema,
  /** Google's download base URL (~1 h); the worker appends `=d`. Never logged (NFR-SEC-10). */
  baseUrl: z.url({ protocol: /^https$/ }),
  fileName: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  /** Only FR-UP-2 photo types get a copy message; the rest are counted as skipped. */
  contentType: photoContentTypeSchema,
  /** Google's creation time: the date taken when the photo has no EXIF date (FR-IMP-4, §10). */
  createTime: z.iso.datetime({ offset: true }),
});
export type ImportCopyMessage = z.infer<typeof importCopyMessageSchema>;

export const importMessageSchema = z.discriminatedUnion("type", [
  importListMessageSchema,
  importCopyMessageSchema,
]);
export type ImportMessage = z.infer<typeof importMessageSchema>;
