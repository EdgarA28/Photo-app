import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { USERNAME_HOLD_DAYS } from "@photo-app/shared";
import { batchGet, conditionFailedAt, isTransactionConflict, stripKeys, type Db } from "./db";
import { profileKey, usernameKey } from "./keys";

/** Profile item without key attributes (spec §8.2): what a user's username is. */
export interface ProfileRecord {
  userId: string;
  username: string;
  usernameChangedAt: string;
}

/** Username claim item (spec §8.2): who owns a name, and whether it is held after a rename. */
interface ClaimRecord {
  username: string;
  userId: string;
  claimedAt: string;
  releasedAt?: string;
  /** Set when released: until then only `userId` (the former owner) can claim it again (D-8). */
  heldUntil?: string;
}

export type SetUsernameResult = "ok" | "unchanged" | "taken";

const HOLD_MS = USERNAME_HOLD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Usernames (FR-ACC-3, task 5.15): a claim item per name (`USERNAME#{name}`) makes names unique,
 * a profile item per user (`USER#{id} / PROFILE`) says which name a user has. Both change together
 * in one transaction, so they always agree.
 */
export function usernamesRepo(db: Db) {
  return {
    getProfile: (userId: string) => getProfile(db, userId),

    /** Current usernames of several users; users without one are left out. */
    async getMany(userIds: string[]): Promise<Map<string, string>> {
      const unique = [...new Set(userIds)];
      if (unique.length === 0) return new Map();
      const items = await batchGet(db, unique.map(profileKey));
      return new Map(
        items.map((item) => {
          const profile = stripKeys<ProfileRecord>(item);
          return [profile.userId, profile.username];
        }),
      );
    },

    /** Who has this (normalised) username now. Held names belong to nobody (D-8). */
    async findUser(username: string): Promise<string | null> {
      const output = await db.client.send(
        new GetCommand({ TableName: db.table, Key: usernameKey(username), ConsistentRead: true }),
      );
      const claim = output.Item ? stripKeys<ClaimRecord>(output.Item) : null;
      return claim && !claim.heldUntil ? claim.userId : null;
    },

    /**
     * Sets or changes the user's username. One transaction:
     *   0. puts the new claim, if the name is free, is the user's own (held) name, or its hold
     *      has expired;
     *   1. puts the profile, if it still has the name we read (guards concurrent renames);
     *   2. on a rename, marks the old claim held for `USERNAME_HOLD_DAYS`.
     * "taken" if someone else has the name or it is held for someone else.
     */
    async set(userId: string, username: string, now: string): Promise<SetUsernameResult> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await getProfile(db, userId);
        if (current?.username === username) return "unchanged";

        const profile: ProfileRecord = { userId, username, usernameChangedAt: now };
        const claim: ClaimRecord = { username, userId, claimedAt: now };
        try {
          await db.client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  // A Put replaces the whole item, so a reclaimed name loses releasedAt/heldUntil.
                  Put: {
                    TableName: db.table,
                    Item: { ...usernameKey(username), entity: "username", ...claim },
                    ConditionExpression:
                      "attribute_not_exists(PK) OR userId = :me OR heldUntil < :now",
                    ExpressionAttributeValues: { ":me": userId, ":now": now },
                  },
                },
                {
                  Put: {
                    TableName: db.table,
                    Item: { ...profileKey(userId), entity: "profile", ...profile },
                    ...(current
                      ? {
                          ConditionExpression: "username = :old",
                          ExpressionAttributeValues: { ":old": current.username },
                        }
                      : { ConditionExpression: "attribute_not_exists(PK)" }),
                  },
                },
                ...(current
                  ? [
                      {
                        Update: {
                          TableName: db.table,
                          Key: usernameKey(current.username),
                          UpdateExpression: "SET releasedAt = :now, heldUntil = :until",
                          ConditionExpression: "userId = :me",
                          ExpressionAttributeValues: {
                            ":me": userId,
                            ":now": now,
                            ":until": new Date(Date.parse(now) + HOLD_MS).toISOString(),
                          },
                        },
                      },
                    ]
                  : []),
              ],
            }),
          );
          return "ok";
        } catch (err) {
          if (conditionFailedAt(err, 0)) return "taken";
          // The profile changed since we read it (another rename), or another transaction on
          // the same name was in flight: read again and retry.
          if (!conditionFailedAt(err, 1) && !isTransactionConflict(err)) throw err;
        }
      }
      throw new Error(`Username of ${userId} kept changing while being set`);
    },
  };
}

async function getProfile(db: Db, userId: string): Promise<ProfileRecord | null> {
  const output = await db.client.send(
    new GetCommand({ TableName: db.table, Key: profileKey(userId), ConsistentRead: true }),
  );
  return output.Item ? stripKeys<ProfileRecord>(output.Item) : null;
}
