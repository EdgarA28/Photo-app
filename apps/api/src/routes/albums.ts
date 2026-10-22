import {
  addAlbumPhotosRequestSchema,
  createAlbumRequestSchema,
  idSchema,
  newId,
  pageQuerySchema,
  updateAlbumRequestSchema,
  type Album,
  type AlbumList,
  type PhotoPage,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { notFound, orNotFound, validationError } from "../lib/errors";
import { validate } from "../lib/validation";
import type { AlbumRecord, PhotoRecord, Repositories } from "../repo";
import type { Deps } from ".";
import { albumAccess, isVisibleToRecipient } from "./access";
import { toAlbum, toPhoto, toSharedPhoto } from "./present";

const albumParam = z.object({ albumId: idSchema });
const albumPhotoParam = z.object({ albumId: idSchema, photoId: idSchema });

/**
 * The caller's own albums (FR-ALB-1, FR-ALB-2). Every route looks the album up under the caller's
 * partition, so other users' albums are 404 (NFR-SEC-2), including for share recipients, who
 * can't modify them (FR-SHR-4). The one route recipients may read is `GET /albums/{id}/photos`
 * (5.13). Shares themselves are in shares.ts.
 */
export function albumRoutes(app: Hono<AppEnv>, { repos }: Deps): void {
  app.get("/albums", async (c) => {
    const userId = c.get("userId");
    const albums = await repos.albums.list(userId);
    const covers = await coverPhotos(repos, userId, albums);
    const body: AlbumList = {
      items: albums.map((album) => toAlbum(album, covers.get(album.coverPhotoId ?? ""))),
    };
    return c.json(body);
  });

  app.post("/albums", validate("json", createAlbumRequestSchema), async (c) => {
    const { name } = c.req.valid("json");
    const record = await repos.albums.create({
      ownerId: c.get("userId"),
      albumId: newId(),
      name,
      createdAt: new Date().toISOString(),
    });
    const body: Album = toAlbum(record, null);
    return c.json(body, 201);
  });

  app.patch(
    "/albums/:albumId",
    validate("param", albumParam),
    validate("json", updateAlbumRequestSchema),
    async (c) => {
      const userId = c.get("userId");
      const { albumId } = c.req.valid("param");
      const result = await repos.albums.update(userId, albumId, c.req.valid("json"));
      if (result === "cover-not-in-album") {
        throw validationError("coverPhotoId: photo is not in this album");
      }
      const record = orNotFound(result, "Album not found");
      const covers = await coverPhotos(repos, userId, [record]);
      const body: Album = toAlbum(record, covers.get(record.coverPhotoId ?? ""));
      return c.json(body);
    },
  );

  /** Deletes the album, its memberships and shares; never the photos (FR-ALB-1). */
  app.delete("/albums/:albumId", validate("param", albumParam), async (c) => {
    const { albumId } = c.req.valid("param");
    if (!(await repos.albums.delete(c.get("userId"), albumId))) throw notFound("Album not found");
    return c.body(null, 204);
  });

  /**
   * Album photos in upload order (memberships are keyed by the photo ULID, §8.2), paginated. For
   * the owner, or for a recipient of the share (FR-SHR-4), who sees only `ready` photos.
   */
  app.get(
    "/albums/:albumId/photos",
    validate("param", albumParam),
    validate("query", pageQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { albumId } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const { album, shared } = orNotFound(
        await albumAccess(repos, userId, albumId),
        "Album not found",
      );

      const page = await repos.albums.listMemberships(albumId, { limit, cursor });
      // Under the album's owner: memberships only ever point at the owner's photos.
      const photos = await repos.photos.getMany(
        album.ownerId,
        page.items.map((membership) => membership.photoId),
      );
      const byId = new Map(photos.map((photo) => [photo.photoId, photo]));
      const body: PhotoPage = {
        // A photo being deleted can briefly outlive its membership; skip it.
        items: page.items.flatMap((membership) => {
          const photo = byId.get(membership.photoId);
          if (!photo) return [];
          if (!shared) return [toPhoto(photo)];
          return isVisibleToRecipient(photo) ? [toSharedPhoto(photo)] : [];
        }),
        nextCursor: page.nextCursor,
      };
      return c.json(body);
    },
  );

  /**
   * Adds own photos to an own album (FR-ALB-2). Idempotent: photos already in the album are fine.
   * Any unknown (or someone else's) photo makes the whole request 404 before anything is added.
   */
  app.post(
    "/albums/:albumId/photos",
    validate("param", albumParam),
    validate("json", addAlbumPhotosRequestSchema),
    async (c) => {
      const userId = c.get("userId");
      const { albumId } = c.req.valid("param");
      const photoIds = [...new Set(c.req.valid("json").photoIds)];
      orNotFound(await repos.albums.get(userId, albumId), "Album not found");
      const found = await repos.photos.getMany(userId, photoIds);
      if (found.length !== photoIds.length) throw notFound("Photo not found");

      const results = new Set(
        (
          await repos.albums.addPhotos(userId, albumId, photoIds, new Date().toISOString())
        ).values(),
      );
      // Only possible if the album or a photo was deleted concurrently.
      if (results.has("album-not-found")) throw notFound("Album not found");
      if (results.has("photo-not-found")) throw notFound("Photo not found");
      return c.body(null, 204);
    },
  );

  /** Removes a photo from an album; the photo itself stays (FR-ALB-2). */
  app.delete("/albums/:albumId/photos/:photoId", validate("param", albumPhotoParam), async (c) => {
    const { albumId, photoId } = c.req.valid("param");
    if (!(await repos.albums.removePhoto(c.get("userId"), albumId, photoId))) {
      throw notFound("Photo not found in album");
    }
    return c.body(null, 204);
  });
}

/** Cover photos of the given albums, by photo ID (for `coverThumbUrl`). */
async function coverPhotos(
  repos: Repositories,
  userId: string,
  albums: AlbumRecord[],
): Promise<Map<string, PhotoRecord>> {
  const ids = albums.flatMap((album) => (album.coverPhotoId ? [album.coverPhotoId] : []));
  const photos = ids.length > 0 ? await repos.photos.getMany(userId, ids) : [];
  return new Map(photos.map((photo) => [photo.photoId, photo]));
}
