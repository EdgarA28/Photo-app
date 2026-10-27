import type { Hono } from "hono";
import type { AppEnv } from "../env";
import type { MediaSigner } from "../lib/media";
import type { PhotoStorage } from "../lib/storage";
import type { UserDirectory } from "../lib/users";
import type { Repositories } from "../repo";
import { albumRoutes } from "./albums";
import { meRoutes } from "./me";
import { photoRoutes } from "./photos";
import { placeRoutes } from "./places";
import { sessionRoutes } from "./session";
import { shareRoutes } from "./shares";

/** What route handlers may use. Built once per Lambda environment in index.ts; faked in tests. */
export interface Deps {
  repos: Repositories;
  users: UserDirectory;
  storage: PhotoStorage;
  media: MediaSigner;
  config: { defaultQuotaBytes: number };
}

/** All authenticated routes (§9), for `createApp({ routes })`. */
export function registerRoutes(deps: Deps): (app: Hono<AppEnv>) => void {
  return (app) => {
    meRoutes(app, deps);
    photoRoutes(app, deps);
    albumRoutes(app, deps);
    placeRoutes(app, deps);
    shareRoutes(app, deps);
    sessionRoutes(app, deps);
  };
}
