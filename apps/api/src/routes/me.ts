import {
  setUsernameRequestSchema,
  type MeResponse,
  type SetUsernameResponse,
} from "@photo-app/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import { validate } from "../lib/validation";
import type { Deps } from ".";

export function meRoutes(app: Hono<AppEnv>, { repos, users, config }: Deps): void {
  /** Profile, usage and quota (FR-ACC-1, FR-ACC-2), and the username if set (FR-ACC-3). */
  app.get("/me", async (c) => {
    const userId = c.get("userId");
    const [profile, usage, appProfile] = await Promise.all([
      users.getProfile(userId),
      repos.usage.get(userId),
      repos.usernames.getProfile(userId),
    ]);
    // A valid token for a user deleted from the pool: treat like any other bad credential.
    if (!profile) throw new AppError(401, "UNAUTHORIZED", "Authentication required");

    const body: MeResponse = {
      userId,
      email: profile.email,
      name: profile.name,
      username: appProfile?.username ?? null,
      usage: {
        bytesUsed: usage.bytesUsed,
        photoCount: usage.photoCount,
        quotaBytes: usage.quotaBytes ?? config.defaultQuotaBytes,
      },
    };
    return c.json(body);
  });

  /**
   * Sets or changes the caller's username (FR-ACC-3). The old one stays held for them for
   * `USERNAME_HOLD_DAYS` (D-8). Existing shares are by user ID, so they survive a rename.
   */
  app.put("/me/username", validate("json", setUsernameRequestSchema), async (c) => {
    const { username } = c.req.valid("json");
    const result = await repos.usernames.set(c.get("userId"), username, new Date().toISOString());
    if (result === "taken") {
      throw new AppError(409, "USERNAME_TAKEN", "This username is already taken");
    }
    const body: SetUsernameResponse = { username };
    return c.json(body);
  });
}
