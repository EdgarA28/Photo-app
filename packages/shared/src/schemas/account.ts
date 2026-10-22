import { z } from "zod";
import { isoDateTimeSchema, userIdSchema, usernameSchema } from "./common";

export const usageSchema = z.object({
  bytesUsed: z.number().int().nonnegative(),
  photoCount: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
});
export type Usage = z.infer<typeof usageSchema>;

/** GET /me (FR-ACC-1, FR-ACC-2) */
export const meResponseSchema = z.object({
  userId: userIdSchema,
  email: z.email(),
  name: z.string().nullable(),
  /** null until the user picks one (FR-ACC-3). */
  username: z.string().nullable(),
  usage: usageSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** PUT /me/username (FR-ACC-3) */
export const setUsernameRequestSchema = z.object({ username: usernameSchema });
export type SetUsernameRequest = z.infer<typeof setUsernameRequestSchema>;

export const setUsernameResponseSchema = z.object({ username: z.string() });
export type SetUsernameResponse = z.infer<typeof setUsernameResponseSchema>;

/** POST /session/media-cookie. The cookies themselves are set via Set-Cookie headers. */
export const mediaCookieResponseSchema = z.object({
  expiresAt: isoDateTimeSchema,
});
export type MediaCookieResponse = z.infer<typeof mediaCookieResponseSchema>;
