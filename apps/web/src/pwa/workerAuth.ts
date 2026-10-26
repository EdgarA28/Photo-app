import { ApiRequestError } from "@/api/errors";
import type { Auth } from "@/auth/auth";
import type { StoredSession } from "@/auth/sessionDb";
import type { AppConfig } from "@/config";

export interface WorkerAuth extends Pick<Auth, "getAccessToken" | "refreshAccessToken"> {
  /** Cognito rejected the refresh token: nothing can be uploaded until the user logs in again. */
  readonly ended: boolean;
}

/** Leaves this much of the access token's life unused, against clock skew. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Access tokens for the service worker's background uploads (9.5): the stored refresh token
 * (§11.4) exchanged at Cognito's token endpoint, the same request oidc-client-ts makes in the
 * page. Kept in memory for one sync only and never written back: Cognito doesn't rotate refresh
 * tokens, so the page's stored session stays valid. A rejected refresh token ends the background
 * work but leaves the session to the page, which signs the user out the next time it starts.
 */
export function createWorkerAuth(
  config: AppConfig,
  session: StoredSession,
  { fetch: doFetch = fetch, now = Date.now }: { fetch?: typeof fetch; now?: () => number } = {},
): WorkerAuth {
  let token: { value: string; expiresAt: number } | undefined;
  let ended = false;
  let pending: Promise<string | null> | undefined;

  async function refresh(): Promise<string | null> {
    if (ended) return null;
    let response: Response;
    try {
      response = await doFetch(`${config.cognito.domain}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.cognito.clientId,
          refresh_token: session.refreshToken,
        }),
      });
    } catch {
      // Like an API call without an answer: the upload is retried later.
      throw new ApiRequestError("NETWORK_ERROR", "Token refresh failed", 0);
    }
    if (response.status === 400 || response.status === 401) {
      ended = true;
      return null;
    }
    if (!response.ok) throw new ApiRequestError("INTERNAL_ERROR", "Token refresh failed", 0);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") {
      throw new ApiRequestError("INVALID_RESPONSE", "Token refresh failed", 0);
    }
    const lifetime = typeof body.expires_in === "number" ? body.expires_in * 1000 : 0;
    token = { value: body.access_token, expiresAt: now() + lifetime - EXPIRY_MARGIN_MS };
    return token.value;
  }

  /** Concurrent uploads share one refresh request. */
  const refreshOnce = () =>
    (pending ??= refresh().finally(() => {
      pending = undefined;
    }));

  return {
    get ended() {
      return ended;
    },
    async getAccessToken() {
      if (token && token.expiresAt > now()) return token.value;
      return refreshOnce();
    },
    refreshAccessToken: refreshOnce,
  };
}
