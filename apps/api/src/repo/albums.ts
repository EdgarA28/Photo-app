import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Page } from "@photo-app/shared";
import {
  batchDelete,
  batchGet,
  isConditionalCheckFailed,
  queryAll,
  queryPage,
  stripKeys,
  type Db,
  type Item,
} from "./db";
import {
  ALBUM_SK_PREFIX,
  PHOTO_SK_PREFIX,
  TABLE_KEY_ATTRIBUTES,
  albumKey,
  albumPk,
  membershipKey,
  photoKey,
  userPk,
} from "./keys";
import { addMembership, removeMembership, type AddResult } from "./memberships";

/** Album item without key attributes (spec §8.2). */
export interface AlbumRecord {
  ownerId: string;
  albumId: string;
  name: string;
  createdAt: string;
  photoCount: number;
  coverPhotoId?: string;
}

export interface MembershipRecord {
  albumId: string;
  photoId: string;
  ownerId: string;
  addedAt: string;
}

export interface AlbumUpdate {
  name?: string | undefined;
  /** null clears the cover. */
  coverPhotoId?: string | null | undefined;
}

export function albumsRepo(db: Db) {
  return {
    async create(album: {
      ownerId: string;
      albumId: string;
      name: string;
      createdAt: string;
    }): Promise<AlbumRecord> {
      const record: AlbumRecord = { ...album, photoCount: 0 };
      await db.client.send(
        new PutCommand({
          TableName: db.table,
          Item: { ...albumKey(album.ownerId, album.albumId), entity: "album", ...record },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return record;
    },

    get: (ownerId: string, albumId: string) => getAlbum(db, ownerId, albumId),

    /**
     * Several albums, possibly of different owners (GET /shared-albums). Missing ones are left
     * out. Not scoped to a user: the caller must hold a share for each.
     */
    async getMany(refs: { ownerId: string; albumId: string }[]): Promise<AlbumRecord[]> {
      if (refs.length === 0) return [];
      const keys = new Map(
        refs.map((r) => [`${r.ownerId}/${r.albumId}`, albumKey(r.ownerId, r.albumId)]),
      );
      const items = await batchGet(db, [...keys.values()]);
      return items.map((item) => stripKeys<AlbumRecord>(item));
    },

    /** All of a user's albums, oldest first (GET /albums is not paginated). */
    async list(ownerId: string): Promise<AlbumRecord[]> {
      const items = await queryAll(db, {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": userPk(ownerId), ":prefix": ALBUM_SK_PREFIX },
      });
      return items.map((item) => stripKeys<AlbumRecord>(item));
    },

    /**
     * Rename and/or set/clear the cover (PATCH /albums/{id}). A new cover must be a photo in the
     * album; returns "cover-not-in-album" otherwise. Returns null if the album does not exist.
     */
    async update(
      ownerId: string,
      albumId: string,
      changes: AlbumUpdate,
    ): Promise<AlbumRecord | "cover-not-in-album" | null> {
      if (typeof changes.coverPhotoId === "string") {
        // Ownership first: a membership answer for someone else's album would leak which
        // photos it contains (other users' resources are indistinguishable from missing ones).
        if (!(await getAlbum(db, ownerId, albumId))) return null;
        const membership = await db.client.send(
          new GetCommand({
            TableName: db.table,
            Key: membershipKey(albumId, changes.coverPhotoId),
          }),
        );
        if (!membership.Item) return "cover-not-in-album";
      }

      const set: string[] = [];
      const remove: string[] = [];
      const values: Item = {};
      if (changes.name !== undefined) {
        set.push("#name = :name");
        values[":name"] = changes.name;
      }
      if (changes.coverPhotoId === null) remove.push("coverPhotoId");
      else if (changes.coverPhotoId !== undefined) {
        set.push("coverPhotoId = :cover");
        values[":cover"] = changes.coverPhotoId;
      }
      if (set.length === 0 && remove.length === 0) return getAlbum(db, ownerId, albumId);

      const expression = [
        set.length > 0 ? `SET ${set.join(", ")}` : "",
        remove.length > 0 ? `REMOVE ${remove.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      try {
        const output = await db.client.send(
          new UpdateCommand({
            TableName: db.table,
            Key: albumKey(ownerId, albumId),
            UpdateExpression: expression,
            ConditionExpression: "attribute_exists(PK)",
            ...(changes.name !== undefined
              ? { ExpressionAttributeNames: { "#name": "name" } }
              : {}),
            ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
            ReturnValues: "ALL_NEW",
          }),
        );
        return output.Attributes ? stripKeys<AlbumRecord>(output.Attributes) : null;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return null;
        throw err;
      }
    },

    /**
     * Deletes an album, its memberships and its shares; the photos stay (FR-ALB-1). Children are
     * removed first and the album item last, so a retry after a partial failure finishes the job.
     * Returns false if the album does not exist.
     */
    async delete(ownerId: string, albumId: string): Promise<boolean> {
      const album = await getAlbum(db, ownerId, albumId);
      if (!album) return false;

      const children = await queryAll(db, {
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": albumPk(albumId) },
        ProjectionExpression: "PK, SK, photoId",
      });
      // Unlink photos first so no photo keeps pointing at the deleted album.
      await Promise.all(
        children
          .filter((child) => typeof child.photoId === "string")
          .map((child) => unlinkPhoto(db, ownerId, albumId, child.photoId as string)),
      );
      await batchDelete(
        db,
        children.map((child) => ({ PK: child.PK, SK: child.SK })),
      );
      try {
        await db.client.send(
          new DeleteCommand({
            TableName: db.table,
            Key: albumKey(ownerId, albumId),
            ConditionExpression: "attribute_exists(PK)",
          }),
        );
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
      }
      return true;
    },

    /** Adds the owner's photos to the album (FR-ALB-2). One result per distinct photo ID. */
    async addPhotos(
      ownerId: string,
      albumId: string,
      photoIds: string[],
      addedAt: string,
    ): Promise<Map<string, AddResult>> {
      const results = new Map<string, AddResult>();
      for (const photoId of new Set(photoIds)) {
        results.set(photoId, await addMembership(db, ownerId, albumId, photoId, addedAt));
      }
      return results;
    },

    /** Returns false if the photo was not in the album, or the album is not `ownerId`'s. */
    removePhoto: (ownerId: string, albumId: string, photoId: string) =>
      removeMembership(db, ownerId, albumId, photoId),

    /**
     * Memberships in upload order (photo IDs are ULIDs). Callers load the photos themselves.
     * Not scoped to a user: the caller must first check the album is the user's or shared with them.
     */
    async listMemberships(
      albumId: string,
      options: { limit: number; cursor?: string | undefined },
    ): Promise<Page<MembershipRecord>> {
      const page = await queryPage(db, {
        input: {
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": albumPk(albumId), ":prefix": PHOTO_SK_PREFIX },
        },
        keyAttributes: TABLE_KEY_ATTRIBUTES,
        partition: { attribute: "PK", value: albumPk(albumId) },
        limit: options.limit,
        cursor: options.cursor,
      });
      return { ...page, items: page.items.map((item) => stripKeys<MembershipRecord>(item)) };
    },

    /**
     * Is this photo in this album? Used by the shared-photo access check (§8.2, 5.13).
     * Not scoped to a user: only meaningful after an ownership or share check on the album.
     */
    async hasPhoto(albumId: string, photoId: string): Promise<boolean> {
      const output = await db.client.send(
        new GetCommand({
          TableName: db.table,
          Key: membershipKey(albumId, photoId),
          ProjectionExpression: "PK",
        }),
      );
      return output.Item !== undefined;
    },
  };
}

async function unlinkPhoto(db: Db, ownerId: string, albumId: string, photoId: string) {
  try {
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        Key: photoKey(ownerId, photoId),
        UpdateExpression: "DELETE albumIds :album",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":album": new Set([albumId]) },
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err; // Photo already deleted.
  }
}

async function getAlbum(db: Db, ownerId: string, albumId: string): Promise<AlbumRecord | null> {
  const output = await db.client.send(
    new GetCommand({ TableName: db.table, Key: albumKey(ownerId, albumId) }),
  );
  return output.Item ? stripKeys<AlbumRecord>(output.Item) : null;
}
