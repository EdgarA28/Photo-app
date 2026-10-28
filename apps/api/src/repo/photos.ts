import { DeleteCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { AllowedContentType, Page, PhotoSort, PhotoStatus } from "@photo-app/shared";
import {
  batchGet,
  conditionFailedAt,
  isConditionalCheckFailed,
  queryAll,
  queryPage,
  stripKeys,
  type Db,
} from "./db";
import {
  GSI1,
  GSI1_KEY_ATTRIBUTES,
  photoKey,
  placeKey,
  PHOTO_SK_PREFIX,
  placePhotoKey,
  takenSk,
  usageKey,
  userPk,
} from "./keys";
import { removeMembership } from "./memberships";

/** Photo item without key attributes (spec §8.2). */
export interface PhotoRecord {
  userId: string;
  photoId: string;
  status: PhotoStatus;
  fileName: string;
  contentType: AllowedContentType;
  sizeBytes: number;
  originalKey: string;
  uploadedAt: string;
  /** Provisional = uploadedAt while pending; EXIF date once the thumbnail Lambda is done. */
  takenAt: string;
  width?: number;
  height?: number;
  processedAt?: string;
  failureReason?: string;
  /** Albums containing this photo: reverse index for deletes and share checks (§8.2). */
  albumIds?: Set<string>;
  /**
   * Where it was taken (13.2), set by the thumbnail Lambda from EXIF GPS. Sent out only rounded,
   * to the owner's map (13.2h).
   */
  latitude?: number;
  longitude?: number;
  place?: { city: string; region?: string; country: string; countryCode: string };
  /** The place list entries it counts in (`city:…`, `region:…`, `country:…`); removed with it. */
  placeIds?: Set<string>;
}

export type LocatedPhoto = Pick<PhotoRecord, "photoId" | "takenAt"> & {
  latitude: number;
  longitude: number;
};

export interface NewPhoto {
  userId: string;
  photoId: string;
  fileName: string;
  contentType: AllowedContentType;
  sizeBytes: number;
  originalKey: string;
  uploadedAt: string;
}

export function photosRepo(db: Db) {
  return {
    /**
     * Creates the `pending` item before the upload (5.6). GSI1SK uses uploadedAt as provisional
     * takenAt, so the photo shows up in the gallery straight away (FR-GAL-5, FR-UP-6).
     *
     * Reserves `sizeBytes` in Usage `bytesReserved` in the same transaction, only while the
     * reservation stays within `quotaBytes` (FR-UP-7, 5.6b). `bytesUsed`/`photoCount` are NOT
     * counted here: the thumbnail Lambda does that once the original is stored.
     */
    async createPending(
      photo: NewPhoto,
      { quotaBytes }: { quotaBytes: number },
    ): Promise<PhotoRecord | "quota-exceeded"> {
      if (photo.sizeBytes > quotaBytes) return "quota-exceeded";
      const record: PhotoRecord = { ...photo, status: "pending", takenAt: photo.uploadedAt };
      try {
        await db.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: db.table,
                  Item: {
                    ...photoKey(photo.userId, photo.photoId),
                    GSI1PK: userPk(photo.userId),
                    GSI1SK: takenSk(record.takenAt, photo.photoId),
                    entity: "photo",
                    ...record,
                  },
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
              {
                Update: {
                  TableName: db.table,
                  Key: usageKey(photo.userId),
                  UpdateExpression: "ADD bytesReserved :size",
                  // Conditions can't add, so the limit is precomputed: reserved + size <= quota.
                  ConditionExpression:
                    "attribute_not_exists(bytesReserved) OR bytesReserved <= :max",
                  ExpressionAttributeValues: {
                    ":size": photo.sizeBytes,
                    ":max": quotaBytes - photo.sizeBytes,
                  },
                },
              },
            ],
          }),
        );
      } catch (err) {
        if (conditionFailedAt(err, 1)) return "quota-exceeded";
        throw err;
      }
      return record;
    },

    get: (userId: string, photoId: string) => getPhoto(db, userId, photoId),

    /** Several of one user's photos; IDs that don't exist (or aren't theirs) are left out. */
    async getMany(userId: string, photoIds: string[]): Promise<PhotoRecord[]> {
      const unique = [...new Set(photoIds)];
      const items = await batchGet(
        db,
        unique.map((photoId) => photoKey(userId, photoId)),
      );
      return items.map((item) => stripKeys<PhotoRecord>(item));
    },

    /** Gallery: GSI1, by date taken (FR-GAL-1/2). */
    async list(
      userId: string,
      options: { sort: PhotoSort; limit: number; cursor?: string | undefined },
    ): Promise<Page<PhotoRecord>> {
      const page = await queryPage(db, {
        input: {
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :taken)",
          ExpressionAttributeValues: { ":pk": userPk(userId), ":taken": "TAKEN#" },
          ScanIndexForward: options.sort === "taken-asc",
        },
        keyAttributes: GSI1_KEY_ATTRIBUTES,
        partition: { attribute: "GSI1PK", value: userPk(userId) },
        limit: options.limit,
        cursor: options.cursor,
      });
      return { ...page, items: page.items.map((item) => stripKeys<PhotoRecord>(item)) };
    },

    /**
     * Ready photos with GPS for the map (13.2h), newest first. Reads the user's whole photo
     * partition (bounded by the quota) and keeps only the few attributes a pin needs.
     */
    async listLocated(userId: string): Promise<LocatedPhoto[]> {
      const items = await queryAll(db, {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        FilterExpression: "attribute_exists(latitude) AND #status = :ready",
        ProjectionExpression: "photoId, takenAt, latitude, longitude",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pk": userPk(userId),
          ":prefix": PHOTO_SK_PREFIX,
          ":ready": "ready",
        },
      });
      return items
        .map((item) => item as LocatedPhoto)
        .sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.photoId.localeCompare(a.photoId));
    },

    /**
     * Deletes the photo for DELETE /photos/{id} (5.9): first its album memberships (fixing album
     * counts and covers), then the item itself together with the Usage decrement: `bytesReserved`
     * always, `bytesUsed`/`photoCount` only if the thumbnail Lambda already counted the photo
     * (status != pending).
     *
     * Every step is conditional, so a retry after a partial failure finishes the job without
     * double-counting. Returns the deleted record, or null if it did not exist. S3 objects are
     * the caller's job.
     */
    async delete(userId: string, photoId: string): Promise<PhotoRecord | null> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const record = await getPhoto(db, userId, photoId, true);
        if (!record) return null;

        for (const albumId of record.albumIds ?? []) {
          await removeMembership(db, userId, albumId, photoId);
        }

        const counted = record.status !== "pending";
        try {
          await db.client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Delete: {
                    TableName: db.table,
                    Key: photoKey(userId, photoId),
                    // Guards against the thumbnail Lambda changing the status (and counting
                    // Usage) between our read and this delete.
                    ConditionExpression: "#status = :status",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: { ":status": record.status },
                  },
                },
                // Its place entries (13.2c). The status condition above covers them too: places
                // are written with `ready`, so a photo that changes status is re-read first.
                ...[...(record.placeIds ?? [])].flatMap((placeId) => [
                  { Delete: { TableName: db.table, Key: placePhotoKey(userId, placeId, photoId) } },
                  {
                    Update: {
                      TableName: db.table,
                      Key: placeKey(userId, placeId),
                      UpdateExpression: "ADD photoCount :minusOne",
                      ExpressionAttributeValues: { ":minusOne": -1 },
                    },
                  },
                ]),
                {
                  Update: {
                    TableName: db.table,
                    Key: usageKey(userId),
                    UpdateExpression: counted
                      ? "ADD bytesUsed :size, photoCount :one, bytesReserved :size"
                      : "ADD bytesReserved :size",
                    ExpressionAttributeValues: counted
                      ? { ":size": -record.sizeBytes, ":one": -1 }
                      : { ":size": -record.sizeBytes },
                  },
                },
              ],
            }),
          );
          await dropEmptyPlaces(db, userId, record.placeIds);
          return record;
        } catch (err) {
          // Status changed or photo deleted concurrently: re-read and try again.
          if (!conditionFailedAt(err, 0)) throw err;
        }
      }
      throw new Error(`Photo ${photoId} kept changing while being deleted`);
    },
  };
}

async function getPhoto(
  db: Db,
  userId: string,
  photoId: string,
  consistent = false,
): Promise<PhotoRecord | null> {
  const output = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: photoKey(userId, photoId),
      ConsistentRead: consistent,
    }),
  );
  return output.Item ? stripKeys<PhotoRecord>(output.Item) : null;
}

/** Removes place list entries left without photos; one that gained a photo meanwhile stays. */
async function dropEmptyPlaces(db: Db, userId: string, placeIds: Set<string> | undefined) {
  for (const placeId of placeIds ?? []) {
    try {
      await db.client.send(
        new DeleteCommand({
          TableName: db.table,
          Key: placeKey(userId, placeId),
          ConditionExpression: "photoCount <= :zero",
          ExpressionAttributeValues: { ":zero": 0 },
        }),
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }
}
