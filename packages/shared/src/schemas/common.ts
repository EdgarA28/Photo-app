import { z } from "zod";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from "../constants";
import { ULID_REGEX } from "../ids";

export const idSchema = z.string().regex(ULID_REGEX, "Invalid ID");
export const userIdSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime();

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
