/**
 * Place routes (13.2e, 13.2h) on DynamoDB Local: the caller's places, their photos, map pins,
 * cleanup on delete.
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  apiErrorSchema,
  photoLocationListSchema,
  photoPageSchema,
  photoSchema,
  placeListSchema,
} from "@photo-app/shared";
import { beforeAll, describe, expect, test } from "vitest";
import type { Db, Repositories } from "../src/repo";
import {
  addPlaces,
  BERLIN,
  createPending,
  createTestApi,
  markReady,
  newPhoto,
  newUserId,
  type TestPlace,
} from "./helpers";

let db: Db;
let repos: Repositories;
let api: Awaited<ReturnType<typeof createTestApi>>["api"];
beforeAll(async () => {
  ({ db, repos, api } = await createTestApi());
});

const MUNICH: TestPlace[] = [
  { placeId: "city:2867714", kind: "city", name: "Munich", context: "Bavaria, Germany" },
  { placeId: "region:DE.02", kind: "region", name: "Bavaria", context: "Germany" },
  { placeId: "country:DE", kind: "country", name: "Germany", context: "" },
];

async function photoAt(userId: string, takenAt: string, places: TestPlace[]) {
  const { photoId } = await createPending(repos, newPhoto(userId));
  await markReady(db, userId, photoId, 1000, takenAt);
  await addPlaces(db, userId, photoId, places);
  return photoId;
}

async function places(userId: string) {
  return placeListSchema.parse((await api(userId, "GET", "/places")).body).items;
}

describe("GET /places", () => {
  test("lists the caller's places with photo counts, most photos first", async () => {
    const user = newUserId();
    await photoAt(user, "2024-01-01T10:00:00.000Z", BERLIN);
    await photoAt(user, "2024-02-01T10:00:00.000Z", BERLIN);
    await photoAt(user, "2024-03-01T10:00:00.000Z", MUNICH);

    expect(await places(user)).toEqual([
      { placeId: "country:DE", kind: "country", name: "Germany", context: "", photoCount: 3 },
      {
        placeId: "city:2950159",
        kind: "city",
        name: "Berlin",
        context: "State of Berlin, Germany",
        photoCount: 2,
      },
      {
        placeId: "region:DE.16",
        kind: "region",
        name: "State of Berlin",
        context: "Germany",
        photoCount: 2,
      },
      {
        placeId: "region:DE.02",
        kind: "region",
        name: "Bavaria",
        context: "Germany",
        photoCount: 1,
      },
      {
        placeId: "city:2867714",
        kind: "city",
        name: "Munich",
        context: "Bavaria, Germany",
        photoCount: 1,
      },
    ]);
  });

  test("is empty without photos with GPS", async () => {
    expect(await places(newUserId())).toEqual([]);
  });
});

describe("GET /places/{placeId}/photos", () => {
  test("lists the place's photos by date taken, both ways, page by page", async () => {
    const user = newUserId();
    const old = await photoAt(user, "2020-05-01T10:00:00.000Z", BERLIN);
    const recent = await photoAt(user, "2025-05-01T10:00:00.000Z", BERLIN);
    const middle = await photoAt(user, "2022-05-01T10:00:00.000Z", BERLIN);
    await photoAt(user, "2023-05-01T10:00:00.000Z", MUNICH);

    const walk = async (query: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const path: string = `/places/city:2950159/photos?limit=2${query}${cursor ? `&cursor=${cursor}` : ""}`;
        const page = photoPageSchema.parse((await api(user, "GET", path)).body);
        seen.push(...page.items.map((p) => p.photoId));
        cursor = page.nextCursor;
      } while (cursor);
      return seen;
    };
    expect(await walk("")).toEqual([recent, middle, old]);
    expect(await walk("&sort=taken-asc")).toEqual([old, middle, recent]);
    // The country covers both cities.
    const germany = photoPageSchema.parse(
      (await api(user, "GET", "/places/country:DE/photos")).body,
    );
    expect(germany.items).toHaveLength(4);
  });

  test("photos carry the place name, never the coordinates", async () => {
    const user = newUserId();
    const photoId = await photoAt(user, "2024-01-01T10:00:00.000Z", BERLIN);
    const { body } = await api(user, "GET", `/photos/${photoId}`);
    expect(photoSchema.parse(body).place).toEqual({
      city: "Berlin",
      region: "State of Berlin",
      country: "Germany",
    });
    expect(JSON.stringify(body)).not.toMatch(/latitude|longitude|52\.52/);
  });

  test("a place the caller doesn't have is 404, a malformed ID 400", async () => {
    const user = newUserId();
    const unknown = await api(user, "GET", "/places/city:2950159/photos");
    expect(unknown.status).toBe(404);
    expect(apiErrorSchema.parse(unknown.body).error.message).toBe("Place not found");
    for (const bad of ["Berlin", "city:abc", "country:de", "region:DE"]) {
      expect((await api(user, "GET", `/places/${bad}/photos`)).status).toBe(400);
    }
  });
});

describe("GET /places/map (13.2h, FR-SRCH-5)", () => {
  /** GPS without a town nearby: the Lambda keeps the coordinates but writes no place. */
  async function setGps(userId: string, photoId: string, lat: number, lon: number) {
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        Key: { PK: `USER#${userId}`, SK: `PHOTO#${photoId}` },
        UpdateExpression: "SET latitude = :lat, longitude = :lon",
        ExpressionAttributeValues: { ":lat": lat, ":lon": lon },
      }),
    );
  }

  async function pins(userId: string) {
    return photoLocationListSchema.parse((await api(userId, "GET", "/places/map")).body).items;
  }

  test("lists ready photos with GPS, newest first, coordinates rounded to ~100 m", async () => {
    const user = newUserId();
    const berlin = await photoAt(user, "2024-01-01T10:00:00.000Z", BERLIN);
    const { photoId: atSea } = await createPending(repos, newPhoto(user));
    await markReady(db, user, atSea, 1000, "2024-06-01T10:00:00.000Z");
    // Southern and western hemispheres round the same way.
    await setGps(user, atSea, -33.856789, -151.215432);
    const { photoId: noGps } = await createPending(repos, newPhoto(user));
    await markReady(db, user, noGps, 1000, "2024-03-01T10:00:00.000Z");

    expect(await pins(user)).toEqual([
      {
        photoId: atSea,
        lat: -33.857,
        lon: -151.215,
        takenAt: "2024-06-01T10:00:00.000Z",
        thumbUrl: `/users/${user}/thumbs/${atSea}.jpg`,
      },
      {
        photoId: berlin,
        lat: 52.52,
        lon: 13.41,
        takenAt: "2024-01-01T10:00:00.000Z",
        thumbUrl: `/users/${user}/thumbs/${berlin}.jpg`,
      },
    ]);
  });

  test("leaves out photos that aren't ready and other users' photos", async () => {
    const user = newUserId();
    const other = newUserId();
    const { photoId: pending } = await createPending(repos, newPhoto(user));
    await setGps(user, pending, 48.1, 11.5);
    await photoAt(other, "2024-01-01T10:00:00.000Z", BERLIN);

    expect(await pins(user)).toEqual([]);
    expect(await pins(other)).toHaveLength(1);
  });

  test("a deleted photo leaves the map", async () => {
    const user = newUserId();
    const photoId = await photoAt(user, "2024-01-01T10:00:00.000Z", BERLIN);
    expect((await api(user, "DELETE", `/photos/${photoId}`)).status).toBe(204);
    expect(await pins(user)).toEqual([]);
  });
});

describe("deleting a photo (FR-DEL-1) takes it out of its places", () => {
  test("counts go down, its place items go, and an emptied place disappears", async () => {
    const user = newUserId();
    const berlin1 = await photoAt(user, "2024-01-01T10:00:00.000Z", BERLIN);
    const berlin2 = await photoAt(user, "2024-02-01T10:00:00.000Z", BERLIN);
    const munich = await photoAt(user, "2024-03-01T10:00:00.000Z", MUNICH);

    expect((await api(user, "DELETE", `/photos/${berlin1}`)).status).toBe(204);
    expect((await api(user, "DELETE", `/photos/${munich}`)).status).toBe(204);

    expect((await places(user)).map((p) => [p.placeId, p.photoCount])).toEqual([
      ["city:2950159", 1],
      ["country:DE", 1],
      ["region:DE.16", 1],
    ]);
    const berlin = photoPageSchema.parse(
      (await api(user, "GET", "/places/city:2950159/photos")).body,
    );
    expect(berlin.items.map((p) => p.photoId)).toEqual([berlin2]);
    expect((await api(user, "GET", "/places/city:2867714/photos")).status).toBe(404);
  });
});
