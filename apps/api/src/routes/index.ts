import type { Hono } from "hono";
import type { AppEnv } from "../env";
import type { UserDirectory } from "../lib/users";
import type { Repositories } from "../repo";
import { albumRoutes } from "./albums";
import { meRoutes } from "./me";
import { photoRoutes } from "./photos";

/** What route handlers may use. Built once per Lambda environment in index.ts; faked in tests. */
export interface Deps {
  repos: Repositories;
  users: UserDirectory;
  config: { defaultQuotaBytes: number };
}

/** All authenticated routes (§9), for `createApp({ routes })`. */
export function registerRoutes(deps: Deps): (app: Hono<AppEnv>) => void {
  return (app) => {
    meRoutes(app, deps);
    photoRoutes(app, deps);
    albumRoutes(app, deps);
  };
}
