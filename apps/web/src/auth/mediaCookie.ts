import { MEDIA_COOKIE_TTL_SECONDS } from "@photo-app/shared";
import { z } from "zod";
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
  /**
   * For the route guard (8.25c): starts `ensure()` and waits for it only if the cookies issued for
   * `userId` on this device (an earlier page load included) may run out soon; otherwise renews
   * them in the background, so a restart doesn't wait for the token refresh and the API. Never
   * throws.
   */
  ready(userId: string): Promise<void>;
  /** Expires the cookies (logout, FR-AUTH-5). Needs a valid token, so call it before revoking. */
  clear(): Promise<void>;
}

export interface MediaCookieDeps {
  auth: Pick<Auth, "getAccessToken" | "getStoredUser">;
  api: Pick<Api, "session">;
  /** Where the last issue is remembered (localStorage in the app; not IndexedDB, see 8.24). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: () => number;
}

/** `{ userId, validUntil }` of the last cookies issued on this device: only an expiry, no secret. */
const ISSUED_KEY = "photo-app.media-cookie";
const issuedSchema = z.object({ userId: z.string(), validUntil: z.number() });
/** Cookies with less left than this are renewed before the page renders (images load for long). */
export const MEDIA_COOKIE_MARGIN_MS = 5 * 60 * 1000;

export function createMediaCookies({
  auth,
  api,
  storage = window.localStorage,
  now = Date.now,
}: MediaCookieDeps): MediaCookies {
  // The access token the current cookies were issued with; a new token means time to renew.
  let issuedFor: string | null = null;
  // The route guard and the refresh listener can ask at once: one request.
  let pending: Promise<void> | null = null;
  // Bumped by clear(): a request still running at logout mustn't record cookies the DELETE removed.
  let generation = 0;

  async function ensure() {
    try {
      const token = await auth.getAccessToken();
      if (!token || token === issuedFor) return;
      // Measured from before the request on this device's clock: never later than the real expiry
      // (Max-Age counts from the response), whatever the phone's clock says.
      const sentAt = now();
      const started = generation;
      pending ??= api.session
        .createMediaCookie()
        .then(async () => {
          if (started !== generation) return;
          issuedFor = token;
          const userId = (await auth.getStoredUser())?.sub;
          if (userId) remember({ userId, validUntil: sentAt + MEDIA_COOKIE_TTL_SECONDS * 1000 });
        })
        .finally(() => {
          pending = null;
        });
      await pending;
    } catch (error) {
      // Not remembered as issued, so the next navigation or refresh tries again.
      console.warn("Media cookie request failed; images may not load", error);
    }
  }

  // Storage can throw (blocked, private mode): then every start waits for new cookies, as before.
  function recall() {
    try {
      const issued = issuedSchema.safeParse(JSON.parse(storage.getItem(ISSUED_KEY) ?? "null"));
      return issued.success ? issued.data : null;
    } catch {
      return null;
    }
  }

  function remember(issued: z.infer<typeof issuedSchema> | null) {
    try {
      if (issued) storage.setItem(ISSUED_KEY, JSON.stringify(issued));
      else storage.removeItem(ISSUED_KEY);
    } catch (error) {
      console.warn("Remembering the media cookie expiry failed", error);
    }
  }

  return {
    ensure,

    async ready(userId) {
      const renewed = ensure();
      const issued = recall();
      if (issued?.userId === userId && issued.validUntil - now() > MEDIA_COOKIE_MARGIN_MS) return;
      await renewed;
    },

    async clear() {
      generation += 1;
      issuedFor = null;
      remember(null);
      await api.session.deleteMediaCookie();
    },
  };
}
