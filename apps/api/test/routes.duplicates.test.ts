/**
 * Duplicates (8.37f, FR-GAL-12, §9): GET /photos/duplicates and
 * POST /photos/duplicates/{key}/dismiss.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { duplicatesSchema, newId } from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import { duplicateKey } from "../src/lib/duplicates";
import type { Db, Repositories } from "../src/repo";
import { createPending, createTestApi, markReady, newPhoto, newUserId, nextIso } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let db: Db;
let repos: Repositories;
let api: TestApi["api"];
beforeAll(async () => {
  ({ db, repos, api } = await createTestApi());
});

const A = "f0e1d2c3b4a59687";
/** A with 2 bits flipped: a re-encoded copy. */
const A_COPY = "f0e1d2c3b4a59684";
const B = "0f1e2d3c4b5a6978";

/** A ready photo with what the thumbnail Lambda writes (8.37a, 12.2b). */
async function photo(
  userId: string,
  {
    hash,
    etag,
    takenAt = "2025-06-01T12:00:00.000Z",
  }: { hash?: string; etag?: string; takenAt?: string },
) {
  const { photoId } = await createPending(repos, newPhoto(userId));
  await markReady(db, userId, photoId, 1000, takenAt);
  const sets = [hash && "similarityHash = :h", etag && "originalETag = :e"].filter(Boolean);
  if (sets.length > 0) {
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeValues: { ...(hash && { ":h": hash }), ...(etag && { ":e": etag }) },
      }),
    );
  }
  return photoId;
}

async function duplicates(userId: string) {
  const res = await api(userId, "GET", "/photos/duplicates");
  expect(res.status).toBe(200);
  return duplicatesSchema.parse(res.body).groups;
}

const ids = (groups: Awaited<ReturnType<typeof duplicates>>) =>
  groups.map((g) => g.photos.map((p) => p.photoId));

describe("GET /photos/duplicates", () => {
  test("identical files and near-identical images, whenever taken; largest groups first", async () => {
    const user = newUserId();
    const a1 = await photo(user, { hash: A, takenAt: "2020-01-01T10:00:00.000Z" });
    const a2 = await photo(user, { hash: A_COPY, takenAt: "2026-11-01T10:00:00.000Z" });
    const a3 = await photo(user, { hash: A, takenAt: "2024-05-01T10:00:00.000Z" });
    const f1 = await photo(user, { etag: "same-file", hash: B });
    const f2 = await photo(user, { etag: "same-file", hash: "ffffffffffffffff" });
    await photo(user, { hash: "00000000ffffffff" }); // nothing like the others
    await photo(user, {}); // processed before 12.2b / 8.37a

    const groups = await duplicates(user);
    // Newest first within a group.
    expect(ids(groups)).toEqual([[a2, a3, a1], expect.arrayContaining([f1, f2])]);
    expect(groups[0]!.key).toBe(duplicateKey([a1, a2, a3]));
    expect(groups[0]!.photos[0]).toMatchObject({ status: "ready", similarityHash: A_COPY });
  });

  test("leaves out videos, pending photos, the trash and other users' copies", async () => {
    const user = newUserId();
    const stranger = newUserId();
    const kept = await photo(user, { hash: A });
    const trashed = await photo(user, { hash: A });
    await repos.photos.trash(user, trashed, new Date());
    await photo(stranger, { hash: A });
    const pending = (await createPending(repos, newPhoto(user))).photoId;
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        Key: { PK: `USER#${user}`, SK: `PHOTO#${pending}` },
        UpdateExpression: "SET similarityHash = :h",
        ExpressionAttributeValues: { ":h": A },
      }),
    );
    expect(kept).toBeTruthy();
    expect(await duplicates(user)).toEqual([]);
    expect(await duplicates(stranger)).toEqual([]);
  });
});

describe("POST /photos/duplicates/{key}/dismiss", () => {
  const dismiss = (userId: string, photoIds: string[], key = duplicateKey(photoIds)) =>
    api(userId, "POST", `/photos/duplicates/${key}/dismiss`, { photoIds });

  test("204: the group no longer shows, until a new copy joins it", async () => {
    const user = newUserId();
    const a1 = await photo(user, { hash: A });
    const a2 = await photo(user, { hash: A_COPY });
    expect((await dismiss(user, [a2, a1])).status).toBe(204);
    expect(await duplicates(user)).toEqual([]);

    const a3 = await photo(user, { hash: A, takenAt: nextIso() });
    expect(ids(await duplicates(user))).toEqual([expect.arrayContaining([a1, a2, a3])]);
  });

  test("409 when the group changed since it was shown", async () => {
    const user = newUserId();
    const a1 = await photo(user, { hash: A });
    const a2 = await photo(user, { hash: A });
    await photo(user, { hash: A_COPY });
    const res = await dismiss(user, [a1, a2]);
    expect(res.status).toBe(409);
    expect(ids(await duplicates(user))).toHaveLength(1);
  });

  test("400 for a key that isn't the photos' or a bad key; 404 for a missing photo", async () => {
    const user = newUserId();
    const a1 = await photo(user, { hash: A });
    const a2 = await photo(user, { hash: A });
    expect((await dismiss(user, [a1, a2], duplicateKey([a1]))).status).toBe(400);
    expect((await dismiss(user, [a1, a2], "not-a-key")).status).toBe(400);
    expect((await dismiss(user, [a1])).status).toBe(400);
    expect((await dismiss(user, [a1, newId()])).status).toBe(404);
    expect(ids(await duplicates(user))).toEqual([expect.arrayContaining([a1, a2])]);
  });
});
