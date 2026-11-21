import type { Hono } from "hono";
import type { AppEnv } from "../env";
import type { MediaSigner } from "../lib/media";
import type { PhotoStorage } from "../lib/storage";
import type { UserDirectory } from "../lib/users";
import type { Repositories } from "../repo";
import { albumRoutes } from "./albums";
import { importRoutes, type ImportDeps } from "./imports";
import { linkRoutes, publicLinkRoutes } from "./links";
import { meRoutes } from "./me";
import { photoRoutes } from "./photos";
import { placeRoutes } from "./places";
import { sessionRoutes } from "./session";
import { shareRoutes } from "./shares";
import { trashRoutes } from "./trash";
import { videoRoutes } from "./videos";

/** What route handlers may use. Built once per Lambda environment in index.ts; faked in tests. */
export interface Deps {
  repos: Repositories;
  users: UserDirectory;
  storage: PhotoStorage;
  media: MediaSigner;
  config: { defaultQuotaBytes: number };
  /** Import from Google Photos (13.5c); without it the `/imports` routes don't exist (404). */
  imports?: ImportDeps;
}

/** All authenticated routes (§9), for `createApp({ routes })`. */
export function registerRoutes(deps: Deps): (app: Hono<AppEnv>) => void {
  return (app) => {
    meRoutes(app, deps);
    photoRoutes(app, deps);
    videoRoutes(app, deps);
    albumRoutes(app, deps);
    placeRoutes(app, deps);
    shareRoutes(app, deps);
    trashRoutes(app, deps);
    linkRoutes(app, deps);
    sessionRoutes(app, deps);
    if (deps.imports) importRoutes(app, deps, deps.imports);
  };
}

/** Routes without login (`createApp({ publicRoutes })`): public photo links (FR-SHR-8). */
export function registerPublicRoutes(deps: Deps): (app: Hono<AppEnv>) => void {
  return (app) => {
    publicLinkRoutes(app, deps);
  };
}
