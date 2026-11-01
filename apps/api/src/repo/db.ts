import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  type NativeAttributeValue,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { Page } from "@photo-app/shared";
import { decodeCursor, encodeCursor, type CursorKey } from "./cursor";
import { KEY_ATTRIBUTES } from "./keys";

export type Item = Record<string, NativeAttributeValue>;

/** What every repository needs: the document client and the table name. */
export interface Db {
  client: DynamoDBDocumentClient;
  table: string;
}

export function createDocumentClient(config: DynamoDBClientConfig = {}): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Removes PK/SK/GSI attributes so records carry only domain fields. */
export function stripKeys<T>(item: Item): T {
  const record: Item = { ...item };
  for (const attribute of KEY_ATTRIBUTES) delete record[attribute];
  return record as T;
}

export interface PageQuery {
  /** Query input without Limit / ExclusiveStartKey; the key condition must fix the partition. */
  input: Omit<QueryCommandInput, "TableName" | "Limit" | "ExclusiveStartKey">;
  keyAttributes: readonly string[];
  partition: { attribute: string; value: string };
  limit: number;
  cursor?: string | undefined;
}

/**
 * One page of a query. Reads `limit + 1` items so `nextCursor` is null exactly when there is no
 * further item (DynamoDB's own LastEvaluatedKey can point at an empty last page).
 */
export async function queryPage(db: Db, query: PageQuery): Promise<Page<Item>> {
  const exclusiveStartKey = query.cursor
    ? decodeCursor(query.cursor, query.keyAttributes, query.partition)
    : undefined;
  const items: Item[] = [];
  let startKey: Item | undefined = exclusiveStartKey;
  // Loop because DynamoDB stops at 1 MB per response, which can return fewer than Limit items.
  do {
    const output = await db.client.send(
      new QueryCommand({
        ...query.input,
        TableName: db.table,
        Limit: query.limit + 1 - items.length,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(output.Items ?? []));
    startKey = output.LastEvaluatedKey;
  } while (startKey && items.length <= query.limit);

  if (items.length <= query.limit) return { items, nextCursor: null };
  const page = items.slice(0, query.limit);
  const last = page[page.length - 1]!;
  const key: CursorKey = {};
  for (const attribute of query.keyAttributes) key[attribute] = String(last[attribute]);
  return { items: page, nextCursor: encodeCursor(key) };
}

/** All items of a query (for small, bounded collections such as one user's albums). */
export async function queryAll(
  db: Db,
  input: Omit<QueryCommandInput, "TableName" | "ExclusiveStartKey">,
): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const output = await db.client.send(
      new QueryCommand({ ...input, TableName: db.table, ExclusiveStartKey: startKey }),
    );
    items.push(...(output.Items ?? []));
    startKey = output.LastEvaluatedKey;
  } while (startKey);
  return items;
}

const BATCH_GET_SIZE = 100;
const BATCH_WRITE_SIZE = 25;
const MAX_BATCH_ATTEMPTS = 8;

/** BatchGetItem in chunks of 100, retrying unprocessed keys with backoff. Order is not kept. */
export async function batchGet(db: Db, keys: Item[]): Promise<Item[]> {
  const found: Item[] = [];
  for (const chunk of chunks(keys, BATCH_GET_SIZE)) {
    let pending: Item[] = chunk;
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error("BatchGet: unprocessed keys remain");
      if (attempt > 0) await backoff(attempt);
      const output = await db.client.send(
        new BatchGetCommand({ RequestItems: { [db.table]: { Keys: pending } } }),
      );
      found.push(...(output.Responses?.[db.table] ?? []));
      pending = (output.UnprocessedKeys?.[db.table]?.Keys ?? []) as Item[];
    }
  }
  return found;
}

/** BatchWriteItem deletes in chunks of 25, retrying unprocessed items with backoff. */
export async function batchDelete(db: Db, keys: Item[]): Promise<void> {
  for (const chunk of chunks(keys, BATCH_WRITE_SIZE)) {
    let pending = chunk.map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt >= MAX_BATCH_ATTEMPTS) throw new Error("BatchWrite: unprocessed items remain");
      if (attempt > 0) await backoff(attempt);
      const output = await db.client.send(
        new BatchWriteCommand({ RequestItems: { [db.table]: pending } }),
      );
      pending = (output.UnprocessedItems?.[db.table] ?? []) as typeof pending;
    }
  }
}

/** True if a TransactWriteItems failure was caused by the condition of the item at `index`. */
export function conditionFailedAt(err: unknown, index: number): boolean {
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") return false;
  const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.[index]?.Code === "ConditionalCheckFailed";
}

/**
 * True if a write failed only because it clashed with a transaction on the same item(s), so
 * nothing was applied and it is safe to retry: a TransactWriteItems cancelled for
 * `TransactionConflict` (no condition failed), or a single-item write rejected with
 * `TransactionConflictException` because a transaction on that item was in flight (seen in dev
 * 2026-11-01: emptying a big trash, the empty-place cleanup after each delete).
 */
export function isTransactionConflict(err: unknown): boolean {
  if (err instanceof Error && err.name === "TransactionConflictException") return true;
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") return false;
  const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return (
    reasons.some((r) => r.Code === "TransactionConflict") &&
    !reasons.some((r) => r.Code === "ConditionalCheckFailed")
  );
}

export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

function* chunks<T>(values: T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}

/** Tries of a transaction cancelled only by clashes with others; ~3 s of pauses at most. */
export const TRANSACTION_ATTEMPTS = 8;
/** Pause before the next try: random up to 25 ms · 2ⁿ, capped at 1 s ("full jitter"). */
export const conflictPause = (attempt: number) => Math.random() * Math.min(1000, 25 * 2 ** attempt);

/**
 * TransactWriteItems with retries on `TransactionConflict` (13.4). Many photos changed in parallel
 * (bulk upload, emptying the trash, deleting a selection) update the same shared counters (Usage,
 * place counts, album counts) at the same moment; DynamoDB then cancels the clashing transactions
 * without applying anything. Trying again after a random, growing pause spreads them out, so the
 * counters stay exact without the caller seeing an error. A failed condition is not a conflict:
 * it is thrown at once for the caller to handle, as before.
 */
export async function transactWrite(
  db: Db,
  input: TransactWriteCommandInput,
  options: RetryOptions = {},
): Promise<void> {
  await retryOnConflict(() => db.client.send(new TransactWriteCommand(input)), options);
}

export interface RetryOptions {
  attempts?: number;
  pause?: (attempt: number) => number;
}

/**
 * Runs a write, again after a random, growing pause while it only clashes with transactions on
 * the same item (`isTransactionConflict`; 13.4). For transactions (`transactWrite`) and for
 * single-item writes on items many parallel operations touch (place and album counters).
 */
export async function retryOnConflict<T>(
  write: () => Promise<T>,
  { attempts = TRANSACTION_ATTEMPTS, pause = conflictPause }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (!isTransactionConflict(err) || attempt >= attempts - 1) throw err;
      const ms = pause(attempt);
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random() / 2);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
