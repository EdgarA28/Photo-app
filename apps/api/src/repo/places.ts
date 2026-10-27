import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Page, PhotoSort, PlaceKind } from "@photo-app/shared";
import { queryAll, queryPage, stripKeys, type Db } from "./db";
import {
  GSI1,
  GSI1_KEY_ATTRIBUTES,
  PLACE_SK_PREFIX,
  placeKey,
  placePhotosPk,
  userPk,
} from "./keys";

/**
 * The caller's places (13.2c, §8.2), written by the thumbnail Lambda in the same transaction that
 * marks a photo `ready`: a list item per place (`USER#{userId}` / `PLACE#{placeId}`, with a photo
 * count) and one item per place and photo (`PLACE#{userId}#{placeId}` / `PHOTO#{photoId}`, in GSI1
 * by date taken). Photo deletes take a photo's items out (photos repo). Owner only, by key.
 */
export interface PlaceRecord {
  placeId: string;
  kind: PlaceKind;
  name: string;
  context: string;
  photoCount: number;
}

export interface PlacePhotoRecord {
  placeId: string;
  photoId: string;
  ownerId: string;
}

export function placesRepo(db: Db) {
  return {
    /** Places with photos, most photos first, then by name. */
    async list(userId: string): Promise<PlaceRecord[]> {
      const items = await queryAll(db, {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": userPk(userId), ":prefix": PLACE_SK_PREFIX },
      });
      return items
        .map((item) => stripKeys<PlaceRecord>(item))
        .filter((place) => place.photoCount > 0)
        .sort((a, b) => b.photoCount - a.photoCount || a.name.localeCompare(b.name));
    },

    async get(userId: string, placeId: string): Promise<PlaceRecord | null> {
      const output = await db.client.send(
        new GetCommand({ TableName: db.table, Key: placeKey(userId, placeId) }),
      );
      const place = output.Item ? stripKeys<PlaceRecord>(output.Item) : null;
      return place && place.photoCount > 0 ? place : null;
    },

    /** The place's photos by date taken, newest first unless `taken-asc` (GSI1). */
    async listPhotos(
      userId: string,
      placeId: string,
      options: { sort: PhotoSort; limit: number; cursor?: string | undefined },
    ): Promise<Page<PlacePhotoRecord>> {
      const pk = placePhotosPk(userId, placeId);
      const page = await queryPage(db, {
        input: {
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :taken)",
          ExpressionAttributeValues: { ":pk": pk, ":taken": "TAKEN#" },
          ScanIndexForward: options.sort === "taken-asc",
        },
        keyAttributes: GSI1_KEY_ATTRIBUTES,
        partition: { attribute: "GSI1PK", value: pk },
        limit: options.limit,
        cursor: options.cursor,
      });
      return { ...page, items: page.items.map((item) => stripKeys<PlacePhotoRecord>(item)) };
    },
  };
}
