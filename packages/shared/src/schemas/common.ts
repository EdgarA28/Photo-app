import { z } from "zod";
import {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  RESERVED_USERNAMES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "../constants";
import { ULID_REGEX, USER_ID_REGEX } from "../ids";

export const idSchema = z.string().regex(ULID_REGEX, "Invalid ID");
/**
 * Cognito `sub`. Not `z.uuid()`: that requires the RFC 4122 variant (8, 9, a or b at the start of
 * the 4th group), and Cognito subs don't always have it (e.g. `…-707e-e65a-…`), which made `GET /me`
 * unreadable for such users. Same rule as the API's `requireUser` (`USER_ID_REGEX`).
 */
export const userIdSchema = z.string().regex(USER_ID_REGEX, "Invalid user ID");
export const isoDateTimeSchema = z.iso.datetime();

const USERNAME_REGEX = new RegExp(
  `^[a-z0-9][a-z0-9._]{${USERNAME_MIN_LENGTH - 2},${USERNAME_MAX_LENGTH - 2}}[a-z0-9]$`,
);

/**
 * A username (FR-ACC-3), normalised before validating: trimmed, one leading `@` dropped
 * (`@Ana_R` → `ana_r`), lowercased. ASCII only, so lookalike letters from other scripts can't
 * imitate someone else's name.
 */
export const usernameSchema = z
  .string()
  .trim()
  .transform((name) => name.replace(/^@/, "").toLowerCase())
  .pipe(
    z
      .string()
      .regex(
        USERNAME_REGEX,
        `${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters: a-z, 0-9, "." and "_", starting and ending with a letter or digit`,
      )
      .refine((name) => !name.includes(".."), "No consecutive dots")
      .refine((name) => !RESERVED_USERNAMES.includes(name), "This username is reserved"),
  );

/** Opaque cursor (encoded DynamoDB LastEvaluatedKey). */
export const cursorSchema = z.string().min(1).max(2048);

/** Query params for paginated lists. Values arrive as strings, so `limit` is coerced. */
export const pageQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.nullable(),
  });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
