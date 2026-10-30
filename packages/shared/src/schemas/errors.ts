import { z } from "zod";

export const errorCodes = [
  "UNAUTHORIZED",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "QUOTA_EXCEEDED",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "FORBIDDEN",
  "CONFLICT",
  "SHARE_TARGET_NOT_FOUND",
  "USERNAME_TAKEN",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Error body for every non-2xx API response (§9). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
