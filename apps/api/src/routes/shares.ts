import {
  createShareRequestSchema,
  idSchema,
  pageQuerySchema,
  saveSharedPhotosRequestSchema,
  userIdSchema,
  type AlbumShare,
  type AlbumShareList,
  type SaveSharedPhotosResponse,
  type SharedAlbumPage,
  type ShareInvitationPage,
} from "@photo-app/shared";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { AppError, notFound, orNotFound, validationError } from "../lib/errors";
import { saveSharedPhotos } from "../lib/save";
import { validate } from "../lib/validation";
import { shareStatus, type ShareRecord } from "../repo";
import type { Deps } from ".";
import { albumAccess, albumPhoto } from "./access";
import { albumCovers } from "./albums";
import { coverThumbUrl, toSharedAlbum } from "./present";

const albumParam = z.object({ albumId: idSchema });
const albumShareParam = z.object({ albumId: idSchema, userId: userIdSchema });

/** `usernames`: current usernames by user ID (from `repos.usernames.getMany`). */
const toShare = (share: ShareRecord, usernames: Map<string, string>): AlbumShare => ({
  userId: share.userId,
  email: share.email ?? null,
  username: usernames.get(share.userId) ?? null,
  status: shareStatus(share),
  sharedAt: share.sharedAt,
});

/**
 * Sharing albums read-only by email or username (FR-SHR-1..5). Managing shares is owner-only: every
 * `/albums/{id}/shares` route first looks the album up under the caller's partition, so
 * recipients and everyone else get 404 and can't re-share or revoke (FR-SHR-4, NFR-SEC-2).
 * A new share is an invitation the recipient accepts or declines (FR-SHR-6); the recipient's routes
 * (`/share-invitations`, `/shared-albums/{id}`) only ever touch the share addressed to the caller.
 */
export function shareRoutes(
  app: Hono<AppEnv>,
  { repos, users, media, storage, config }: Deps,
): void {
  /** Who the album is shared with, oldest share first. */
  app.get("/albums/:albumId/shares", validate("param", albumParam), async (c) => {
    const { albumId } = c.req.valid("param");
    orNotFound(await repos.albums.get(c.get("userId"), albumId), "Album not found");
    const shares = await repos.shares.listForAlbum(albumId);
    shares.sort((a, b) => a.sharedAt.localeCompare(b.sharedAt));
    const usernames = await repos.usernames.getMany(shares.map((share) => share.userId));
    const body: AlbumShareList = { items: shares.map((share) => toShare(share, usernames)) };
    return c.json(body);
  });

  /**
   * Shares the album with the registered user who has this email (FR-SHR-1) or username
   * (FR-SHR-5): 201 with the new share, a pending invitation (FR-SHR-6); 200 with the existing
   * one if it was already shared with them. After a decline or leave there is none, so sharing
   * again invites them again. A share made by username stores no email, so the owner never
   * learns it.
   */
  app.post(
    "/albums/:albumId/shares",
    validate("param", albumParam),
    validate("json", createShareRequestSchema),
    async (c) => {
      const ownerId = c.get("userId");
      const { albumId } = c.req.valid("param");
      const target = c.req.valid("json");
      // Album first: a lookup for someone else's album would tell them who is registered.
      orNotFound(await repos.albums.get(ownerId, albumId), "Album not found");

      let recipient: { userId: string; email?: string } | null;
      if ("email" in target) {
        recipient = await users.findByEmail(target.email);
      } else {
        const userId = await repos.usernames.findUser(target.username);
        recipient = userId ? { userId } : null;
      }
      if (!recipient) {
        throw new AppError(
          404,
          "SHARE_TARGET_NOT_FOUND",
          "No registered user has this email or username",
        );
      }
      if (recipient.userId === ownerId) {
        throw validationError("You can't share an album with yourself");
      }

      const result = await repos.shares.create({
        albumId,
        ownerId,
        userId: recipient.userId,
        ...(recipient.email ? { email: recipient.email } : {}),
        status: "pending",
        sharedAt: new Date().toISOString(),
      });
      // Deleted between our check and the write.
      if (result === "album-not-found") throw notFound("Album not found");
      const usernames = await repos.usernames.getMany([recipient.userId]);
      const body: AlbumShare = toShare(result.share, usernames);
      return c.json(body, result.created ? 201 : 200);
    },
  );

  /**
   * Revokes a share (FR-SHR-2). The recipient loses access straight away, and the photos they
   * added leave the album (FR-SHR-11). The share goes first, so they can't add more meanwhile;
   * the clean-up also runs when the share is already gone, so repeating finishes it.
   */
  app.delete("/albums/:albumId/shares/:userId", validate("param", albumShareParam), async (c) => {
    const { albumId, userId } = c.req.valid("param");
    orNotFound(await repos.albums.get(c.get("userId"), albumId), "Album not found");
    const deleted = await repos.shares.delete(albumId, userId);
    await repos.albums.removeMemberPhotos(albumId, userId);
    if (!deleted) throw notFound("Share not found");
    return c.body(null, 204);
  });

  /**
   * Invitations to albums the caller hasn't accepted yet (FR-SHR-6), paginated: name, photo count
   * and who shared it, no cover until accepted.
   */
  app.get("/share-invitations", validate("query", pageQuerySchema), async (c) => {
    const { limit, cursor } = c.req.valid("query");
    const page = await repos.shares.listInvitations(c.get("userId"), { limit, cursor });
    const [albums, ownerNames] = await Promise.all([
      repos.albums.getMany(page.items),
      repos.usernames.getMany(page.items.map((share) => share.ownerId)),
    ]);
    const byKey = new Map(albums.map((album) => [`${album.ownerId}/${album.albumId}`, album]));
    const body: ShareInvitationPage = {
      // Skips invitations whose album is being deleted, as GET /shared-albums does.
      items: page.items.flatMap((share) => {
        const album = byKey.get(`${share.ownerId}/${share.albumId}`);
        if (!album) return [];
        return [
          {
            albumId: album.albumId,
            name: album.name,
            photoCount: album.photoCount,
            ownerId: album.ownerId,
            ownerUsername: ownerNames.get(share.ownerId) ?? null,
            sharedAt: share.sharedAt,
          },
        ];
      }),
      nextCursor: page.nextCursor,
    };
    return c.json(body);
  });

  /** Accepts an invitation (FR-SHR-6): the album moves to "Shared with me". Repeatable. */
  app.post("/shared-albums/:albumId/accept", validate("param", albumParam), async (c) => {
    const { albumId } = c.req.valid("param");
    const result = await repos.shares.accept(albumId, c.get("userId"), new Date().toISOString());
    if (result === "not-found") throw notFound("Invitation not found");
    return c.body(null, 204);
  });

  /**
   * The recipient declines an invitation or removes an accepted album (FR-SHR-7): the share is
   * deleted, so access ends at once and the owner's list no longer shows them. The photos they
   * added leave the album (FR-SHR-11; also when repeated, to finish an interrupted clean-up). The
   * owner can share again, which sends a new invitation.
   */
  app.delete("/shared-albums/:albumId", validate("param", albumParam), async (c) => {
    const userId = c.get("userId");
    const { albumId } = c.req.valid("param");
    const deleted = await repos.shares.delete(albumId, userId);
    // Only the caller's own photos, so this reveals nothing about albums they aren't in.
    await repos.albums.removeMemberPhotos(albumId, userId);
    if (!deleted) throw notFound("Shared album not found");
    return c.body(null, 204);
  });

  /**
   * "Save to my gallery" (FR-SHR-10): copies these photos of an album shared with me (accepted)
   * into my own library, one result per photo (`lib/save.ts`). The owner of a collaborative album
   * saves members' photos the same way (FR-SHR-11) through `/albums/{id}/save`. Photos not in the
   * album, not processed or gone are `unavailable`, so the answer says nothing more about them
   * (NFR-SEC-2); my own photos are `already-saved`.
   */
  for (const [path, mine] of [
    ["/shared-albums/:albumId/save", false],
    ["/albums/:albumId/save", true],
  ] as const) {
    app.post(
      path,
      validate("param", albumParam),
      validate("json", saveSharedPhotosRequestSchema),
      async (c) => {
        const userId = c.get("userId");
        const { albumId } = c.req.valid("param");
        const access = await albumAccess(repos, userId, albumId);
        if (!access || access.shared === mine) throw notFound("Album not found");
        const photoIds = [...new Set(c.req.valid("json").photoIds)];
        const sources = await Promise.all(
          photoIds.map(async (photoId) => {
            const membership = await repos.albums.getMembership(albumId, photoId);
            const photo =
              membership?.ownerId === userId
                ? await repos.photos.get(userId, photoId)
                : ((await albumPhoto(repos, userId, albumId, photoId))?.photo ?? null);
            return { photoId, photo };
          }),
        );
        const items = await saveSharedPhotos(
          { repos, storage, defaultQuotaBytes: config.defaultQuotaBytes },
          userId,
          sources,
        );
        const body: SaveSharedPhotosResponse = { items };
        return c.json(body);
      },
    );
  }

  /** Albums other users shared with the caller (FR-SHR-3), paginated. */
  app.get("/shared-albums", validate("query", pageQuerySchema), async (c) => {
    const { limit, cursor } = c.req.valid("query");
    const page = await repos.shares.listForRecipient(c.get("userId"), { limit, cursor });
    const [albums, ownerNames] = await Promise.all([
      repos.albums.getMany(page.items),
      repos.usernames.getMany(page.items.map((share) => share.ownerId)),
    ]);
    const byKey = new Map(albums.map((album) => [`${album.ownerId}/${album.albumId}`, album]));
    const userId = c.get("userId");
    const covers = await albumCovers(repos, albums);
    const now = new Date();
    // An album being deleted removes its shares only after reading them, so a share can
    // briefly outlive its album; skip it.
    const listed = page.items.flatMap((share) => {
      const album = byKey.get(`${share.ownerId}/${share.albumId}`);
      return album ? [{ share, album }] : [];
    });
    const body: SharedAlbumPage = {
      items: await Promise.all(
        listed.map(async ({ share, album }) =>
          toSharedAlbum(
            album,
            share,
            ownerNames.get(share.ownerId) ?? null,
            await coverThumbUrl(covers.get(album.albumId), userId, media, now),
          ),
        ),
      ),
      nextCursor: page.nextCursor,
    };
    return c.json(body);
  });
}
