import { z } from "zod";
import { MAX_ALBUM_NAME_LENGTH, MAX_PHOTOS_PER_ALBUM_REQUEST } from "../constants";
import { idSchema, isoDateTimeSchema, pageSchema, userIdSchema } from "./common";

const albumNameSchema = z.string().trim().min(1).max(MAX_ALBUM_NAME_LENGTH);

export const albumSchema = z.object({
  albumId: idSchema,
  name: z.string(),
  createdAt: isoDateTimeSchema,
  coverPhotoId: idSchema.nullable(),
  coverThumbUrl: z.string().nullable(),
  photoCount: z.number().int().nonnegative(),
});
export type Album = z.infer<typeof albumSchema>;

/** GET /albums */
export const albumListSchema = z.object({ items: z.array(albumSchema) });
export type AlbumList = z.infer<typeof albumListSchema>;

/** POST /albums (FR-ALB-1) */
export const createAlbumRequestSchema = z.object({ name: albumNameSchema });
export type CreateAlbumRequest = z.infer<typeof createAlbumRequestSchema>;

/** PATCH /albums/{albumId}: rename and/or set cover (null clears it). */
export const updateAlbumRequestSchema = z
  .object({
    name: albumNameSchema.optional(),
    coverPhotoId: idSchema.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.coverPhotoId !== undefined, {
    message: "Provide name and/or coverPhotoId",
  });
export type UpdateAlbumRequest = z.infer<typeof updateAlbumRequestSchema>;

/** POST /albums/{albumId}/photos (FR-ALB-2) */
export const addAlbumPhotosRequestSchema = z.object({
  photoIds: z.array(idSchema).min(1).max(MAX_PHOTOS_PER_ALBUM_REQUEST),
});
export type AddAlbumPhotosRequest = z.infer<typeof addAlbumPhotosRequestSchema>;

/** A share of an album with another user (owner's view). */
export const albumShareSchema = z.object({
  userId: userIdSchema,
  email: z.email(),
  sharedAt: isoDateTimeSchema,
});
export type AlbumShare = z.infer<typeof albumShareSchema>;

/** GET /albums/{albumId}/shares */
export const albumShareListSchema = z.object({ items: z.array(albumShareSchema) });
export type AlbumShareList = z.infer<typeof albumShareListSchema>;

/** POST /albums/{albumId}/shares (FR-SHR-1) */
export const createShareRequestSchema = z.object({
  // Normalise before validating: z.email() rejects surrounding whitespace.
  email: z.string().trim().toLowerCase().pipe(z.email()),
});
export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;

/** An album someone else shared with me (FR-SHR-3). Read-only for the recipient. */
export const sharedAlbumSchema = albumSchema.extend({
  ownerId: userIdSchema,
  sharedAt: isoDateTimeSchema,
});
export type SharedAlbum = z.infer<typeof sharedAlbumSchema>;

/** GET /shared-albums */
export const sharedAlbumPageSchema = pageSchema(sharedAlbumSchema);
export type SharedAlbumPage = z.infer<typeof sharedAlbumPageSchema>;
