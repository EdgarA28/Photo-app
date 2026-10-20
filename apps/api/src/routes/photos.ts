import { idSchema, listPhotosQuerySchema, type Photo, type PhotoPage } from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { orNotFound } from "../lib/errors";
import { validate } from "../lib/validation";
import type { Deps } from ".";
import { toPhoto } from "./present";

const photoParam = z.object({ photoId: idSchema });

export function photoRoutes(app: Hono<AppEnv>, { repos }: Deps): void {
  /** Own photos by date taken, newest first by default, paginated (FR-GAL-1, FR-GAL-2). */
  app.get("/photos", validate("query", listPhotosQuerySchema), async (c) => {
    const { sort, limit, cursor } = c.req.valid("query");
    const page = await repos.photos.list(c.get("userId"), { sort, limit, cursor });
    const body: PhotoPage = { items: page.items.map(toPhoto), nextCursor: page.nextCursor };
    return c.json(body);
  });

  /** One own photo. Other users' photos are 404 (NFR-SEC-2). */
  app.get("/photos/:photoId", validate("param", photoParam), async (c) => {
    const { photoId } = c.req.valid("param");
    const record = orNotFound(await repos.photos.get(c.get("userId"), photoId), "Photo not found");
    const body: Photo = toPhoto(record);
    return c.json(body);
  });
}
