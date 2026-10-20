import type { ValidationTargets } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { validationError } from "./errors";

/**
 * Hono validator backed by a Zod schema from `@photo-app/shared`. Failures become a
 * VALIDATION_ERROR envelope; handlers read the parsed (transformed) value with `c.req.valid()`.
 *
 *   app.post("/albums", validate("json", createAlbumRequestSchema), (c) => c.req.valid("json"))
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return validator(target, (value): z.output<Schema> => {
    const result = schema.safeParse(value);
    if (!result.success) throw validationError(describe(result.error));
    return result.data;
  });
}

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}
