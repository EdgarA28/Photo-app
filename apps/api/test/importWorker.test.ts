/**
 * Import worker (13.5d, §10.1; FR-IMP-2–6, NFR-SEC-10): the `list` and `copy` steps against
 * DynamoDB Local with a fake Google, queue and bucket. Imports are started through the real API
 * routes, so the worker sees exactly what 13.5c stores.
 */
import {
  importClaimId,
  importSchema,
  MAX_UPLOAD_BYTES,
  startGoogleImportResponseSchema,
  type ImportCopyMessage,
  type ImportMessage,
} from "@photo-app/shared";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { PickedItem } from "../src/lib/google";
import { sqsImportQueue } from "../src/lib/importQueue";
import { handleImportMessage, handleRecord, type WorkerDeps } from "../src/lib/importWorker";
import { createTestApi, newUserId, TEST_DEFAULT_QUOTA, TEST_IMPORT_REDIRECT } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let t: TestApi;
let deps: WorkerDeps;

beforeAll(async () => {
  t = await createTestApi();
  deps = {
    repos: t.repos,
    storage: t.storage,
    google: t.googleClient,
    queue: t.importQueue,
    defaultQuotaBytes: TEST_DEFAULT_QUOTA,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  t.google.pageSize = 100;
  t.hooks.onPut = undefined;
});

let itemNo = 0;
/** A picked item; its file (if any) is registered with the fake Google. */
function picked(overrides: Partial<PickedItem> & { size?: number } = {}): PickedItem {
  const n = ++itemNo;
  const { size = 1000, ...rest } = overrides;
  const item: PickedItem = {
    mediaItemId: `item_${n}`,
    type: "PHOTO",
    baseUrl: `https://lh3.googleusercontent.com/ppa/file-${n}`,
    mimeType: "image/jpeg",
    fileName: `IMG_${n}.jpg`,
    createTime: "2024-07-14T09:30:00Z",
    ...rest,
  };
  t.google.files.set(item.baseUrl, { kind: "ok", bytes: new Uint8Array(size) });
  return item;
}

/** Starts an import through the API, picks `items` in the fake picker, presses Done. */
async function pickedImport(user: string, items: PickedItem[]) {
  const res = await t.api(user, "POST", "/imports/google", {
    code: "good-code",
    codeVerifier: "v".repeat(43),
    redirectUri: TEST_IMPORT_REDIRECT,
  });
  const { importId, pickerUri } = startGoogleImportResponseSchema.parse(res.body);
  const sessionId = pickerUri.split("/").pop()!;
  t.google.picked.set(sessionId, items);
  t.google.sessions.get(sessionId)!.mediaItemsSet = true;
  expect(await state(user, importId)).toMatchObject({ status: "listing" });
  return { importId, sessionId };
}

const state = async (user: string, importId: string) =>
  importSchema.parse((await t.api(user, "GET", `/imports/${importId}`)).body);

const messagesOf = (importId: string) => t.importMessages.filter((m) => m.importId === importId);
const copiesOf = (importId: string) =>
  messagesOf(importId).filter((m): m is ImportCopyMessage => m.type === "copy");

/** Runs every queued message of this import (as SQS would), including the ones they send. */
async function drain(importId: string) {
  const done = new Set<ImportMessage>();
  for (;;) {
    const next = messagesOf(importId).find((m) => !done.has(m));
    if (!next) return;
    done.add(next);
    await handleImportMessage(deps, next);
  }
}

const photosOf = async (user: string) =>
  (await t.repos.photos.list(user, { sort: "taken-desc", limit: 100 })).items;

describe("a whole import", () => {
  test("copies the picked photos, skips the rest, ends done (FR-IMP-1/3/4/5)", async () => {
    const user = newUserId();
    const photos = [picked({ size: 1200 }), picked({ size: 3400, mimeType: "image/heic" })];
    const others = [
      picked({ type: "VIDEO", mimeType: "video/mp4" }),
      picked({ mimeType: "image/gif" }),
    ];
    const { importId, sessionId } = await pickedImport(user, [...photos, ...others]);
    await drain(importId);

    expect(await state(user, importId)).toEqual({
      status: "done",
      total: 2,
      done: 2,
      failed: 0,
      skipped: 2,
      failedReasons: {},
    });
    // Pending photos with the exact size, the originals stored with Google's date.
    const stored = await photosOf(user);
    expect(stored.map((p) => [p.status, p.sizeBytes, p.fileName]).sort()).toEqual(
      [
        ["pending", 1200, photos[0]!.fileName],
        ["pending", 3400, photos[1]!.fileName],
      ].sort(),
    );
    const puts = t.puts.filter((p) => p.key.startsWith(`users/${user}/`));
    expect(puts.map((p) => [p.size, p.contentType, p.takenAt]).sort()).toEqual([
      [1200, "image/jpeg", "2024-07-14T09:30:00.000Z"],
      [3400, "image/heic", "2024-07-14T09:30:00.000Z"],
    ]);
    expect(puts.every((p) => /\/originals\/[0-9A-Z]{26}\.(jpg|heic)$/.test(p.key))).toBe(true);
    // Quota reserved like uploads (FR-UP-7); the thumbnail Lambda counts them later.
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(4600);
    // The token is gone and the Picker session deleted (NFR-SEC-10).
    expect(await t.repos.imports.get(user, importId)).not.toHaveProperty("accessToken");
    expect(t.google.deleted).toContain(sessionId);
  });

  test("pages through the picked items", async () => {
    t.google.pageSize = 2;
    const user = newUserId();
    const { importId } = await pickedImport(
      user,
      [1, 2, 3, 4, 5].map(() => picked()),
    );
    await drain(importId);
    expect(copiesOf(importId)).toHaveLength(5);
    expect(await state(user, importId)).toMatchObject({ status: "done", total: 5, done: 5 });
  });

  test("ends done even when every copy finishes before the list step records the total", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked(), picked()]);
    // Fast workers: the copies run while the list step is still sending (status `listing`).
    const fast = {
      ...deps,
      queue: {
        ...deps.queue,
        sendBatch: async (messages: ImportMessage[]) => {
          await deps.queue.sendBatch(messages);
          for (const message of messages) await handleImportMessage(deps, message);
        },
      },
    };
    await handleImportMessage(fast, messagesOf(importId)[0]!);
    expect(await state(user, importId)).toMatchObject({ status: "done", total: 2, done: 2 });
  });

  test("an import of only skipped items ends at once", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [
      picked({ type: "VIDEO", mimeType: "video/mp4" }),
    ]);
    await drain(importId);
    expect(await state(user, importId)).toMatchObject({ status: "done", total: 0, skipped: 1 });
  });

  test("a picked item without a file name gets one", async () => {
    const user = newUserId();
    const item = picked({ fileName: "" });
    const { importId } = await pickedImport(user, [item]);
    await drain(importId);
    expect((await photosOf(user))[0]!.fileName).toBe(`google-photo-${item.mediaItemId}.jpg`);
  });

  test("copy messages never carry the Google token (NFR-SEC-10)", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked()]);
    const token = (await t.repos.imports.get(user, importId))!.accessToken!;
    await drain(importId);
    expect(JSON.stringify(messagesOf(importId))).not.toContain(token);
  });
});

describe("photos that can't be imported (§10.1 permanent errors)", () => {
  test.each([
    ["too large", { kind: "too-large" } as const, "TOO_LARGE"],
    ["gone at Google", { kind: "not-found" } as const, "NOT_FOUND"],
    ["refused (token expired)", { kind: "unauthorized" } as const, "EXPIRED"],
  ])("%s → failed with its reason, no photo", async (_, result, code) => {
    const user = newUserId();
    const item = picked();
    t.google.files.set(item.baseUrl, result);
    const { importId } = await pickedImport(user, [item, picked()]);
    await drain(importId);
    expect(await state(user, importId)).toMatchObject({
      status: "done",
      total: 2,
      done: 1,
      failed: 1,
      failedReasons: { [code]: 1 },
    });
    expect(await photosOf(user)).toHaveLength(1);
  });

  test("the download is capped at 50 MB (FR-UP-3)", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked()]);
    const download = vi.spyOn(t.googleClient, "download");
    await drain(importId);
    expect(download.mock.calls[0]![2]).toBe(MAX_UPLOAD_BYTES);
  });

  test("photos that don't fit the quota are not imported (FR-UP-7)", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked({ size: 600 }), picked({ size: 600 })]);
    const small = { ...deps, defaultQuotaBytes: 1000 };
    for (const message of messagesOf(importId)) await handleImportMessage(small, message);
    for (const message of copiesOf(importId)) await handleImportMessage(small, message);
    expect(await state(user, importId)).toMatchObject({
      status: "done",
      done: 1,
      failed: 1,
      failedReasons: { QUOTA_EXCEEDED: 1 },
    });
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(600);
  });
});

describe("retries never duplicate (FR-IMP-6)", () => {
  test("a redelivered copy makes no second photo and no second count", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked(), picked()]);
    await drain(importId);
    const [first] = copiesOf(importId);
    await handleImportMessage(deps, first!);
    expect(await photosOf(user)).toHaveLength(2);
    expect(await state(user, importId)).toMatchObject({ status: "done", done: 2, failed: 0 });
  });

  test("a copy that stopped after storing the original isn't stored again", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked()]);
    await handleImportMessage(deps, messagesOf(importId)[0]!);
    const copy = copiesOf(importId)[0]!;
    vi.spyOn(t.repos.imports, "countItem").mockRejectedValueOnce(new Error("crash"));
    await expect(handleImportMessage(deps, copy)).rejects.toThrow("crash");
    const puts = t.puts.length;
    await handleImportMessage(deps, copy);
    expect(t.puts.length).toBe(puts);
    expect(await state(user, importId)).toMatchObject({ status: "done", done: 1 });
    expect(await photosOf(user)).toHaveLength(1);
  });

  test("a copy whose upload failed reuses its pending photo on the retry", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked()]);
    await handleImportMessage(deps, messagesOf(importId)[0]!);
    const copy = copiesOf(importId)[0]!;
    t.hooks.onPut = async () => {
      t.hooks.onPut = undefined;
      throw new Error("S3 unavailable");
    };
    await expect(handleImportMessage(deps, copy)).rejects.toThrow("S3 unavailable");
    const pending = await t.repos.photos.claimed(user, importClaimId(importId, copy.mediaItemId));
    await handleImportMessage(deps, copy);
    const photos = await photosOf(user);
    expect(photos.map((p) => p.photoId)).toEqual([pending!.photoId]);
    expect(await state(user, importId)).toMatchObject({ status: "done", done: 1 });
  });

  test("a pending photo is removed when its retry finds the photo gone at Google", async () => {
    const user = newUserId();
    const item = picked({ size: 700 });
    const { importId } = await pickedImport(user, [item]);
    await handleImportMessage(deps, messagesOf(importId)[0]!);
    const copy = copiesOf(importId)[0]!;
    t.hooks.onPut = async () => {
      t.hooks.onPut = undefined;
      throw new Error("S3 unavailable");
    };
    await expect(handleImportMessage(deps, copy)).rejects.toThrow();
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(700);
    t.google.files.set(item.baseUrl, { kind: "not-found" });
    await handleImportMessage(deps, copy);
    expect(await photosOf(user)).toEqual([]);
    expect((await t.repos.usage.get(user)).bytesReserved).toBe(0);
    expect(await state(user, importId)).toMatchObject({ status: "done", failed: 1 });
  });

  test("a redelivered list message after listing sends nothing again", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked(), picked()]);
    const list = messagesOf(importId)[0]!;
    await handleImportMessage(deps, list);
    await handleImportMessage(deps, list);
    expect(copiesOf(importId)).toHaveLength(2);
  });

  test("Google or S3 trouble throws, so SQS delivers again; nothing is counted", async () => {
    const user = newUserId();
    const item = picked();
    t.google.files.set(item.baseUrl, new Error("Google 503"));
    const { importId } = await pickedImport(user, [item]);
    await handleImportMessage(deps, messagesOf(importId)[0]!);
    await expect(handleImportMessage(deps, copiesOf(importId)[0]!)).rejects.toThrow("Google 503");
    expect(await state(user, importId)).toMatchObject({ status: "copying", done: 0, failed: 0 });
  });
});

describe("cancelled and expired imports (FR-IMP-5)", () => {
  test("queued copies of a cancelled import stop; photos already copied stay", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked(), picked(), picked()]);
    await handleImportMessage(deps, messagesOf(importId)[0]!);
    const [first, ...rest] = copiesOf(importId);
    await handleImportMessage(deps, first!);
    expect((await t.api(user, "DELETE", `/imports/${importId}`)).status).toBe(204);
    const downloads = t.google.downloads.length;
    for (const copy of rest) await handleImportMessage(deps, copy);
    expect(t.google.downloads.length).toBe(downloads);
    expect(await photosOf(user)).toHaveLength(1);
    expect(await state(user, importId)).toMatchObject({ status: "cancelled", done: 1, total: 3 });
  });

  test("a list cancelled before it runs does nothing", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked()]);
    await t.api(user, "DELETE", `/imports/${importId}`);
    await handleImportMessage(deps, messagesOf(importId)[0]!);
    expect(copiesOf(importId)).toEqual([]);
  });

  test("a token refused while listing expires the import", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked()]);
    t.google.failWith = 401;
    await handleImportMessage(deps, messagesOf(importId)[0]!);
    expect((await state(user, importId)).status).toBe("expired");
    expect(copiesOf(importId)).toEqual([]);
  });
});

describe("SQS records", () => {
  test("an unreadable message is dropped without logging its body", async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((entry: unknown) => errors.push(entry));
    const body = JSON.stringify({ type: "copy", baseUrl: "https://secret.example/x" });
    await handleRecord(deps, { messageId: "m-1", body });
    await handleRecord(deps, { messageId: "m-2", body: "not json" });
    expect(errors).toHaveLength(2);
    expect(JSON.stringify(errors)).not.toContain("secret.example");
  });

  test("a valid record runs its step", async () => {
    const user = newUserId();
    const { importId } = await pickedImport(user, [picked()]);
    await handleRecord(deps, { messageId: "m-3", body: JSON.stringify(messagesOf(importId)[0]) });
    expect(copiesOf(importId)).toHaveLength(1);
  });
});

describe("sqsImportQueue.sendBatch", () => {
  const message = (n: number): ImportMessage => ({
    type: "list",
    userId: "3f1c2b4a-9d8e-4f7a-b6c5-1a2b3c4d5e6f",
    importId: `01JABCDEFGHJKMNPQRSTVWXY${String(n).padStart(2, "0")}`,
  });

  test("sends 10 per call", async () => {
    const send = vi.fn(async () => ({ Successful: [], Failed: [] }));
    const queue = sqsImportQueue({ send } as unknown as SQSClient, "https://sqs/q");
    await queue.sendBatch(Array.from({ length: 23 }, (_, n) => message(n)));
    const sizes = (send.mock.calls as unknown as [{ input: { Entries: unknown[] } }][]).map(
      ([command]) => command.input.Entries.length,
    );
    expect(sizes).toEqual([10, 10, 3]);
  });

  test("throws when SQS refused some messages", async () => {
    const send = vi.fn(async () => ({ Failed: [{ Id: "0", SenderFault: false, Code: "x" }] }));
    const queue = sqsImportQueue({ send } as unknown as SQSClient, "https://sqs/q");
    await expect(queue.sendBatch([message(1)])).rejects.toThrow("1 import messages were not sent");
  });
});
