import { DeleteCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Page } from "@photo-app/shared";
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
  shareKey,
  sharedWithPk,
} from "./keys";

/** Album share item without key attributes (spec §8.2, FR-SHR-1..4). */
export interface ShareRecord {
  albumId: string;
  ownerId: string;
  /** Recipient's Cognito `sub`. */
  userId: string;
  /** Recipient's email at share time, for the owner's share list. */
  email: string;
  sharedAt: string;
}

export type CreateShareResult = { created: boolean; share: ShareRecord } | "album-not-found";

export function sharesRepo(db: Db) {
  const shareItem = (share: ShareRecord) => ({
    ...shareKey(share.albumId, share.userId),
    GSI1PK: sharedWithPk(share.userId),
    GSI1SK: albumSk(share.albumId),
    entity: "share",
    ...share,
  });

  return {
    /**
     * Shares an album (POST /albums/{id}/shares, FR-SHR-1), only while the owner's album exists
     * (checked in the same transaction). An existing share is kept as it is (its `sharedAt`
     * stays), so sharing twice is harmless: `created` tells the two apart.
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

    /** Albums shared with a user (FR-SHR-3), via GSI1. */
    async listForRecipient(
      userId: string,
      options: { limit: number; cursor?: string | undefined },
    ): Promise<Page<ShareRecord>> {
      const page = await queryPage(db, {
        input: {
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
          ExpressionAttributeValues: { ":pk": sharedWithPk(userId), ":prefix": ALBUM_SK_PREFIX },
        },
        keyAttributes: GSI1_KEY_ATTRIBUTES,
        partition: { attribute: "GSI1PK", value: sharedWithPk(userId) },
        limit: options.limit,
        cursor: options.cursor,
      });
      return { ...page, items: page.items.map((item) => stripKeys<ShareRecord>(item)) };
    },

    /** Revokes a share (FR-SHR-4). Returns false if it did not exist. */
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

async function getShare(db: Db, albumId: string, userId: string): Promise<ShareRecord | null> {
  const output = await db.client.send(
    new GetCommand({ TableName: db.table, Key: shareKey(albumId, userId), ConsistentRead: true }),
  );
  return output.Item ? stripKeys<ShareRecord>(output.Item) : null;
}
