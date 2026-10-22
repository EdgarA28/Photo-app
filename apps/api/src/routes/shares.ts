import {
  createShareRequestSchema,
  idSchema,
  pageQuerySchema,
  userIdSchema,
  type AlbumShare,
  type AlbumShareList,
  type SharedAlbumPage,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, notFound, orNotFound, validationError } from "../lib/errors";
import { validate } from "../lib/validation";
import type { ShareRecord } from "../repo";
import type { Deps } from ".";
import { toSharedAlbum } from "./present";

const albumParam = z.object({ albumId: idSchema });
const albumShareParam = z.object({ albumId: idSchema, userId: userIdSchema });

const toShare = ({ userId, email, sharedAt }: ShareRecord): AlbumShare => ({
  userId,
  email,
  sharedAt,
});

/**
 * Sharing albums read-only by email (FR-SHR-1..4). Managing shares is owner-only: every
 * `/albums/{id}/shares` route first looks the album up under the caller's partition, so
 * recipients and everyone else get 404 and can't re-share or revoke (FR-SHR-4, NFR-SEC-2).
 */
export function shareRoutes(app: Hono<AppEnv>, { repos, users }: Deps): void {
  /** Who the album is shared with, oldest share first. */
  app.get("/albums/:albumId/shares", validate("param", albumParam), async (c) => {
    const { albumId } = c.req.valid("param");
    orNotFound(await repos.albums.get(c.get("userId"), albumId), "Album not found");
    const shares = await repos.shares.listForAlbum(albumId);
    shares.sort((a, b) => a.sharedAt.localeCompare(b.sharedAt));
    const body: AlbumShareList = { items: shares.map(toShare) };
    return c.json(body);
  });

  /**
   * Shares the album with the registered user who has this email (FR-SHR-1): 201 with the new
   * share, 200 with the existing one if it was already shared with them.
   */
  app.post(
    "/albums/:albumId/shares",
    validate("param", albumParam),
    validate("json", createShareRequestSchema),
    async (c) => {
      const ownerId = c.get("userId");
      const { albumId } = c.req.valid("param");
      const { email } = c.req.valid("json");
      // Album first: an email lookup for someone else's album would tell them who is registered.
      orNotFound(await repos.albums.get(ownerId, albumId), "Album not found");

      const recipient = await users.findByEmail(email);
      if (!recipient) {
        throw new AppError(404, "SHARE_TARGET_NOT_FOUND", "No registered user has this email");
      }
      if (recipient.userId === ownerId) {
        throw validationError("You can't share an album with yourself");
      }

      const result = await repos.shares.create({
        albumId,
        ownerId,
        userId: recipient.userId,
        email: recipient.email,
        sharedAt: new Date().toISOString(),
      });
      // Deleted between our check and the write.
      if (result === "album-not-found") throw notFound("Album not found");
      const body: AlbumShare = toShare(result.share);
      return c.json(body, result.created ? 201 : 200);
    },
  );

  /** Revokes a share (FR-SHR-2). The recipient loses access straight away. */
  app.delete("/albums/:albumId/shares/:userId", validate("param", albumShareParam), async (c) => {
    const { albumId, userId } = c.req.valid("param");
    orNotFound(await repos.albums.get(c.get("userId"), albumId), "Album not found");
    if (!(await repos.shares.delete(albumId, userId))) throw notFound("Share not found");
    return c.body(null, 204);
  });

  /** Albums other users shared with the caller (FR-SHR-3), paginated. */
  app.get("/shared-albums", validate("query", pageQuerySchema), async (c) => {
    const { limit, cursor } = c.req.valid("query");
    const page = await repos.shares.listForRecipient(c.get("userId"), { limit, cursor });
    const albums = await repos.albums.getMany(page.items);
    const byKey = new Map(albums.map((album) => [`${album.ownerId}/${album.albumId}`, album]));
    const body: SharedAlbumPage = {
      // An album being deleted removes its shares only after reading them, so a share can
      // briefly outlive its album; skip it.
      items: page.items.flatMap((share) => {
        const album = byKey.get(`${share.ownerId}/${share.albumId}`);
        return album ? [toSharedAlbum(album, share)] : [];
      }),
      nextCursor: page.nextCursor,
    };
    return c.json(body);
  });
}
