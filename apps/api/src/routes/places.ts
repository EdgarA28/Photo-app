import {
  listPhotosQuerySchema,
  placeIdSchema,
  type PhotoLocationList,
  type PhotoPage,
  type PlaceList,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { orNotFound } from "../lib/errors";
import { validate } from "../lib/validation";
import type { Deps } from ".";
import { toPhoto, toPhotoLocation } from "./present";

const placeParam = z.object({ placeId: placeIdSchema });

/**
 * Search by place (13.2e, §9): the caller's own places and their photos. Places live under the
 * caller's `sub`, so another user's place is simply one the caller doesn't have (404,
 * NFR-SEC-1/2). Not offered for shared albums (13.2g).
 */
export function placeRoutes(app: Hono<AppEnv>, { repos }: Deps): void {
  /** All places with photos, most photos first; the web app filters them as the user types. */
  app.get("/places", async (c) => {
    const places = await repos.places.list(c.get("userId"));
    const body: PlaceList = {
      items: places.map(({ placeId, kind, name, context, photoCount }) => ({
        placeId,
        kind,
        name,
        context,
        photoCount,
      })),
    };
    return c.json(body);
  });

  /**
   * Map pins (13.2h): every own ready photo with GPS, rounded coordinates, newest first. Own
   * photos only, like the rest of places (FR-SRCH-4/5). One response: the quota bounds it.
   */
  app.get("/places/map", async (c) => {
    const userId = c.get("userId");
    const photos = await repos.photos.listLocated(userId);
    const body: PhotoLocationList = {
      items: photos.map((photo) => toPhotoLocation(userId, photo)),
    };
    return c.json(body);
  });

  /** One place's photos by date taken, like an album's (§12.3). */
  app.get(
    "/places/:placeId/photos",
    validate("param", placeParam),
    validate("query", listPhotosQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { placeId } = c.req.valid("param");
      const { sort, limit, cursor } = c.req.valid("query");
      orNotFound(await repos.places.get(userId, placeId), "Place not found");

      const page = await repos.places.listPhotos(userId, placeId, { sort, limit, cursor });
      const photos = await repos.photos.getMany(
        userId,
        page.items.map((item) => item.photoId),
      );
      const byId = new Map(photos.map((photo) => [photo.photoId, photo]));
      const body: PhotoPage = {
        // A photo being deleted can briefly outlive its place item; skip it.
        items: page.items.flatMap((item) => {
          const photo = byId.get(item.photoId);
          return photo ? [toPhoto(photo)] : [];
        }),
        nextCursor: page.nextCursor,
      };
      return c.json(body);
    },
  );
}
