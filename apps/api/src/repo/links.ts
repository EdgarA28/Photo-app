import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { stripKeys, type Db } from "./db";
import { linkKey } from "./keys";

/**
 * Public photo links (FR-SHR-8, §8.2): item `LINK#{token}` / `LINK`. The token is the only key,
 * so a link reveals nothing but its one photo. `ttl` (epoch seconds) lets DynamoDB remove expired
 * items; that can take days, so readers check `expiresAt` themselves.
 */
export interface LinkRecord {
  token: string;
  ownerId: string;
  photoId: string;
  createdAt: string;
  expiresAt: string;
}

export function linksRepo(db: Db) {
  return {
    async create(link: LinkRecord): Promise<void> {
      await db.client.send(
        new PutCommand({
          TableName: db.table,
          Item: {
            ...linkKey(link.token),
            entity: "link",
            ...link,
            ttl: Math.ceil(Date.parse(link.expiresAt) / 1000),
          },
          // 128 random bits never collide in practice; never overwrite anyway.
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    },

    /** The link if it exists and hasn't expired at `now`. */
    async getActive(token: string, now: Date): Promise<LinkRecord | null> {
      const output = await db.client.send(
        new GetCommand({ TableName: db.table, Key: linkKey(token), ConsistentRead: true }),
      );
      if (!output.Item) return null;
      const { ttl: _, ...link } = stripKeys<LinkRecord & { ttl: number }>(output.Item);
      return link.expiresAt > now.toISOString() ? link : null;
    },
  };
}
