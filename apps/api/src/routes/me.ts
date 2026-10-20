import type { MeResponse } from "@photo-app/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { AppError } from "../lib/errors";
import type { Deps } from ".";

export function meRoutes(app: Hono<AppEnv>, { repos, users, config }: Deps): void {
  /** Profile, usage and quota (FR-ACC-1, FR-ACC-2). */
  app.get("/me", async (c) => {
    const userId = c.get("userId");
    const [profile, usage] = await Promise.all([users.getProfile(userId), repos.usage.get(userId)]);
    // A valid token for a user deleted from the pool: treat like any other bad credential.
    if (!profile) throw new AppError(401, "UNAUTHORIZED", "Authentication required");

    const body: MeResponse = {
      userId,
      email: profile.email,
      name: profile.name,
      usage: {
        bytesUsed: usage.bytesUsed,
        photoCount: usage.photoCount,
        quotaBytes: usage.quotaBytes ?? config.defaultQuotaBytes,
      },
    };
    return c.json(body);
  });
}
