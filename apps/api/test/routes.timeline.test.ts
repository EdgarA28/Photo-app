/**
 * Timeline scrubber support (8.36, FR-GAL-9): month counts (`GET /photos/timeline`) and a gallery
 * list that starts at any date (`start`) and grows backward (`prevCursor`, `direction=backward`).
 */
import { photoPageSchema, timelineSchema, type Photo } from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import { createPending, createTestApi, markReady, newPhoto, newUserId } from "./helpers";

type TestApi = Awaited<ReturnType<typeof createTestApi>>;
let t: TestApi;

/** Photos of one user, taken at these instants (newest first in the gallery). */
const TAKEN = [
  "2026-10-05T10:00:00.000Z",
  "2026-10-01T10:00:00.000Z",
  "2026-08-20T10:00:00.000Z",
  "2025-12-31T23:30:00.000Z",
  "2025-06-15T10:00:00.000Z",
  "2025-06-14T10:00:00.000Z",
  "2021-03-03T10:00:00.000Z",
];
const user = newUserId();
const ids = new Map<string, string>();

async function photoTakenAt(userId: string, takenAt: string, video = false) {
  const photo = await createPending(t.repos, {
    ...newPhoto(userId),
    ...(video && { mediaType: "video" as const, contentType: "video/mp4" as const }),
  });
  await markReady(t.db, userId, photo.photoId, 1000, takenAt);
  return photo.photoId;
}

beforeAll(async () => {
  t = await createTestApi();
  for (const takenAt of TAKEN) ids.set(takenAt, await photoTakenAt(user, takenAt));
  // A video and a trashed photo: neither is in the Gallery's timeline.
  await photoTakenAt(user, "2024-01-01T10:00:00.000Z", true);
  const trashed = await photoTakenAt(user, "2023-05-05T10:00:00.000Z");
  await t.repos.photos.trash(user, trashed, new Date());
});

const page = async (query: string, as = user) => {
  const res = await t.api(as, "GET", `/photos?${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return photoPageSchema.parse(res.body);
};
const taken = (photos: Photo[]) => photos.map((p) => p.takenAt);

describe("GET /photos/timeline", () => {
  test("months with counts, newest first, photos only", async () => {
    const res = await t.api(user, "GET", "/photos/timeline");
    expect(res.status).toBe(200);
    expect(timelineSchema.parse(res.body).months).toEqual([
      { month: "2026-10", count: 2 },
      { month: "2026-08", count: 1 },
      { month: "2025-12", count: 1 },
      { month: "2025-06", count: 2 },
      { month: "2021-03", count: 1 },
    ]);
  });

  test("in the caller's time zone: 23:30 UTC on Dec 31 is January at UTC+1", async () => {
    const res = await t.api(user, "GET", "/photos/timeline?utcOffset=60");
    const months = timelineSchema.parse(res.body).months.map((m) => m.month);
    expect(months).toContain("2026-01");
    expect(months).not.toContain("2025-12");
  });

  test("the Videos section has its own", async () => {
    const res = await t.api(user, "GET", "/photos/timeline?mediaType=video");
    expect(timelineSchema.parse(res.body).months).toEqual([{ month: "2024-01", count: 1 }]);
  });

  test("another user sees only their own; an empty library has no months", async () => {
    expect((await t.api(newUserId(), "GET", "/photos/timeline")).body).toEqual({ months: [] });
  });

  test("a bad offset is 400", async () => {
    expect((await t.api(user, "GET", "/photos/timeline?utcOffset=900")).status).toBe(400);
  });
});

describe("GET /photos starting at a date (start, prevCursor, backward)", () => {
  test("from the top: no prevCursor", async () => {
    const top = await page("limit=3");
    expect(taken(top.items)).toEqual(TAKEN.slice(0, 3));
    expect(top.prevCursor).toBeNull();
  });

  test("newest first: starts before `start`, then walks back up to the top", async () => {
    // Jump to June 2025: everything taken before July.
    const jump = await page("limit=2&start=2025-07-01T00:00:00.000Z");
    expect(taken(jump.items)).toEqual(["2025-06-15T10:00:00.000Z", "2025-06-14T10:00:00.000Z"]);
    expect(jump.nextCursor).not.toBeNull();
    expect(jump.prevCursor).not.toBeNull();

    // Newer photos come back in the sort order, a page at a time, until the top.
    const back1 = await page(`limit=2&direction=backward&cursor=${jump.prevCursor}`);
    expect(taken(back1.items)).toEqual(["2026-08-20T10:00:00.000Z", "2025-12-31T23:30:00.000Z"]);
    expect(back1.prevCursor).not.toBeNull();
    const back2 = await page(`limit=2&direction=backward&cursor=${back1.prevCursor}`);
    expect(taken(back2.items)).toEqual(TAKEN.slice(0, 2));
    // Exactly at the top: a last request finds nothing more.
    const end = back2.prevCursor
      ? await page(`limit=2&direction=backward&cursor=${back2.prevCursor}`)
      : null;
    expect(end?.items ?? []).toEqual([]);
    expect(end?.prevCursor ?? null).toBeNull();

    // Forward from the jump goes on to the oldest.
    const older = await page(`limit=5&cursor=${jump.nextCursor}`);
    expect(taken(older.items)).toEqual(["2021-03-03T10:00:00.000Z"]);
  });

  test("oldest first: starts at `start`", async () => {
    const jump = await page("sort=taken-asc&limit=2&start=2025-06-15T00:00:00.000Z");
    expect(taken(jump.items)).toEqual(["2025-06-15T10:00:00.000Z", "2025-12-31T23:30:00.000Z"]);
    const back = await page(`sort=taken-asc&limit=5&direction=backward&cursor=${jump.prevCursor}`);
    expect(taken(back.items)).toEqual(["2021-03-03T10:00:00.000Z", "2025-06-14T10:00:00.000Z"]);
  });

  test("a start after every photo gives the whole list; one before every photo, nothing", async () => {
    expect(taken((await page("limit=20&start=2030-01-01T00:00:00.000Z")).items)).toEqual(TAKEN);
    const none = await page("limit=20&start=2000-01-01T00:00:00.000Z");
    expect(none.items).toEqual([]);
    expect(none.prevCursor).toBeNull();
  });

  test.each([
    ["start with a cursor", `start=2025-07-01T00:00:00.000Z&cursor=abc`],
    ["backward without a cursor", "direction=backward"],
    ["a bad start", "start=yesterday"],
  ])("%s is 400", async (_, query) => {
    expect((await t.api(user, "GET", `/photos?${query}`)).status).toBe(400);
  });

  test("another user's prevCursor is refused", async () => {
    const jump = await page("limit=1&start=2025-07-01T00:00:00.000Z");
    const res = await t.api(
      newUserId(),
      "GET",
      `/photos?direction=backward&cursor=${jump.prevCursor}`,
    );
    expect(res).toEqual({
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: "Invalid cursor" } },
    });
  });
});
