import { z } from "zod";
import { isoDateTimeSchema, userIdSchema } from "./common";

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
  usage: usageSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** POST /session/media-cookie. The cookies themselves are set via Set-Cookie headers. */
export const mediaCookieResponseSchema = z.object({
  expiresAt: isoDateTimeSchema,
});
export type MediaCookieResponse = z.infer<typeof mediaCookieResponseSchema>;
