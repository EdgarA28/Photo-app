import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  type NativeAttributeValue,
  type QueryCommandInput,
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

export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

function* chunks<T>(values: T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random() / 2);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
