import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { newId } from "@photo-app/shared";
import { randomUUID } from "node:crypto";
import { inject } from "vitest";
import { createDocumentClient, createRepositories, type Db } from "../src/repo";

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
