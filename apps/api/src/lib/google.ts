import { GOOGLE_PHOTOS_PICKER_SCOPE } from "@photo-app/shared";

/**
 * Google OAuth + Photos Picker API for the import (13.5c; FR-IMP-1/2, §11.5, NFR-SEC-10). Routes
 * use the `GooglePhotos` interface; tests replace it with a fake, so nothing here runs against
 * Google in the test suite.
 *
 * Never logged or put in an error message: the access token, the authorization code and the
 * client secret. Errors carry only the HTTP status and Google's error code.
 */

export interface GoogleToken {
  accessToken: string;
  expiresAt: Date;
}

export interface PickerSession {
  sessionId: string;
  pickerUri: string;
  /** How often Google wants the session polled (`pollingConfig.pollInterval`). */
  pollIntervalSec: number;
  /** When the session stops accepting picks (`expireTime`). */
  expiresAt: Date;
  /** True once the user pressed Done in the picker (FR-IMP-5). */
  mediaItemsSet: boolean;
}

export interface GooglePhotos {
  /**
   * Authorization code → access token (no refresh token: `access_type=online`, §11.5). Null when
   * Google rejects the code or the user didn't grant the Picker scope (→ 400 GOOGLE_AUTH_FAILED).
   */
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GoogleToken | null>;
  /** A Picker session that lets the user pick at most `maxItemCount` items (FR-IMP-2). */
  createSession(accessToken: string, maxItemCount: number): Promise<PickerSession>;
  /** Null when Google no longer knows the session (expired or deleted). */
  getSession(accessToken: string, sessionId: string): Promise<PickerSession | null>;
  /** Deletes the session; a session Google no longer knows counts as deleted. */
  deleteSession(accessToken: string, sessionId: string): Promise<void>;
}

/** A failed Google call: status and Google's error code only (never tokens or URLs). */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly googleCode: string | undefined,
    operation: string,
  ) {
    super(`Google ${operation} failed: ${status}${googleCode ? ` ${googleCode}` : ""}`);
    this.name = "GoogleApiError";
  }

  /** The token no longer works (expired or revoked): retrying can't help. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const PICKER_API_URL = "https://photospicker.googleapis.com/v1";
/** Each Google call gets this long; the API Lambda has 10 s for the whole request. */
const GOOGLE_TIMEOUT_MS = 4000;
/** Used when Google's poll interval is missing or unreadable. */
const DEFAULT_POLL_INTERVAL_SEC = 5;

export interface GoogleClientOptions {
  clientId: string;
  /** Read lazily (SSM SecureString, NFR-SEC-10), once per Lambda environment. */
  loadClientSecret: () => Promise<string>;
  fetch?: typeof fetch;
}

export function googlePhotosClient(options: GoogleClientOptions): GooglePhotos {
  const fetchFn = options.fetch ?? fetch;

  async function call(operation: string, url: string, init: RequestInit): Promise<Response> {
    return fetchFn(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) }).catch(
      (err: unknown) => {
        // Network error or timeout: no status. The message never contains the request body.
        throw new GoogleApiError(0, err instanceof Error ? err.name : undefined, operation);
      },
    );
  }

  async function picker(
    operation: string,
    accessToken: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return call(operation, `${PICKER_API_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  }

  return {
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const res = await call("token exchange", GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: options.clientId,
          client_secret: await options.loadClientSecret(),
        }),
      });
      // 400/401 = the code, verifier or redirect URI was rejected (used, expired, mismatched).
      if (res.status === 400 || res.status === 401) return null;
      if (!res.ok) throw await apiError(res, "token exchange");
      const body = (await res.json()) as {
        access_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
      };
      if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
        throw new GoogleApiError(res.status, "invalid_response", "token exchange");
      }
      // With granular consent the user can untick the Photos permission; then there's nothing to
      // import with this token.
      const scopes = typeof body.scope === "string" ? body.scope.split(" ") : [];
      if (!scopes.includes(GOOGLE_PHOTOS_PICKER_SCOPE)) return null;
      return {
        accessToken: body.access_token,
        expiresAt: new Date(Date.now() + body.expires_in * 1000),
      };
    },

    async createSession(accessToken, maxItemCount) {
      const res = await picker("create session", accessToken, "/sessions", {
        method: "POST",
        body: JSON.stringify({ pickingConfig: { maxItemCount: String(maxItemCount) } }),
      });
      if (!res.ok) throw await apiError(res, "create session");
      return toSession(await res.json(), "create session");
    },

    async getSession(accessToken, sessionId) {
      const res = await picker(
        "get session",
        accessToken,
        `/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw await apiError(res, "get session");
      return toSession(await res.json(), "get session");
    },

    async deleteSession(accessToken, sessionId) {
      const res = await picker(
        "delete session",
        accessToken,
        `/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
      if (res.ok || res.status === 404) return;
      throw await apiError(res, "delete session");
    },
  };
}

/** Google's error code from an error body (`{error: "invalid_grant"}` or `{error: {status}}`). */
async function apiError(res: Response, operation: string): Promise<GoogleApiError> {
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
    else if (body.error && typeof body.error === "object" && "status" in body.error) {
      code = String((body.error as { status: unknown }).status);
    }
  } catch {
    // Not JSON: the status says enough.
  }
  return new GoogleApiError(res.status, code, operation);
}

/** A Picker `PickingSession` → our shape; anything missing or odd is a bad response. */
export function toSession(raw: unknown, operation: string): PickerSession {
  const body = (raw ?? {}) as {
    id?: unknown;
    pickerUri?: unknown;
    expireTime?: unknown;
    mediaItemsSet?: unknown;
    pollingConfig?: { pollInterval?: unknown };
  };
  const expiresAt = typeof body.expireTime === "string" ? new Date(body.expireTime) : null;
  if (
    typeof body.id !== "string" ||
    typeof body.pickerUri !== "string" ||
    !body.pickerUri.startsWith("https://") ||
    !expiresAt ||
    Number.isNaN(expiresAt.getTime())
  ) {
    throw new GoogleApiError(200, "invalid_response", operation);
  }
  return {
    sessionId: body.id,
    pickerUri: body.pickerUri,
    pollIntervalSec: parseDuration(body.pollingConfig?.pollInterval),
    expiresAt,
    mediaItemsSet: body.mediaItemsSet === true,
  };
}

/** Google's `Duration` JSON ("5s", "2.5s") → whole seconds, at least 1. */
export function parseDuration(value: unknown): number {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  if (!match) return DEFAULT_POLL_INTERVAL_SEC;
  return Math.max(1, Math.ceil(Number(match[1])));
}
