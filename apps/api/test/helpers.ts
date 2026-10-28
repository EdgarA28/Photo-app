import { CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { newId } from "@photo-app/shared";
import { createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, inject } from "vitest";
import { createApp } from "../src/app";
import { cloudFrontMediaSigner } from "../src/lib/media";
import type { DownloadTarget, PhotoStorage, UploadTarget } from "../src/lib/storage";
import type { UserDirectory, UserProfile } from "../src/lib/users";
import {
  createDocumentClient,
  createRepositories,
  type Db,
  type NewPhoto,
  type PhotoRecord,
  type Repositories,
} from "../src/repo";
import { registerPublicRoutes, registerRoutes } from "../src/routes";

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

/** createPending with plenty of quota, for tests that aren't about the quota. */
export async function createPending(
  repos: Repositories,
  photo: NewPhoto,
  quotaBytes = 1024 ** 4,
): Promise<PhotoRecord> {
  const created = await repos.photos.createPending(photo, { quotaBytes });
  if (typeof created === "string") throw new Error(`Unexpected ${created} in test setup`);
  return created;
}

/**
 * Does what the thumbnail Lambda does on success (services/thumbnails processor.py): counts the
 * actual `size` and moves the reservation from the declared size to it.
 */
export async function markReady(
  db: Db,
  userId: string,
  photoId: string,
  size: number,
  takenAt: string,
) {
  const item = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
      ConsistentRead: true,
    }),
  );
  const declared = Number(item.Item?.sizeBytes ?? 0);
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
            UpdateExpression: "ADD bytesUsed :size, photoCount :one, bytesReserved :delta",
            ExpressionAttributeValues: { ":size": size, ":one": 1, ":delta": size - declared },
          },
        },
      ],
    }),
  );
}

export interface TestPlace {
  placeId: string;
  kind: "city" | "region" | "country";
  name: string;
  context: string;
}

export const BERLIN: TestPlace[] = [
  { placeId: "city:2950159", kind: "city", name: "Berlin", context: "State of Berlin, Germany" },
  { placeId: "region:DE.16", kind: "region", name: "State of Berlin", context: "Germany" },
  { placeId: "country:DE", kind: "country", name: "Germany", context: "" },
];

/**
 * What the thumbnail Lambda writes for a ready photo with GPS (13.2c): the place on the photo, a
 * place list entry per place (count +1) and a place photo item per place, by takenAt in GSI1.
 */
export async function addPlaces(db: Db, userId: string, photoId: string, places: TestPlace[]) {
  const photo = await db.client.send(
    new GetCommand({ TableName: db.table, Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` } }),
  );
  const takenAt = photo.Item!.takenAt as string;
  const [city, region, country] = places;
  await db.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: db.table,
            Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
            UpdateExpression:
              "SET latitude = :lat, longitude = :lon, place = :place, placeIds = :ids",
            ExpressionAttributeValues: {
              ":lat": 52.52,
              ":lon": 13.41,
              ":place": {
                city: city!.name,
                ...(region && region.kind === "region" && { region: region.name }),
                country: (country ?? region)!.name,
                countryCode: "DE",
              },
              ":ids": new Set(places.map((p) => p.placeId)),
            },
          },
        },
        ...places.flatMap((place) => [
          {
            Put: {
              TableName: db.table,
              Item: {
                PK: `PLACE#${userId}#${place.placeId}`,
                SK: `PHOTO#${photoId}`,
                GSI1PK: `PLACE#${userId}#${place.placeId}`,
                GSI1SK: `TAKEN#${takenAt}#${photoId}`,
                entity: "placePhoto",
                ownerId: userId,
                placeId: place.placeId,
                photoId,
              },
            },
          },
          {
            Update: {
              TableName: db.table,
              Key: { PK: `USER#${userId}`, SK: `PLACE#${place.placeId}` },
              UpdateExpression:
                "SET entity = :e, placeId = :id, kind = :k, #name = :n, context = :c ADD photoCount :one",
              ExpressionAttributeNames: { "#name": "name" },
              ExpressionAttributeValues: {
                ":e": "place",
                ":id": place.placeId,
                ":k": place.kind,
                ":n": place.name,
                ":c": place.context,
                ":one": 1,
              },
            },
          },
        ]),
      ],
    }),
  );
}

export const TEST_DEFAULT_QUOTA = 2 * 1024 ** 3;

/** A real RSA key pair, so tests can verify the media cookie signatures (7.3). */
export const TEST_MEDIA = {
  origin: "https://media.test.example",
  keyPairId: "KTESTKEYPAIR",
  ...generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }),
};

export const testMediaSigner = () =>
  cloudFrontMediaSigner({
    origin: TEST_MEDIA.origin,
    keyPairId: TEST_MEDIA.keyPairId,
    loadPrivateKey: async () => TEST_MEDIA.privateKey,
  });

/**
 * Checks a shared-image URL (7.4) the way CloudFront does: relative `path` + canned-policy query
 * (Expires, Signature, Key-Pair-Id, Hash-Algorithm), signature over the canned policy for the
 * full URL. Returns the expiry (epoch seconds).
 */
export function verifySignedUrl(url: string, path: string): number {
  const parsed = new URL(url, TEST_MEDIA.origin);
  expect(url.startsWith(`${path}?`)).toBe(true);
  expect([...parsed.searchParams.keys()].sort()).toEqual(
    ["Expires", "Hash-Algorithm", "Key-Pair-Id", "Signature"].sort(),
  );
  expect(parsed.searchParams.get("Key-Pair-Id")).toBe(TEST_MEDIA.keyPairId);
  expect(parsed.searchParams.get("Hash-Algorithm")).toBe("SHA256");
  const expires = Number(parsed.searchParams.get("Expires"));
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `${TEST_MEDIA.origin}${path}`,
        Condition: { DateLessThan: { "AWS:EpochTime": expires } },
      },
    ],
  });
  // CloudFront's URL-safe base64: + → -, = → _, / → ~.
  const signature = Buffer.from(
    parsed.searchParams.get("Signature")!.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"),
    "base64",
  );
  expect(createVerify("RSA-SHA256").update(policy).verify(TEST_MEDIA.publicKey, signature)).toBe(
    true,
  );
  return expires;
}

export const TEST_UPLOAD_URL = "https://photos.test.example/";
export const TEST_DOWNLOAD_URL = "https://photos.test.example/download";

/**
 * The real app and routes on a fresh DynamoDB Local table, with a fake Cognito directory
 * (`profiles`, also searched by email) and a fake photo bucket that records upload targets (`uploads`), download targets
 * (`downloads`) and object deletes (`deletes`, one entry per call; `onDelete` runs inside each
 * call, to simulate races). `api(as, …)` sends a request as user `as` (null = anonymous), the
 * way API Gateway delivers it: the JWT `sub` in the authorizer claims.
 */
export async function createTestApi() {
  const { db, repos } = await createTestRepos();
  const profiles = new Map<string, UserProfile>();
  const users: UserDirectory = {
    getProfile: async (userId) => profiles.get(userId) ?? null,
    findByEmail: async (email) => {
      for (const [userId, profile] of profiles) {
        if (profile.email === email) return { userId, email };
      }
      return null;
    },
  };
  const uploads: UploadTarget[] = [];
  const downloads: DownloadTarget[] = [];
  const deletes: string[][] = [];
  const hooks: { onDelete?: (keys: string[]) => Promise<void> } = {};
  const storage: PhotoStorage = {
    createUploadPost: async (target) => {
      uploads.push(target);
      return {
        url: TEST_UPLOAD_URL,
        fields: { key: target.key, "Content-Type": target.contentType },
      };
    },
    createDownloadUrl: async (target) => {
      downloads.push(target);
      return `${TEST_DOWNLOAD_URL}?key=${encodeURIComponent(target.key)}`;
    },
    deleteObjects: async (keys) => {
      deletes.push(keys);
      await hooks.onDelete?.(keys);
    },
  };
  const deps = {
    repos,
    users,
    storage,
    media: testMediaSigner(),
    config: { defaultQuotaBytes: TEST_DEFAULT_QUOTA },
  };
  const app = createApp({ routes: registerRoutes(deps), publicRoutes: registerPublicRoutes(deps) });

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

  return { db, repos, profiles, uploads, downloads, deletes, hooks, storage, app, api };
}
