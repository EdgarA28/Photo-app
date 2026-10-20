import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Page } from "@photo-app/shared";
import { isConditionalCheckFailed, queryAll, queryPage, stripKeys, type Db } from "./db";
import {
  ALBUM_SK_PREFIX,
  GSI1,
  GSI1_KEY_ATTRIBUTES,
  SHARE_SK_PREFIX,
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

export function sharesRepo(db: Db) {
  return {
    /** Creates or refreshes a share (re-sharing to the same user is idempotent). */
    async put(share: ShareRecord): Promise<ShareRecord> {
      await db.client.send(
        new PutCommand({
          TableName: db.table,
          Item: {
            ...shareKey(share.albumId, share.userId),
            GSI1PK: sharedWithPk(share.userId),
            GSI1SK: albumSk(share.albumId),
            entity: "share",
            ...share,
          },
        }),
      );
      return share;
    },

    async get(albumId: string, userId: string): Promise<ShareRecord | null> {
      const output = await db.client.send(
        new GetCommand({ TableName: db.table, Key: shareKey(albumId, userId) }),
      );
      return output.Item ? stripKeys<ShareRecord>(output.Item) : null;
    },

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
