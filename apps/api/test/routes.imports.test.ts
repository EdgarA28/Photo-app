/**
 * Import from Google Photos, API side (13.5c; FR-IMP-1/2/5, §5.2, §9, NFR-SEC-10): start, poll,
 * hand over to the worker, expire and cancel, against DynamoDB Local with a fake Google and queue.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  importSchema,
  MAX_PHOTOS_PER_IMPORT,
  startGoogleImportResponseSchema,
  type Import,
} from "@photo-app/shared";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EXPIRY_GRACE_MS } from "../src/routes/imports";
import { createTestApi, newUserId, TEST_APP_ORIGIN, TEST_IMPORT_REDIRECT } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let t: TestApi;

beforeAll(async () => {
  t = await createTestApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  t.google.pollIntervalSec = 0;
  t.google.tokenLifetimeMs = 60 * 60 * 1000;
  t.google.sessionLifetimeMs = 30 * 60 * 1000;
});

const VERIFIER = "v".repeat(43);
const start = (as: string, overrides: Record<string, unknown> = {}) =>
  t.api(as, "POST", "/imports/google", {
    code: "good-code",
    codeVerifier: VERIFIER,
    redirectUri: TEST_IMPORT_REDIRECT,
    ...overrides,
  });

async function started(as: string) {
  const res = await start(as);
  expect(res.status).toBe(201);
  return startGoogleImportResponseSchema.parse(res.body);
}

const progress = async (as: string, importId: string) => {
  const res = await t.api(as, "GET", `/imports/${importId}`);
  expect(res.status).toBe(200);
  return importSchema.parse(res.body);
};

const sessionOf = (pickerUri: string) => pickerUri.split("/").pop()!;
const pickDone = (pickerUri: string) => {
  t.google.sessions.get(sessionOf(pickerUri))!.mediaItemsSet = true;
};
const polls = () => t.google.calls.filter((c) => c.operation === "get").length;

/** Puts an import in a later state directly, as the worker (13.5d) would. */
async function setState(userId: string, importId: string, values: Record<string, unknown>) {
  const names = Object.keys(values);
  await t.db.client.send(
    new UpdateCommand({
      TableName: t.db.table,
      Key: { PK: `USER#${userId}`, SK: `IMPORT#${importId}` },
      UpdateExpression: `SET ${names.map((n) => `#${n} = :${n}`).join(", ")}`,
      ExpressionAttributeNames: Object.fromEntries(names.map((n) => [`#${n}`, n])),
      ExpressionAttributeValues: Object.fromEntries(names.map((n) => [`:${n}`, values[n]])),
    }),
  );
}

const PICKING: Import = {
  status: "picking",
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  failedReasons: {},
};

describe("POST /imports/google (FR-IMP-1/2)", () => {
  test("exchanges the code, opens a Picker session for at most 500 photos, stores the import", async () => {
    const user = newUserId();
    const body = await started(user);
    expect(body.pickerUri).toMatch(/^https:\/\/photos\.google\.com\/picker\//);
    expect(t.google.maxItemCounts.at(-1)).toBe(MAX_PHOTOS_PER_IMPORT);
    // Picking ends with the session (30 min), before the token (1 h).
    const session = t.google.sessions.get(sessionOf(body.pickerUri))!;
    expect(body.expiresAt).toBe(session.expiresAt.toISOString());

    const record = await t.repos.imports.get(user, body.importId);
    expect(record).toMatchObject({
      userId: user,
      source: "google-photos",
      status: "picking",
      sessionId: session.sessionId,
      accessToken: expect.stringMatching(/^token-/),
    });
    expect(await progress(user, body.importId)).toEqual(PICKING);
  });

  test("the Google token never reaches the browser (NFR-SEC-10)", async () => {
    const user = newUserId();
    const res = await start(user);
    const { importId } = startGoogleImportResponseSchema.parse(res.body);
    const token = (await t.repos.imports.get(user, importId))!.accessToken!;
    expect(JSON.stringify(res.body)).not.toContain(token);
    const read = await t.api(user, "GET", `/imports/${importId}`);
    expect(JSON.stringify(read.body)).not.toContain(token);
    expect(Object.keys(read.body as object).sort()).toEqual(
      ["done", "failed", "failedReasons", "skipped", "status", "total"].sort(),
    );
  });

  test("ends picking with the token when it runs out before the session", async () => {
    t.google.tokenLifetimeMs = 10 * 60 * 1000;
    const user = newUserId();
    const body = await started(user);
    const record = (await t.repos.imports.get(user, body.importId))!;
    expect(body.expiresAt).toBe(record.tokenExpiresAt);
  });

  test("a code Google rejects is 400 GOOGLE_AUTH_FAILED and stores nothing", async () => {
    const res = await start(newUserId(), { code: "bad-code" });
    expect(res).toEqual({
      status: 400,
      body: {
        error: { code: "GOOGLE_AUTH_FAILED", message: "Google didn't accept the authorization" },
      },
    });
  });

  test("a redirect URI on another origin is refused before Google is asked", async () => {
    const before = t.google.calls.length;
    const res = await start(newUserId(), {
      redirectUri: "https://evil.example/import/google/callback",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(t.google.calls.length).toBe(before);
    // The allowed origin with another path fails the schema already.
    const path = await start(newUserId(), { redirectUri: `${TEST_APP_ORIGIN}/gallery` });
    expect(path.status).toBe(400);
  });

  test("a bad body is 400", async () => {
    expect((await start(newUserId(), { codeVerifier: "short" })).status).toBe(400);
    expect((await t.api(newUserId(), "POST", "/imports/google", {})).status).toBe(400);
  });

  test("anonymous callers get 401", async () => {
    expect((await t.api(null, "POST", "/imports/google", {})).status).toBe(401);
  });
});

describe("GET /imports/{id} while picking (FR-IMP-5, §5.2 step 5)", () => {
  test("stays picking until the user is done, then hands over to the worker once", async () => {
    const user = newUserId();
    const { importId, pickerUri } = await started(user);
    expect((await progress(user, importId)).status).toBe("picking");

    pickDone(pickerUri);
    expect((await progress(user, importId)).status).toBe("listing");
    expect(t.importMessages.filter((m) => m.importId === importId)).toEqual([
      { type: "list", userId: user, importId },
    ]);

    // Later reads don't ask Google again and don't send a second message.
    const before = polls();
    expect((await progress(user, importId)).status).toBe("listing");
    expect(polls()).toBe(before);
    expect(t.importMessages.filter((m) => m.importId === importId)).toHaveLength(1);
  });

  test("asks Google at most once per poll interval", async () => {
    t.google.pollIntervalSec = 60;
    const user = newUserId();
    const { importId } = await started(user);
    const before = polls();
    await Promise.all([1, 2, 3, 4].map(() => progress(user, importId)));
    await progress(user, importId);
    expect(polls() - before).toBe(1);
  });

  test("parallel reads after Done send one list message", async () => {
    const user = newUserId();
    const { importId, pickerUri } = await started(user);
    pickDone(pickerUri);
    const states = await Promise.all([1, 2, 3].map(() => progress(user, importId)));
    expect(states.map((s) => s.status)).toContain("listing");
    expect(t.importMessages.filter((m) => m.importId === importId)).toHaveLength(1);
  });

  test("a failed queue send goes back to picking and the next poll sends it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = newUserId();
    const { importId, pickerUri } = await started(user);
    pickDone(pickerUri);
    t.queue.fails = true;
    expect((await progress(user, importId)).status).toBe("picking");
    expect(t.importMessages.filter((m) => m.importId === importId)).toEqual([]);
    expect((await progress(user, importId)).status).toBe("listing");
    expect(t.importMessages.filter((m) => m.importId === importId)).toHaveLength(1);
  });

  test("a Google error keeps the import picking; the next poll tries again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = newUserId();
    const { importId, pickerUri } = await started(user);
    t.google.failWith = 503;
    expect((await progress(user, importId)).status).toBe("picking");
    pickDone(pickerUri);
    expect((await progress(user, importId)).status).toBe("listing");
  });

  test.each([
    [
      "Google forgot the session",
      (pickerUri: string) => t.google.sessions.delete(sessionOf(pickerUri)),
    ],
    ["the token was revoked", () => (t.google.failWith = 401)],
  ])("expires when %s, and drops the token", async (_, cause) => {
    const user = newUserId();
    const { importId, pickerUri } = await started(user);
    cause(pickerUri);
    expect(await progress(user, importId)).toEqual({ ...PICKING, status: "expired" });
    const record = (await t.repos.imports.get(user, importId))!;
    expect(record.status).toBe("expired");
    expect(record).not.toHaveProperty("accessToken");
  });

  test("expires without asking Google once picking time is over", async () => {
    t.google.sessionLifetimeMs = -1000;
    const user = newUserId();
    const { importId, pickerUri } = await started(user);
    const before = polls();
    expect((await progress(user, importId)).status).toBe("expired");
    expect(polls()).toBe(before);
    // The token still works, so the Picker session is deleted too.
    expect(t.google.deleted).toContain(sessionOf(pickerUri));
    expect(await t.repos.imports.get(user, importId)).not.toHaveProperty("accessToken");
  });
});

describe("GET /imports/{id} after picking (§10.1)", () => {
  test("shows the worker's progress", async () => {
    const user = newUserId();
    const { importId } = await started(user);
    await setState(user, importId, {
      status: "copying",
      total: 50,
      done: 47,
      failed: 1,
      skipped: 2,
      failedReasons: { QUOTA_EXCEEDED: 1 },
    });
    expect(await progress(user, importId)).toEqual({
      status: "copying",
      total: 50,
      done: 47,
      failed: 1,
      skipped: 2,
      failedReasons: { QUOTA_EXCEEDED: 1 },
    });
  });

  test("closes an import still copying after the token ran out: the rest fail as EXPIRED", async () => {
    const user = newUserId();
    const { importId } = await started(user);
    const expired = new Date(Date.now() - EXPIRY_GRACE_MS - 1000).toISOString();
    await setState(user, importId, {
      status: "copying",
      total: 10,
      done: 6,
      failed: 1,
      failedReasons: { TOO_LARGE: 1 },
      tokenExpiresAt: expired,
    });
    expect(await progress(user, importId)).toEqual({
      status: "expired",
      total: 10,
      done: 6,
      failed: 4,
      skipped: 0,
      failedReasons: { TOO_LARGE: 1, EXPIRED: 3 },
    });
    expect(await t.repos.imports.get(user, importId)).not.toHaveProperty("accessToken");
  });

  test("leaves a copy that may still finish alone during the grace period", async () => {
    const user = newUserId();
    const { importId } = await started(user);
    const justExpired = new Date(Date.now() - 1000).toISOString();
    await setState(user, importId, { status: "copying", total: 2, tokenExpiresAt: justExpired });
    expect((await progress(user, importId)).status).toBe("copying");
  });

  test("a finished import stays as it is", async () => {
    const user = newUserId();
    const { importId } = await started(user);
    await setState(user, importId, { status: "done", total: 3, done: 3 });
    expect(await progress(user, importId)).toMatchObject({ status: "done", done: 3 });
  });
});

describe("DELETE /imports/{id} (FR-IMP-5)", () => {
  test("cancels, drops the token and deletes the Picker session", async () => {
    const user = newUserId();
    const { importId, pickerUri } = await started(user);
    expect((await t.api(user, "DELETE", `/imports/${importId}`)).status).toBe(204);
    expect((await progress(user, importId)).status).toBe("cancelled");
    expect(await t.repos.imports.get(user, importId)).not.toHaveProperty("accessToken");
    expect(t.google.deleted).toContain(sessionOf(pickerUri));
  });

  test("keeps the counts while copying: photos already copied stay", async () => {
    const user = newUserId();
    const { importId } = await started(user);
    await setState(user, importId, { status: "copying", total: 10, done: 4 });
    expect((await t.api(user, "DELETE", `/imports/${importId}`)).status).toBe(204);
    expect(await progress(user, importId)).toMatchObject({
      status: "cancelled",
      total: 10,
      done: 4,
      failed: 0,
    });
  });

  test("is idempotent and leaves a finished import as it is", async () => {
    const user = newUserId();
    const { importId } = await started(user);
    await setState(user, importId, { status: "done", total: 1, done: 1 });
    expect((await t.api(user, "DELETE", `/imports/${importId}`)).status).toBe(204);
    expect((await progress(user, importId)).status).toBe("done");
  });

  test("an unknown or malformed import ID is 404 / 400", async () => {
    const user = newUserId();
    expect((await t.api(user, "DELETE", "/imports/01JABCDEFGHJKMNPQRSTVWXYZ0")).status).toBe(404);
    expect((await t.api(user, "GET", "/imports/01JABCDEFGHJKMNPQRSTVWXYZ0")).status).toBe(404);
    expect((await t.api(user, "GET", "/imports/nope")).status).toBe(400);
  });
});

test("logs never contain the Google token (NFR-SEC-10)", async () => {
  const logged: unknown[] = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((entry: unknown) => logged.push(entry));
  }
  const user = newUserId();
  const { importId, pickerUri } = await started(user);
  const token = (await t.repos.imports.get(user, importId))!.accessToken!;
  t.google.failWith = 503;
  await progress(user, importId);
  pickDone(pickerUri);
  await progress(user, importId);
  await t.api(user, "DELETE", `/imports/${importId}`);
  expect(logged.length).toBeGreaterThan(0);
  expect(JSON.stringify(logged)).not.toContain(token);
});
