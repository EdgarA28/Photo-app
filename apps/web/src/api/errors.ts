import type { ErrorCode } from "@photo-app/shared";

/** API error codes (§9) plus what can go wrong before or after the API answers. */
export type ClientErrorCode = ErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE";

export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";

  constructor(
    readonly code: ClientErrorCode,
    message: string,
    /** HTTP status; 0 when no response arrived. */
    readonly status: number,
  ) {
    super(message);
  }

  /** Worth retrying: no response, throttled, or a server-side failure. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const MESSAGES: Record<ClientErrorCode, string> = {
  UNAUTHORIZED: "Your session has ended. Please log in again.",
  NOT_FOUND: "This item doesn't exist or was deleted.",
  VALIDATION_ERROR: "Some of the entered data isn't valid.",
  QUOTA_EXCEEDED: "Your storage is full. Delete some photos to upload more.",
  UNSUPPORTED_MEDIA_TYPE: "This file type isn't supported. Use JPEG, PNG, WebP or HEIC.",
  PAYLOAD_TOO_LARGE: "This file is too large.",
  FORBIDDEN: "You aren't allowed to do this here. The owner may have changed the album.",
  CONFLICT: "This changed in the meantime. Reload and try again.",
  SHARE_TARGET_NOT_FOUND: "No user with this email or username.",
  USERNAME_TAKEN: "This username is already taken.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
  INTERNAL_ERROR: "Something went wrong on our side. Try again later.",
  NETWORK_ERROR: "Can't reach the server. Check your connection.",
  INVALID_RESPONSE: "The server sent an unexpected response. Try reloading the app.",
};

/** User-facing text for any error (FR-UP-7; 8.14 refines per screen). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    // The API's own message is more specific where it explains the input (e.g. which field).
    return error.code === "VALIDATION_ERROR" ? error.message : MESSAGES[error.code];
  }
  return error instanceof Error ? error.message : String(error);
}
