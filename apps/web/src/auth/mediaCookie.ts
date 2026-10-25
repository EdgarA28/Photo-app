import type { Api } from "@/api/api";
import type { Auth } from "./auth";

/**
 * CloudFront signed cookies for the user's own images (7.3, §9). The API sets them (HttpOnly, so
 * this code never sees them); the app only decides when to ask.
 */
export interface MediaCookies {
  /**
   * Makes sure the browser holds cookies issued with the current access token: after login, on
   * every page load (tokens live in memory, so each load refreshes) and after each token refresh,
   * so they never run out during a session. Never throws: without cookies only images fail.
   */
  ensure(): Promise<void>;
  /** Expires the cookies (logout, FR-AUTH-5). Needs a valid token, so call it before revoking. */
  clear(): Promise<void>;
}

export interface MediaCookieDeps {
  auth: Pick<Auth, "getAccessToken">;
  api: Pick<Api, "session">;
}

export function createMediaCookies({ auth, api }: MediaCookieDeps): MediaCookies {
  // The access token the current cookies were issued with; a new token means time to renew.
  let issuedFor: string | null = null;
  // The route guard and the refresh listener can ask at once: one request.
  let pending: Promise<void> | null = null;

  return {
    async ensure() {
      try {
        const token = await auth.getAccessToken();
        if (!token || token === issuedFor) return;
        pending ??= api.session
          .createMediaCookie()
          .then(() => {
            issuedFor = token;
          })
          .finally(() => {
            pending = null;
          });
        await pending;
      } catch (error) {
        // Not remembered as issued, so the next navigation or refresh tries again.
        console.warn("Media cookie request failed; images may not load", error);
      }
    },

    async clear() {
      issuedFor = null;
      await api.session.deleteMediaCookie();
    },
  };
}
