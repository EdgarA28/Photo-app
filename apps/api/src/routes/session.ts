import { MEDIA_COOKIE_TTL_SECONDS, type MediaCookieResponse } from "@photo-app/shared";
import type { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { AppEnv } from "../env";
import { MEDIA_COOKIE_NAMES } from "../lib/media";
import type { Deps } from ".";

/**
 * Media cookies (§9, FR-AUTH-5): CloudFront signed cookies for the caller's own images. Scoped to
 * `/users/{sub}/`, so the browser sends them only with that user's image requests; HttpOnly, so
 * page scripts can't read them. Issuing needs the bearer token (requireUser), so another site
 * can't obtain one for the user.
 */
export function sessionRoutes(app: Hono<AppEnv>, { media }: Deps): void {
  /** Issue (or renew) the cookies; the app calls this after login and every token refresh. */
  app.post("/session/media-cookie", async (c) => {
    const userId = c.get("userId");
    const { cookies, expiresAt } = await media.signCookies(userId, new Date());
    const options = cookieOptions(userId, MEDIA_COOKIE_TTL_SECONDS);
    // CloudFront's base64 alphabet (A-Z a-z 0-9 - _ ~) passes setCookie's URI encoding unchanged.
    for (const name of MEDIA_COOKIE_NAMES) setCookie(c, name, cookies[name], options);
    const body: MediaCookieResponse = { expiresAt: expiresAt.toISOString() };
    return c.json(body);
  });

  /**
   * Expire the cookies (logout). Same names and Path, Max-Age=0; idempotent. A copy taken before
   * logout stays valid until its expiry (≤ 8 h): signed cookies can't be revoked (§9).
   */
  app.delete("/session/media-cookie", (c) => {
    const options = cookieOptions(c.get("userId"), 0);
    for (const name of MEDIA_COOKIE_NAMES) setCookie(c, name, "", options);
    return c.body(null, 204);
  });
}

function cookieOptions(userId: string, maxAge: number): CookieOptions {
  // No Domain: host-only on the app's own (CloudFront) origin.
  return { path: `/users/${userId}/`, maxAge, secure: true, httpOnly: true, sameSite: "Lax" };
}
