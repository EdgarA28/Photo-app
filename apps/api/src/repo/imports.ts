import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { IMPORT_TTL_DAYS, type ImportFailureCode, type ImportStatus } from "@photo-app/shared";
import {
  conditionFailedAt,
  isConditionalCheckFailed,
  stripKeys,
  transactWrite,
  type Db,
} from "./db";
import { importItemKey, importKey } from "./keys";

/**
 * Imports from Google Photos (13.5c; §8.2 Import item, FR-IMP-*). One item per import under the
 * user's partition, `USER#{userId}` / `IMPORT#{importId}`, so another user's import is simply not
 * found (NFR-SEC-2). No GSI keys: imports never show up in gallery or trash queries. DynamoDB TTL
 * removes the item 7 days after it was created.
 *
 * `accessToken` is Google's (~1 h, no refresh token). It stays in this item only (never in queue
 * messages or logs) and is removed as soon as the import ends (NFR-SEC-10).
 */
export interface ImportRecord {
  userId: string;
  importId: string;
  source: "google-photos";
  status: ImportStatus;
  sessionId: string;
  pickerUri: string;
  pollIntervalSec: number;
  /** Last time the API asked Google about the Picker session (at most once per poll interval). */
  lastPolledAt?: string;
  /** Removed when the import ends. */
  accessToken?: string;
  tokenExpiresAt: string;
  /** When the Picker session stops accepting picks. */
  sessionExpiresAt: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  failedReasons: Partial<Record<ImportFailureCode, number>>;
  createdAt: string;
}

export type NewImport = Omit<
  ImportRecord,
  "status" | "total" | "done" | "failed" | "skipped" | "failedReasons" | "lastPolledAt"
>;

const ACTIVE: readonly ImportStatus[] = ["picking", "listing", "copying"];

export function importsRepo(db: Db) {
  async function get(userId: string, importId: string): Promise<ImportRecord | null> {
    const output = await db.client.send(
      new GetCommand({
        TableName: db.table,
        Key: importKey(userId, importId),
        ConsistentRead: true,
      }),
    );
    if (!output.Item) return null;
    const { ttl: _, ...record } = stripKeys<ImportRecord & { ttl: number }>(output.Item);
    return record;
  }

  /** A conditional update; false when the condition didn't hold (someone else got there first). */
  async function update(
    userId: string,
    importId: string,
    input: {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    try {
      await db.client.send(
        new UpdateCommand({ TableName: db.table, Key: importKey(userId, importId), ...input }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  return {
    get,

    async create(input: NewImport): Promise<ImportRecord> {
      const record: ImportRecord = {
        ...input,
        status: "picking",
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        failedReasons: {},
      };
      await db.client.send(
        new PutCommand({
          TableName: db.table,
          Item: {
            ...importKey(input.userId, input.importId),
            entity: "import",
            ...record,
            ttl: Math.ceil(Date.parse(input.createdAt) / 1000) + IMPORT_TTL_DAYS * 24 * 60 * 60,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return record;
    },

    /**
     * Claims the next poll of the Picker session (FR-IMP-5): true when the import is still
     * `picking` and the last poll is at least `pollIntervalSec` old. Several app tabs polling at
     * once therefore cause one Google call per interval, not one each.
     */
    async claimPoll(userId: string, importId: string, now: Date): Promise<boolean> {
      const record = await get(userId, importId);
      if (!record || record.status !== "picking") return false;
      const due = new Date(now.getTime() - record.pollIntervalSec * 1000).toISOString();
      return update(userId, importId, {
        UpdateExpression: "SET lastPolledAt = :now",
        ConditionExpression:
          "#status = :picking AND (attribute_not_exists(lastPolledAt) OR lastPolledAt <= :due)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":now": now.toISOString(),
          ":picking": "picking",
          ":due": due,
        },
      });
    },

    /**
     * picking → listing once the user is done picking (§5.2 step 5). Conditional, so only one
     * request sends the `list` message.
     */
    async startListing(userId: string, importId: string): Promise<boolean> {
      return update(userId, importId, {
        UpdateExpression: "SET #status = :listing",
        ConditionExpression: "#status = :picking",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":listing": "listing", ":picking": "picking" },
      });
    },

    /** Undoes `startListing` when the `list` message couldn't be sent, so a later poll retries. */
    async backToPicking(userId: string, importId: string): Promise<boolean> {
      return update(userId, importId, {
        UpdateExpression: "SET #status = :picking REMOVE lastPolledAt",
        ConditionExpression: "#status = :listing",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":listing": "listing", ":picking": "picking" },
      });
    },

    /**
     * Ends an active import as `cancelled` (user, FR-IMP-5) or `expired` (Google's token or the
     * Picker session ran out) and removes the token. Photos copied so far stay. When copying, the
     * photos not done yet count as failed with `EXPIRED` (§10.1), only for `expired`.
     * False when the import had already ended or changed meanwhile.
     */
    async end(record: ImportRecord, status: "cancelled" | "expired"): Promise<ImportRecord | null> {
      if (!ACTIVE.includes(record.status)) return null;
      const missing =
        status === "expired" && record.status === "copying"
          ? Math.max(0, record.total - record.done - record.failed)
          : 0;
      const failedReasons = { ...record.failedReasons };
      if (missing > 0) failedReasons.EXPIRED = (failedReasons.EXPIRED ?? 0) + missing;
      const ended: ImportRecord = {
        ...record,
        status,
        failed: record.failed + missing,
        failedReasons,
      };
      delete ended.accessToken;
      // Conditional on the counters read, so a copy finishing meanwhile isn't overwritten: the
      // caller reads again and decides anew.
      const ok = await update(record.userId, record.importId, {
        UpdateExpression:
          "SET #status = :status, failed = :failed, failedReasons = :reasons REMOVE accessToken",
        ConditionExpression: "#status = :was AND done = :done AND failed = :wasFailed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":failed": ended.failed,
          ":reasons": failedReasons,
          ":was": record.status,
          ":done": record.done,
          ":wasFailed": record.failed,
        },
      });
      return ok ? ended : null;
    },

    /**
     * Worker `list` step done (§10.1): listing → copying with the number of photos to copy and
     * the picked items skipped. False when the import isn't listing any more (cancelled, or a
     * redelivered `list` message after the first one finished).
     */
    async setListed(
      userId: string,
      importId: string,
      { total, skipped }: { total: number; skipped: number },
    ): Promise<boolean> {
      return update(userId, importId, {
        // `total` is a DynamoDB reserved word.
        UpdateExpression: "SET #status = :copying, #total = :total, skipped = :skipped",
        ConditionExpression: "#status = :listing",
        ExpressionAttributeNames: { "#status": "status", "#total": "total" },
        ExpressionAttributeValues: {
          ":copying": "copying",
          ":listing": "listing",
          ":total": total,
          ":skipped": skipped,
        },
      });
    },

    /**
     * Counts one picked photo as `done` or `failed` (with its reason) exactly once (FR-IMP-6):
     * the marker `IMPORTED#{importId}#{mediaItemId}` and the counter change in one transaction.
     * `already` = counted by an earlier delivery; `ended` = the import was cancelled or expired.
     * Copies finishing together clash on the Import item; `transactWrite` retries those.
     */
    async countItem(
      userId: string,
      importId: string,
      mediaItemId: string,
      outcome: { kind: "done" } | { kind: "failed"; code: ImportFailureCode },
    ): Promise<"counted" | "already" | "ended"> {
      const counter: {
        UpdateExpression: string;
        names: Record<string, string>;
        values: Record<string, unknown>;
      } =
        outcome.kind === "done"
          ? { UpdateExpression: "ADD done :one", names: {}, values: {} }
          : {
              UpdateExpression:
                "ADD failed :one SET failedReasons.#code = if_not_exists(failedReasons.#code, :zero) + :one",
              names: { "#code": outcome.code },
              values: { ":zero": 0 },
            };
      try {
        await transactWrite(db, {
          TransactItems: [
            {
              Put: {
                TableName: db.table,
                Item: {
                  ...importItemKey(userId, importId, mediaItemId),
                  entity: "importItem",
                  outcome: outcome.kind === "done" ? "done" : outcome.code,
                  ttl: Math.ceil(Date.now() / 1000) + IMPORT_TTL_DAYS * 24 * 60 * 60,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: db.table,
                Key: importKey(userId, importId),
                UpdateExpression: counter.UpdateExpression,
                ConditionExpression: "#status IN (:listing, :copying)",
                ExpressionAttributeNames: { "#status": "status", ...counter.names },
                ExpressionAttributeValues: {
                  ":one": 1,
                  ":listing": "listing",
                  ":copying": "copying",
                  ...counter.values,
                },
              },
            },
          ],
        });
        return "counted";
      } catch (err) {
        if (conditionFailedAt(err, 0)) return "already";
        if (conditionFailedAt(err, 1)) return "ended";
        throw err;
      }
    },

    /** Whether this picked photo was already counted (a redelivered `copy` message). */
    async isCounted(userId: string, importId: string, mediaItemId: string): Promise<boolean> {
      const output = await db.client.send(
        new GetCommand({
          TableName: db.table,
          Key: importItemKey(userId, importId, mediaItemId),
          ConsistentRead: true,
        }),
      );
      return output.Item !== undefined;
    },

    /**
     * `done` once every photo is counted (§10.1 "Finish"): conditional on the counters read, so
     * exactly one caller ends it. Returns the record as it was (with the token, to delete the
     * Picker session) when this call ended it, else null.
     */
    async finishIfComplete(userId: string, importId: string): Promise<ImportRecord | null> {
      const record = await get(userId, importId);
      if (!record || record.status !== "copying") return null;
      if (record.done + record.failed < record.total) return null;
      const ok = await update(userId, importId, {
        UpdateExpression: "SET #status = :done REMOVE accessToken",
        ConditionExpression: "#status = :copying AND done = :d AND failed = :f",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":done": "done",
          ":copying": "copying",
          ":d": record.done,
          ":f": record.failed,
        },
      });
      return ok ? record : null;
    },
  };
}
