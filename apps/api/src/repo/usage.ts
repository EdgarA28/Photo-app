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
  /**
   * What the quota is checked against (5.6b): bytesUsed plus the declared size of every pending
   * upload. Reserved by createPending, adjusted by the thumbnail Lambda, released by deletes.
   */
  bytesReserved: number;
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
        bytesReserved: Math.max(0, Number(item.bytesReserved ?? 0)),
        quotaBytes: typeof item.quotaBytes === "number" ? item.quotaBytes : null,
      };
    },
  };
}
