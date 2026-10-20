import type { ErrorCode } from "@photo-app/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error that maps directly to the API error envelope (§9). Thrown anywhere, rendered by `onError`. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(message = "Not found"): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function validationError(message: string): AppError {
  return new AppError(400, "VALIDATION_ERROR", message);
}

/**
 * NFR-SEC-2: anything the caller may not see is reported exactly like something that does not
 * exist. Repositories only ever look up items under the caller's own partition, so "someone
 * else's" and "missing" both arrive here as null/undefined.
 */
export function orNotFound<T>(value: T | null | undefined, message?: string): T {
  if (value === null || value === undefined) throw notFound(message);
  return value;
}
