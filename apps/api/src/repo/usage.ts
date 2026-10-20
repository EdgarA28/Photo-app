import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Db } from "./db";
import { usageKey } from "./keys";

/**
 * Usage item (spec §8.2). bytesUsed/photoCount are written by the thumbnail Lambda (+) and by
 * photo deletion (-); see ARCHITECTURE.md §8.2. quotaBytes is an optional per-user override of the
 * environment's default quota.
 */
export interface UsageRecord {
  bytesUsed: number;
  photoCount: number;
  quotaBytes: number | null;
}

export function usageRepo(db: Db) {
  return {
    /** A user who has never uploaded has no item yet: all zeros. */
    async get(userId: string): Promise<UsageRecord> {
      const output = await db.client.send(
        new GetCommand({ TableName: db.table, Key: usageKey(userId) }),
      );
      const item = output.Item ?? {};
      return {
        bytesUsed: Math.max(0, Number(item.bytesUsed ?? 0)),
        photoCount: Math.max(0, Number(item.photoCount ?? 0)),
        quotaBytes: typeof item.quotaBytes === "number" ? item.quotaBytes : null,
      };
    },
  };
}
