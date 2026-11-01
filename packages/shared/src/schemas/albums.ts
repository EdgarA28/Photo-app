import { z } from "zod";
import { MAX_ALBUM_NAME_LENGTH, MAX_PHOTOS_PER_ALBUM_REQUEST } from "../constants";
import { idSchema, isoDateTimeSchema, pageSchema, userIdSchema, usernameSchema } from "./common";

const albumNameSchema = z.string().trim().min(1).max(MAX_ALBUM_NAME_LENGTH);

export const albumSchema = z.object({
  albumId: idSchema,
  name: z.string(),
  createdAt: isoDateTimeSchema,
  coverPhotoId: idSchema.nullable(),
  coverThumbUrl: z.string().nullable(),
  photoCount: z.number().int().nonnegative(),
  /**
   * Collaborative album (FR-SHR-11): members who accepted the share can add their own photos.
   * Missing (an API from before it) reads as false.
   */
  membersCanAdd: z.boolean().default(false),
  /**
   * Everyone in the album sees where its photos were taken (FR-SHR-12): place names, members'
   * photos included. Missing (an API from before it) reads as false.
   */
  showLocations: z.boolean().default(false),
});
export type Album = z.infer<typeof albumSchema>;

/** GET /albums */
export const albumListSchema = z.object({ items: z.array(albumSchema) });
export type AlbumList = z.infer<typeof albumListSchema>;

/** POST /albums (FR-ALB-1) */
export const createAlbumRequestSchema = z.object({ name: albumNameSchema });
export type CreateAlbumRequest = z.infer<typeof createAlbumRequestSchema>;

/**
 * PATCH /albums/{albumId}: rename, set the cover (null clears it), let members add photos
 * (FR-SHR-11) and/or share the photos' locations (FR-SHR-12).
 */
export const updateAlbumRequestSchema = z
  .object({
    name: albumNameSchema.optional(),
    coverPhotoId: idSchema.nullable().optional(),
    membersCanAdd: z.boolean().optional(),
    showLocations: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Provide name, coverPhotoId, membersCanAdd and/or showLocations",
  });
export type UpdateAlbumRequest = z.infer<typeof updateAlbumRequestSchema>;

/** POST /albums/{albumId}/photos (FR-ALB-2) */
export const addAlbumPhotosRequestSchema = z.object({
  photoIds: z.array(idSchema).min(1).max(MAX_PHOTOS_PER_ALBUM_REQUEST),
});
export type AddAlbumPhotosRequest = z.infer<typeof addAlbumPhotosRequestSchema>;

/**
 * A share starts as an invitation (`pending`) and gives access only once the recipient accepts
 * it (FR-SHR-6).
 */
export const shareStatusSchema = z.enum(["pending", "accepted"]);
export type ShareStatus = z.infer<typeof shareStatusSchema>;

/**
 * A share of an album with another user (owner's view). `email` only for shares made by email:
 * sharing by username never reveals it (FR-SHR-5). `username` is the recipient's current one.
 */
export const albumShareSchema = z.object({
  userId: userIdSchema,
  email: z.email().nullable(),
  username: z.string().nullable(),
  status: shareStatusSchema,
  sharedAt: isoDateTimeSchema,
});
export type AlbumShare = z.infer<typeof albumShareSchema>;

/** GET /albums/{albumId}/shares */
export const albumShareListSchema = z.object({ items: z.array(albumShareSchema) });
export type AlbumShareList = z.infer<typeof albumShareListSchema>;

/** POST /albums/{albumId}/shares: exactly one of `email` (FR-SHR-1) or `username` (FR-SHR-5). */
export const createShareRequestSchema = z.union([
  z.strictObject({
    // Normalise before validating: z.email() rejects surrounding whitespace.
    email: z.string().trim().toLowerCase().pipe(z.email()),
  }),
  z.strictObject({ username: usernameSchema }),
]);
export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;

/** An album someone else shared with me (FR-SHR-3). Read-only for the recipient. */
export const sharedAlbumSchema = albumSchema.extend({
  ownerId: userIdSchema,
  /** The owner's current username, null if they have none. */
  ownerUsername: z.string().nullable(),
  sharedAt: isoDateTimeSchema,
});
export type SharedAlbum = z.infer<typeof sharedAlbumSchema>;

/** GET /shared-albums */
export const sharedAlbumPageSchema = pageSchema(sharedAlbumSchema);
export type SharedAlbumPage = z.infer<typeof sharedAlbumPageSchema>;

/**
 * An album someone invited me to that I haven't accepted yet (FR-SHR-6): its name and who shared
 * it, no photos or cover until I accept.
 */
export const shareInvitationSchema = z.object({
  albumId: idSchema,
  name: z.string(),
  photoCount: z.number().int().nonnegative(),
  ownerId: userIdSchema,
  /** The owner's current username, null if they have none. */
  ownerUsername: z.string().nullable(),
  sharedAt: isoDateTimeSchema,
});
export type ShareInvitation = z.infer<typeof shareInvitationSchema>;

/** GET /share-invitations */
export const shareInvitationPageSchema = pageSchema(shareInvitationSchema);
export type ShareInvitationPage = z.infer<typeof shareInvitationPageSchema>;
