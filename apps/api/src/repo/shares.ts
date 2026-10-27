import {
  DeleteCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Page, ShareStatus } from "@photo-app/shared";
import {
  conditionFailedAt,
  isConditionalCheckFailed,
  queryAll,
  queryPage,
  stripKeys,
  type Db,
} from "./db";
import {
  ALBUM_SK_PREFIX,
  GSI1,
  GSI1_KEY_ATTRIBUTES,
  SHARE_SK_PREFIX,
  albumKey,
  albumPk,
  albumSk,
  invitedPk,
  shareKey,
  sharedWithPk,
} from "./keys";

/** Album share item without key attributes (spec §8.2, FR-SHR-1..4). */
export interface ShareRecord {
  albumId: string;
  ownerId: string;
  /** Recipient's Cognito `sub`. */
  userId: string;
  /**
   * Recipient's email at share time, for the owner's share list. Absent for shares made by
   * username, so the owner never learns it (FR-SHR-5).
   */
  email?: string;
  /**
   * `pending` until the recipient accepts (FR-SHR-6); only accepted shares give access. Shares
   * made before invitations existed have none and count as accepted.
   */
  status?: ShareStatus;
  sharedAt: string;
  acceptedAt?: string;
}

export type CreateShareResult = { created: boolean; share: ShareRecord } | "album-not-found";

/** Does this share give its recipient access to the album? (FR-SHR-6) */
export const isAccepted = (share: ShareRecord) => share.status !== "pending";

/** Its status as the API reports it: shares without one are accepted. */
export const shareStatus = (share: ShareRecord): ShareStatus =>
  isAccepted(share) ? "accepted" : "pending";

export function sharesRepo(db: Db) {
  const shareItem = (share: ShareRecord) => ({
    ...shareKey(share.albumId, share.userId),
    // Invitations and accepted shares are listed apart: no filtering, pages stay full.
    GSI1PK: isAccepted(share) ? sharedWithPk(share.userId) : invitedPk(share.userId),
    GSI1SK: albumSk(share.albumId),
    entity: "share",
    ...share,
  });

  return {
    /**
     * Shares an album (POST /albums/{id}/shares, FR-SHR-1), only while the owner's album exists
     * (checked in the same transaction). An existing share is kept as it is (its `sharedAt` and
     * status stay), so sharing twice is harmless: `created` tells the two apart. New shares are
     * invitations: pass `status: "pending"` (FR-SHR-6).
     */
    async create(share: ShareRecord): Promise<CreateShareResult> {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await db.client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: {
                    TableName: db.table,
                    Key: albumKey(share.ownerId, share.albumId),
                    ConditionExpression: "attribute_exists(PK)",
                  },
                },
                {
                  Put: {
                    TableName: db.table,
                    Item: shareItem(share),
                    ConditionExpression: "attribute_not_exists(PK)",
                  },
                },
              ],
            }),
          );
          return { created: true, share };
        } catch (err) {
          if (conditionFailedAt(err, 0)) return "album-not-found";
          if (!conditionFailedAt(err, 1)) throw err;
        }
        const existing = await getShare(db, share.albumId, share.userId);
        if (existing) return { created: false, share: existing };
        // Revoked between our write and read: try again.
      }
      throw new Error(`Share of album ${share.albumId} kept changing while being created`);
    },

    get: (albumId: string, userId: string) => getShare(db, albumId, userId),

    /** Who an album is shared with (owner's view, not paginated). */
    async listForAlbum(albumId: string): Promise<ShareRecord[]> {
      const items = await queryAll(db, {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": albumPk(albumId), ":prefix": SHARE_SK_PREFIX },
      });
      return items.map((item) => stripKeys<ShareRecord>(item));
    },

    /** Albums shared with a user that they accepted (FR-SHR-3), via GSI1. */
    listForRecipient: (userId: string, options: PageOptions) =>
      listByGsi1(db, sharedWithPk(userId), options),

    /** Shares a user hasn't accepted yet (FR-SHR-6), via GSI1. */
    listInvitations: (userId: string, options: PageOptions) =>
      listByGsi1(db, invitedPk(userId), options),

    /**
     * The recipient accepts an invitation (FR-SHR-6): from now on it gives access and is listed
     * under "Shared with me". Accepting twice is harmless ("already-accepted").
     */
    async accept(
      albumId: string,
      userId: string,
      now: string,
    ): Promise<"accepted" | "already-accepted" | "not-found"> {
      try {
        await db.client.send(
          new UpdateCommand({
            TableName: db.table,
            Key: shareKey(albumId, userId),
            UpdateExpression: "SET #status = :accepted, acceptedAt = :now, GSI1PK = :pk",
            ConditionExpression: "attribute_exists(PK) AND #status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":accepted": "accepted",
              ":pending": "pending",
              ":now": now,
              ":pk": sharedWithPk(userId),
            },
          }),
        );
        return "accepted";
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
      }
      return (await getShare(db, albumId, userId)) ? "already-accepted" : "not-found";
    },

    /**
     * Removes a share: the owner revokes it (FR-SHR-2) or the recipient declines or leaves it
     * (FR-SHR-7). Returns false if it did not exist.
     */
    async delete(albumId: string, userId: string): Promise<boolean> {
      try {
        await db.client.send(
          new DeleteCommand({
            TableName: db.table,
            Key: shareKey(albumId, userId),
            ConditionExpression: "attribute_exists(PK)",
          }),
        );
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },
  };
}

type PageOptions = { limit: number; cursor?: string | undefined };

async function listByGsi1(
  db: Db,
  gsi1pk: string,
  options: PageOptions,
): Promise<Page<ShareRecord>> {
  const page = await queryPage(db, {
    input: {
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
      ExpressionAttributeValues: { ":pk": gsi1pk, ":prefix": ALBUM_SK_PREFIX },
    },
    keyAttributes: GSI1_KEY_ATTRIBUTES,
    partition: { attribute: "GSI1PK", value: gsi1pk },
    limit: options.limit,
    cursor: options.cursor,
  });
  return { ...page, items: page.items.map((item) => stripKeys<ShareRecord>(item)) };
}

async function getShare(db: Db, albumId: string, userId: string): Promise<ShareRecord | null> {
  const output = await db.client.send(
    new GetCommand({ TableName: db.table, Key: shareKey(albumId, userId), ConsistentRead: true }),
  );
  return output.Item ? stripKeys<ShareRecord>(output.Item) : null;
}
