import {
  addAlbumPhotosRequestSchema,
  createAlbumRequestSchema,
  idSchema,
  newId,
  listPhotosQuerySchema,
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
import type { AlbumRecord, AddResult, PhotoRecord, Repositories } from "../repo";
import type { Deps } from ".";
import { activeContributors, albumAccess, isVisibleToOthers } from "./access";
import { coverThumbUrl, toAlbum, toPhoto, toSharedPhoto } from "./present";

const albumParam = z.object({ albumId: idSchema });
const albumPhotoParam = z.object({ albumId: idSchema, photoId: idSchema });

/**
 * Albums (FR-ALB-1, FR-ALB-2). Changing an album (rename, cover, delete, the members' switch) is
 * owner-only: those routes look the album up under the caller's partition, so other users' albums
 * are 404 (NFR-SEC-2), including for share recipients (FR-SHR-4). Recipients may read the photos
 * (5.13), and in a collaborative album add and remove their own (FR-SHR-11). Shares themselves are
 * in shares.ts.
 */
export function albumRoutes(app: Hono<AppEnv>, { repos, media }: Deps): void {
  app.get("/albums", async (c) => {
    const userId = c.get("userId");
    const albums = await repos.albums.list(userId);
    const now = new Date();
    const covers = await albumCovers(repos, albums);
    const body: AlbumList = {
      items: await Promise.all(
        albums.map(async (album) =>
          toAlbum(album, await coverThumbUrl(covers.get(album.albumId), userId, media, now)),
        ),
      ),
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
      const changes = c.req.valid("json");
      // A member's photo can become the cover only while they are a member (FR-SHR-11): a leftover
      // of an interrupted leave counts as not in the album. Ownership first (no oracle).
      if (typeof changes.coverPhotoId === "string") {
        const own = await repos.albums.get(userId, albumId);
        const membership = own && (await repos.albums.getMembership(albumId, changes.coverPhotoId));
        if (own && membership && membership.ownerId !== userId) {
          const active = await activeContributors(repos, own, [membership.ownerId]);
          if (!active.has(membership.ownerId)) {
            throw validationError("coverPhotoId: photo is not in this album");
          }
        }
      }
      const result = await repos.albums.update(userId, albumId, changes);
      if (result === "cover-not-in-album") {
        throw validationError("coverPhotoId: photo is not in this album");
      }
      const record = orNotFound(result, "Album not found");
      const covers = await albumCovers(repos, [record]);
      const body: Album = toAlbum(
        record,
        await coverThumbUrl(covers.get(record.albumId), userId, media, new Date()),
      );
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
   * Album photos by date taken, newest first unless `?sort=taken-asc` (GSI1, §9, §12.3), paginated.
   * For the owner, or for a recipient of the share (FR-SHR-4). In a collaborative album the photos
   * are several people's (FR-SHR-11): the caller's own come as in the gallery, everyone else's
   * only when processed, with signed URLs and without their place. Each says who added it.
   */
  app.get(
    "/albums/:albumId/photos",
    validate("param", albumParam),
    validate("query", listPhotosQuerySchema),
    async (c) => {
      const userId = c.get("userId");
      const { albumId } = c.req.valid("param");
      const { sort, limit, cursor } = c.req.valid("query");
      const { album } = orNotFound(await albumAccess(repos, userId, albumId), "Album not found");

      const page = await repos.albums.listMemberships(albumId, { sort, limit, cursor });
      const byOwner = new Map<string, string[]>();
      for (const m of page.items)
        byOwner.set(m.ownerId, [...(byOwner.get(m.ownerId) ?? []), m.photoId]);
      const active = await activeContributors(repos, album, byOwner.keys());
      const [photoLists, usernames] = await Promise.all([
        Promise.all(
          // Each photo under the owner its membership names, and only owners who still count.
          [...byOwner]
            .filter(([ownerId]) => active.has(ownerId))
            .map(([ownerId, ids]) => repos.photos.getMany(ownerId, ids)),
        ),
        repos.usernames.getMany([...byOwner.keys()]),
      ]);
      const byKey = new Map(photoLists.flat().map((p) => [`${p.userId}/${p.photoId}`, p]));
      // A photo being deleted can briefly outlive its membership; skip it.
      const records = page.items.flatMap((m) => {
        const photo = byKey.get(`${m.ownerId}/${m.photoId}`);
        if (!photo) return [];
        return photo.userId === userId || isVisibleToOthers(photo) ? [photo] : [];
      });
      const now = new Date();
      const body: PhotoPage = {
        items: await Promise.all(
          records.map(async (photo) => {
            const ownerUsername = usernames.get(photo.userId) ?? null;
            if (photo.userId === userId) return { ...toPhoto(photo), ownerUsername };
            return toSharedPhoto(photo, media, now, { preview: false, ownerUsername });
          }),
        ),
        nextCursor: page.nextCursor,
      };
      return c.json(body);
    },
  );

  /**
   * Adds the caller's own photos to an album (FR-ALB-2): their own album, or one shared with them
   * that lets members add (FR-SHR-11; 404 if it doesn't, NFR-SEC-2). Idempotent: photos already
   * in the album are fine. Any unknown (or someone else's) photo makes the whole request 404
   * before anything is added.
   */
  app.post(
    "/albums/:albumId/photos",
    validate("param", albumParam),
    validate("json", addAlbumPhotosRequestSchema),
    async (c) => {
      const userId = c.get("userId");
      const { albumId } = c.req.valid("param");
      const photoIds = [...new Set(c.req.valid("json").photoIds)];
      const { album, shared } = orNotFound(
        await albumAccess(repos, userId, albumId),
        "Album not found",
      );
      if (shared && !album.membersCanAdd) throw membersCantAdd();
      const found = await repos.photos.getMany(userId, photoIds);
      if (found.length !== photoIds.length) throw notFound("Photo not found");

      const addedAt = new Date().toISOString();
      const results: Set<AddResult> = new Set(
        (shared
          ? await repos.albums.addMemberPhotos(userId, album.ownerId, albumId, photoIds, addedAt)
          : await repos.albums.addPhotos(userId, albumId, photoIds, addedAt)
        ).values(),
      );
      // Only possible if the album, a photo or the share changed concurrently.
      if (results.has("album-not-found")) throw notFound("Album not found");
      if (results.has("not-allowed")) throw membersCantAdd();
      if (results.has("photo-not-found")) throw notFound("Photo not found");
      return c.body(null, 204);
    },
  );

  /**
   * Removes a photo from an album; the photo itself stays (FR-ALB-2). The album's owner may remove
   * any photo; anyone may take their own photo out of an album they are in (FR-SHR-11).
   */
  app.delete("/albums/:albumId/photos/:photoId", validate("param", albumPhotoParam), async (c) => {
    const userId = c.get("userId");
    const { albumId, photoId } = c.req.valid("param");
    const own = await repos.albums.get(userId, albumId);
    // Album first: a membership answer for someone else's album would tell what's in it.
    const membership =
      own || (await albumAccess(repos, userId, albumId))
        ? await repos.albums.getMembership(albumId, photoId)
        : null;
    if (!membership) throw notFound("Photo not found in album");
    // Someone else's photo in an album that isn't mine: like a missing one (NFR-SEC-2).
    if (!own && membership.ownerId !== userId) throw notFound("Photo not found in album");
    if (!(await repos.albums.removePhoto(membership.ownerId, albumId, photoId))) {
      throw notFound("Photo not found in album");
    }
    return c.body(null, 204);
  });
}

/**
 * A member of an album that doesn't let members add (FR-SHR-11): 404 like for anyone else's
 * album (NFR-SEC-2); the app only offers adding when the album allows it.
 */
const membersCantAdd = () => notFound("Album not found");

/**
 * Cover photos of these albums, by album ID: one batch read per photo owner. A member's photo
 * (FR-SHR-11) is a cover only while that member still holds an accepted share of the album, as
 * for the photo lists (`activeContributors`): a leave whose clean-up was interrupted must not
 * keep the former member's photo on show.
 */
export async function albumCovers(
  repos: Repositories,
  albums: AlbumRecord[],
): Promise<Map<string, PhotoRecord>> {
  const withCover = await Promise.all(
    albums.map(async (album) => {
      if (!album.coverPhotoId) return null;
      const owner = album.coverOwnerId ?? album.ownerId;
      if (
        owner !== album.ownerId &&
        !(await activeContributors(repos, album, [owner])).has(owner)
      ) {
        return null;
      }
      return { album, owner, photoId: album.coverPhotoId };
    }),
  );
  const covers = withCover.filter((c) => c !== null);
  const idsByOwner = new Map<string, string[]>();
  for (const { owner, photoId } of covers) {
    idsByOwner.set(owner, [...(idsByOwner.get(owner) ?? []), photoId]);
  }
  const photos = await Promise.all(
    [...idsByOwner].map(([ownerId, ids]) => repos.photos.getMany(ownerId, ids)),
  );
  const byKey = new Map(photos.flat().map((photo) => [`${photo.userId}/${photo.photoId}`, photo]));
  return new Map(
    covers.flatMap(({ album, owner, photoId }) => {
      const photo = byKey.get(`${owner}/${photoId}`);
      return photo ? [[album.albumId, photo] as const] : [];
    }),
  );
}
