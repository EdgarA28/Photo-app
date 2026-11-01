import { idSchema, type EmptyTrashResult, type Photo, type TrashList } from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { orNotFound } from "../lib/errors";
import { deleteTrashedPhoto, emptyTrash, isTrashed } from "../lib/trash";
import { validate } from "../lib/validation";
import type { Deps } from ".";
import { toPhoto } from "./present";

const photoParam = z.object({ photoId: idSchema });

/**
 * The trash (FR-DEL-3, §9): own photos deleted in the last 15 days, until the daily purge removes
 * them. Photos are found under the caller's `sub` only, so another user's (or one not in the
 * trash) is 404 (NFR-SEC-1/2).
 */
export function trashRoutes(app: Hono<AppEnv>, { repos, storage }: Deps): void {
  /** Most recently deleted first, in one response (the quota bounds it). */
  app.get("/trash", async (c) => {
    const photos = await repos.photos.listTrashed(c.get("userId"));
    const body: TrashList = { items: photos.map(toPhoto) };
    return c.json(body);
  });

  /** Back to the gallery, its places and the albums it was in that still exist. */
  app.post("/trash/:photoId/restore", validate("param", photoParam), async (c) => {
    const { photoId } = c.req.valid("param");
    const restored = await repos.photos.restore(c.get("userId"), photoId, new Date());
    const body: Photo = toPhoto(orNotFound(restored, "Photo not found in the trash"));
    return c.json(body);
  });

  /** Delete forever, before the 15 days are up. */
  app.delete("/trash/:photoId", validate("param", photoParam), async (c) => {
    const { photoId } = c.req.valid("param");
    const record = await repos.photos.get(c.get("userId"), photoId);
    const trashed = orNotFound(record && isTrashed(record) ? record : null, "Photo not found");
    await deleteTrashedPhoto(repos, storage, trashed);
    return c.body(null, 204);
  });

  /**
   * Empty the trash, a few seconds at a time: `{deleted, remaining}`; the client repeats the
   * request until nothing remains (a big trash doesn't fit in one request's 10 s).
   */
  app.delete("/trash", async (c) => {
    const body: EmptyTrashResult = await emptyTrash(repos, storage, c.get("userId"));
    return c.json(body);
  });
}
