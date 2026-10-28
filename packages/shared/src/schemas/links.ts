import { z } from "zod";
import { MAX_PHOTOS_PER_LINK } from "../constants";
import { idSchema, isoDateTimeSchema } from "./common";

/**
 * Public photo links (FR-SHR-8): the owner creates a link to one or more photos that anyone can
 * open for 15 minutes, without an account. The token is 128 random bits, base64url (22 characters).
 */
export const photoLinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "Invalid link");

/** POST /links: own photos; those not processed or in the trash are left out. */
export const createPhotoLinkRequestSchema = z.object({
  photoIds: z.array(idSchema).min(1).max(MAX_PHOTOS_PER_LINK),
});
export type CreatePhotoLinkRequest = z.infer<typeof createPhotoLinkRequestSchema>;

export const photoLinkSchema = z.object({
  token: photoLinkTokenSchema,
  /** App path of the public page, `/s/{token}`; the web app puts its origin in front. */
  path: z.string(),
  expiresAt: isoDateTimeSchema,
  /** Photos in the link (the requested ones that could be shared). */
  photoCount: z.number().int().positive(),
});
export type PhotoLink = z.infer<typeof photoLinkSchema>;

/** One photo of a link; image URLs are CloudFront signed URLs valid until the link expires. */
export const linkedPhotoSchema = z.object({
  photoId: idSchema,
  thumbUrl: z.string(),
  previewUrl: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type LinkedPhoto = z.infer<typeof linkedPhotoSchema>;

/** GET /links/{token} (no login): what the public page shows, newest photo first. */
export const sharedLinkSchema = z.object({
  photos: z.array(linkedPhotoSchema),
  expiresAt: isoDateTimeSchema,
});
export type SharedLink = z.infer<typeof sharedLinkSchema>;
