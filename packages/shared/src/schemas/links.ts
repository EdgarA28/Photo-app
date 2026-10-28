import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Public photo links (FR-SHR-8): the owner creates a link to one photo that anyone can open for
 * 15 minutes, without an account. The token is 128 random bits, base64url (22 characters).
 */
export const photoLinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "Invalid link");

/** POST /photos/{photoId}/links */
export const photoLinkSchema = z.object({
  token: photoLinkTokenSchema,
  /** App path of the public page, `/s/{token}`; the web app puts its origin in front. */
  path: z.string(),
  expiresAt: isoDateTimeSchema,
});
export type PhotoLink = z.infer<typeof photoLinkSchema>;

/** GET /links/{token} (no login): what the public page shows. */
export const linkedPhotoSchema = z.object({
  photoId: idSchema,
  /** CloudFront signed URL of the preview, valid until the link expires. */
  previewUrl: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  expiresAt: isoDateTimeSchema,
});
export type LinkedPhoto = z.infer<typeof linkedPhotoSchema>;
