import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { newId } from "@photo-app/shared";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createApp } from "../src/app";
import type { UserDirectory, UserProfile } from "../src/lib/users";
import { createDocumentClient, createRepositories, type Db } from "../src/repo";
import { registerRoutes } from "../src/routes";

/**
 * A fresh table per test file, shaped like the `database` module's table (infra/modules/database):
 * PK/SK strings + GSI1 (GSI1PK/GSI1SK, projection ALL).
 */
export async function createTestDb(): Promise<Db> {
  const config = {
    endpoint: inject("dynamodbEndpoint"),
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  };
  const table = `photo-app-test-${randomUUID()}`;
  await new DynamoDBClient(config).send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK"].map((name) => ({
        AttributeName: name,
        AttributeType: "S",
      })),
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  return { client: createDocumentClient(config), table };
}

export async function createTestRepos() {
  const db = await createTestDb();
  return { db, repos: createRepositories(db) };
}

export const newUserId = () => randomUUID();

/** Distinct, increasing timestamps in the API's `toISOString()` format. */
let clock = Date.parse("2026-01-01T00:00:00.000Z");
export const nextIso = () => new Date((clock += 1000)).toISOString();

export function newPhoto(
  userId: string,
  overrides: { uploadedAt?: string; sizeBytes?: number } = {},
) {
  const photoId = newId();
  return {
    userId,
    photoId,
    fileName: `IMG_${photoId}.jpg`,
    contentType: "image/jpeg" as const,
    sizeBytes: overrides.sizeBytes ?? 1000,
    originalKey: `users/${userId}/originals/${photoId}.jpg`,
    uploadedAt: overrides.uploadedAt ?? nextIso(),
  };
}

/** Does what the thumbnail Lambda does on success (services/thumbnails processor.py). */
export async function markReady(
  db: Db,
  userId: string,
  photoId: string,
  size: number,
  takenAt: string,
) {
  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: db.table,
            Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
            UpdateExpression:
              "SET #status = :ready, takenAt = :t, GSI1SK = :gsi, sizeBytes = :size, width = :w, height = :h",
            ConditionExpression: "attribute_exists(PK) AND #status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":ready": "ready",
              ":pending": "pending",
              ":t": takenAt,
              ":gsi": `TAKEN#${takenAt}#${photoId}`,
              ":size": size,
              ":w": 4000,
              ":h": 3000,
            },
          },
        },
        {
          Update: {
            TableName: db.table,
            Key: { PK: `USER#${userId}`, SK: "USAGE" },
            UpdateExpression: "ADD bytesUsed :size, photoCount :one",
            ExpressionAttributeValues: { ":size": size, ":one": 1 },
          },
        },
      ],
    }),
  );
}

export const TEST_DEFAULT_QUOTA = 2 * 1024 ** 3;

/**
 * The real app and routes on a fresh DynamoDB Local table, with a fake Cognito directory
 * (`profiles`). `api(as, …)` sends a request as user `as` (null = anonymous), the way API Gateway
 * delivers it: the JWT `sub` in the authorizer claims.
 */
export async function createTestApi() {
  const { db, repos } = await createTestRepos();
  const profiles = new Map<string, UserProfile>();
  const users: UserDirectory = { getProfile: async (userId) => profiles.get(userId) ?? null };
  const app = createApp({
    routes: registerRoutes({ repos, users, config: { defaultQuotaBytes: TEST_DEFAULT_QUOTA } }),
  });

  async function api(as: string | null, method: string, path: string, body?: unknown) {
    const res = await app.request(
      `/api${path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      },
      {
        event: {
          requestContext: { authorizer: as ? { jwt: { claims: { sub: as }, scopes: null } } : {} },
        },
      },
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as unknown };
  }

  return { db, repos, profiles, api };
}
