import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  TRASH_RETENTION_DAYS,
  type AllowedContentType,
  type Page,
  type PhotoSort,
  type PhotoStatus,
} from "@photo-app/shared";
import {
  batchGet,
  conditionFailedAt,
  isConditionalCheckFailed,
  queryAll,
  queryPage,
  stripKeys,
  type Db,
  transactWrite,
} from "./db";
import {
  GSI1,
  GSI1_KEY_ATTRIBUTES,
  PENDING_PK,
  pendingMarkerKey,
  photoKey,
  placeKey,
  PHOTO_SK_PREFIX,
  placePhotoKey,
  placePhotosPk,
  purgeSk,
  takenSk,
  TRASH_PK,
  uploadClaimKey,
  usageKey,
  userPk,
} from "./keys";
import { removeMembership, restoreMembership } from "./memberships";

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
  /**
   * In the trash (FR-DEL-3): deleted at `trashedAt`, purged for good from `purgeAt`. While
   * trashed the photo is out of the gallery, its albums and its places, but still counts in
   * Usage; `trashedAlbumIds` are the albums it goes back to when restored.
   */
  trashedAt?: string;
  purgeAt?: string;
  trashedAlbumIds?: Set<string>;
}

/** A trashed photo due for the purge (any user's). */
export interface ExpiredPhoto {
  userId: string;
  photoId: string;
}

/** A pending-upload marker (6.11): which photo, and when its upload was started. */
export interface PendingMarker {
  userId: string;
  photoId: string;
  uploadedAt: string;
}

/**
 * Markers outlive their check by this much at most (DynamoDB TTL), in case a sweep never gets to
 * them; the sweep normally removes each one the first day it is older than the cut-off.
 */
const PENDING_MARKER_TTL_DAYS = 30;

export type LocatedPhoto = Pick<PhotoRecord, "photoId" | "takenAt" | "placeIds"> & {
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
    /**
     * With `uploadId`, also records which photo that client upload created (kept 7 days, DynamoDB
     * TTL, or for good with `keepClaim`: a saved shared photo, FR-SHR-10): "claimed" if another
     * request with it got there first.
     *
     * Parallel creates clash on the Usage item (`TransactionConflict`, nothing applied):
     * retried by `transactWrite` (13.4).
     *
     * Also writes the photo's pending marker (6.11, last in the transaction so the condition
     * indexes above stay put), by which the daily sweep finds uploads that never arrived.
     */
    async createPending(
      photo: NewPhoto,
      {
        quotaBytes,
        uploadId,
        keepClaim = false,
      }: { quotaBytes: number; uploadId?: string | undefined; keepClaim?: boolean },
    ): Promise<PhotoRecord | "quota-exceeded" | "claimed"> {
      if (photo.sizeBytes > quotaBytes) return "quota-exceeded";
      const record: PhotoRecord = { ...photo, status: "pending", takenAt: photo.uploadedAt };
      try {
        await transactWrite(db, {
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
                ConditionExpression: "attribute_not_exists(bytesReserved) OR bytesReserved <= :max",
                ExpressionAttributeValues: {
                  ":size": photo.sizeBytes,
                  ":max": quotaBytes - photo.sizeBytes,
                },
              },
            },
            ...(uploadId
              ? [
                  {
                    Put: {
                      TableName: db.table,
                      Item: {
                        ...uploadClaimKey(photo.userId, uploadId),
                        photoId: photo.photoId,
                        ...(!keepClaim && { ttl: Math.ceil(Date.now() / 1000) + 7 * 86_400 }),
                      },
                      ConditionExpression: "attribute_not_exists(PK)",
                    },
                  },
                ]
              : []),
            {
              Put: {
                TableName: db.table,
                Item: {
                  ...pendingMarkerKey(photo.uploadedAt, photo.userId, photo.photoId),
                  entity: "pendingMarker",
                  userId: photo.userId,
                  photoId: photo.photoId,
                  uploadedAt: photo.uploadedAt,
                  ttl:
                    Math.ceil(Date.parse(photo.uploadedAt) / 1000) +
                    PENDING_MARKER_TTL_DAYS * 86_400,
                },
              },
            },
          ],
        });
        return record;
      } catch (err) {
        if (conditionFailedAt(err, 1)) return "quota-exceeded";
        if (conditionFailedAt(err, 2)) return "claimed";
        throw err;
      }
    },

    /** The photo an earlier request with this client `uploadId` created, if it still exists. */
    async claimed(userId: string, uploadId: string): Promise<PhotoRecord | null> {
      return (await claimOf(db, userId, uploadId))?.photo ?? null;
    },

    /** The claim itself: which photo it names, and that photo (null once it is deleted). */
    claim: (userId: string, uploadId: string) => claimOf(db, userId, uploadId),

    /**
     * Removes a claim that still names `photoId`, a photo that no longer exists, so the next
     * create can claim the ID again (FR-SHR-10: a deleted saved copy can be saved anew).
     */
    async releaseClaim(userId: string, uploadId: string, photoId: string): Promise<void> {
      try {
        await db.client.send(
          new DeleteCommand({
            TableName: db.table,
            Key: uploadClaimKey(userId, uploadId),
            ConditionExpression: "photoId = :photoId",
            ExpressionAttributeValues: { ":photoId": photoId },
          }),
        );
      } catch (err) {
        // Already released, or claimed again in the meantime.
        if (!isConditionalCheckFailed(err)) throw err;
      }
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
        FilterExpression:
          "attribute_exists(latitude) AND #status = :ready AND attribute_not_exists(trashedAt)",
        ProjectionExpression: "photoId, takenAt, latitude, longitude, placeIds",
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
     * double-counting. Returns the deleted record, or null if it did not exist or `guard` refused
     * it (e.g. "only if still in the trash"); the guard sees every re-read. S3 objects are the
     * caller's job.
     *
     * A trashed photo (FR-DEL-3) has no memberships left, and its places already stopped counting
     * it: their `trashedCount` goes down instead of `photoCount`.
     */
    async delete(
      userId: string,
      photoId: string,
      guard: (record: PhotoRecord) => boolean = () => true,
    ): Promise<PhotoRecord | null> {
      for (let attempt = 0; attempt < 6; attempt++) {
        const record = await getPhoto(db, userId, photoId, true);
        if (!record || !guard(record)) return null;

        for (const albumId of record.albumIds ?? []) {
          await removeMembership(db, userId, albumId, photoId);
        }

        const counted = record.status !== "pending";
        const trashed = record.trashedAt !== undefined;
        try {
          await transactWrite(db, {
            TransactItems: [
              {
                Delete: {
                  TableName: db.table,
                  Key: photoKey(userId, photoId),
                  // Guards against the thumbnail Lambda changing the status (and counting
                  // Usage) between our read and this delete, and against a trash or restore.
                  ConditionExpression: trashed
                    ? "#status = :status AND trashedAt = :trashedAt"
                    : "#status = :status AND attribute_not_exists(trashedAt)",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":status": record.status,
                    ...(trashed && { ":trashedAt": record.trashedAt }),
                  },
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
                    UpdateExpression: trashed
                      ? "ADD trashedCount :minusOne"
                      : "ADD photoCount :minusOne",
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
          });
          await dropEmptyPlaces(db, userId, record.placeIds);
          return record;
        } catch (err) {
          // Status changed or photo deleted concurrently: re-read and try again. (A clash with
          // another delete on Usage or a place, e.g. emptying the trash, is retried inside
          // transactWrite, 13.4.)
          if (!conditionFailedAt(err, 0)) throw err;
        }
      }
      throw new Error(`Photo ${photoId} kept changing while being deleted`);
    },

    /**
     * Moves a photo to the trash (FR-DEL-3, DELETE /photos/{id}). In one transaction the item
     * leaves the gallery (GSI1 → `TRASH`, by purge date) and its place photo items leave GSI1,
     * their places counting it as trashed instead (so a place emptied meanwhile keeps its entry
     * for a restore). Then its album memberships go; `trashedAlbumIds` remembers them. Usage is
     * unchanged: trashed photos still count until purged.
     *
     * Already trashed: finishes leftover membership removals and returns it unchanged, so a retry
     * is safe. Pending uploads aren't trashed (nothing to restore): "pending", the caller deletes
     * them. Null if the photo doesn't exist.
     */
    async trash(
      userId: string,
      photoId: string,
      now: Date,
    ): Promise<PhotoRecord | "pending" | null> {
      for (let attempt = 0; attempt < 3; attempt++) {
        let record = await getPhoto(db, userId, photoId, true);
        if (!record) return null;
        if (record.status === "pending") return "pending";

        if (record.trashedAt === undefined) {
          const trashedAt = now.toISOString();
          const purgeAt = new Date(now.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString();
          const albumIds = record.albumIds?.size ? record.albumIds : undefined;
          try {
            await transactWrite(db, {
              TransactItems: [
                {
                  Update: {
                    TableName: db.table,
                    Key: photoKey(userId, photoId),
                    UpdateExpression:
                      "SET trashedAt = :trashedAt, purgeAt = :purgeAt, GSI1PK = :pk, GSI1SK = :sk" +
                      (albumIds ? ", trashedAlbumIds = :albums" : ""),
                    // Ready or failed as read (the thumbnail Lambda may mark it failed).
                    ConditionExpression: "#status = :status AND attribute_not_exists(trashedAt)",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":trashedAt": trashedAt,
                      ":purgeAt": purgeAt,
                      ":pk": TRASH_PK,
                      ":sk": purgeSk(purgeAt, userId, photoId),
                      ":status": record.status,
                      ...(albumIds && { ":albums": albumIds }),
                    },
                  },
                },
                ...placeMoves(db, userId, photoId, record.placeIds, "trash", record.takenAt),
              ],
            });
          } catch (err) {
            if (conditionFailedAt(err, 0)) continue; // Changed meanwhile: re-read.
            throw err;
          }
          record = {
            ...record,
            trashedAt,
            purgeAt,
            ...(albumIds && { trashedAlbumIds: albumIds }),
          };
        }

        // After the trash mark, so no new membership can be added in between (addMembership).
        for (const albumId of record.albumIds ?? []) {
          await removeMembership(db, userId, albumId, photoId);
        }
        const { albumIds: _, ...rest } = record;
        return rest;
      }
      throw new Error(`Photo ${photoId} kept changing while being trashed`);
    },

    /**
     * Takes a photo out of the trash (FR-DEL-3): back in the gallery and its places, then back in
     * the albums it was in that still exist. Null if it isn't in the trash (or doesn't exist).
     */
    async restore(userId: string, photoId: string, now: Date): Promise<PhotoRecord | null> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const record = await getPhoto(db, userId, photoId, true);
        if (!record?.trashedAt) return null;
        try {
          await transactWrite(db, {
            TransactItems: [
              {
                Update: {
                  TableName: db.table,
                  Key: photoKey(userId, photoId),
                  UpdateExpression:
                    "SET GSI1PK = :pk, GSI1SK = :sk REMOVE trashedAt, purgeAt, trashedAlbumIds",
                  ConditionExpression: "trashedAt = :trashedAt",
                  ExpressionAttributeValues: {
                    ":pk": userPk(userId),
                    ":sk": takenSk(record.takenAt, photoId),
                    ":trashedAt": record.trashedAt,
                  },
                },
              },
              ...placeMoves(db, userId, photoId, record.placeIds, "restore", record.takenAt),
            ],
          });
        } catch (err) {
          if (conditionFailedAt(err, 0)) continue; // Restored or purged meanwhile: re-read.
          throw err;
        }
        // Albums deleted meanwhile, and albums of others that no longer let the user add
        // (FR-SHR-11), are skipped.
        for (const albumId of record.trashedAlbumIds ?? []) {
          await restoreMembership(db, userId, albumId, photoId, now.toISOString());
        }
        const { trashedAt: _t, purgeAt: _p, trashedAlbumIds: _a, ...restored } = record;
        return { ...restored, albumIds: record.trashedAlbumIds };
      }
      throw new Error(`Photo ${photoId} kept changing while being restored`);
    },

    /**
     * The user's trash, most recently deleted first. Reads the whole photo partition (bounded by
     * the quota) like the map; the trash index (`TRASH`) is sorted by purge date for all users.
     */
    async listTrashed(userId: string): Promise<PhotoRecord[]> {
      const items = await queryAll(db, {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        FilterExpression: "attribute_exists(trashedAt)",
        ExpressionAttributeValues: { ":pk": userPk(userId), ":prefix": PHOTO_SK_PREFIX },
      });
      return items
        .map((item) => stripKeys<PhotoRecord>(item))
        .sort(
          (a, b) => b.trashedAt!.localeCompare(a.trashedAt!) || b.photoId.localeCompare(a.photoId),
        );
    },

    /**
     * Pending markers of every user whose upload started before `before`, oldest first (6.11).
     * The photo itself may be ready, failed or deleted by now: the sweep reads it.
     */
    async listPendingMarkers(before: Date): Promise<PendingMarker[]> {
      const items = await queryAll(db, {
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :until",
        ProjectionExpression: "userId, photoId, uploadedAt",
        ExpressionAttributeValues: {
          ":pk": PENDING_PK,
          ":from": "UPLOADED#",
          // Strictly before: a marker at exactly `before` continues with "#…", so it sorts after.
          ":until": `UPLOADED#${before.toISOString()}`,
        },
      });
      return items.map((item) => ({
        userId: item.userId as string,
        photoId: item.photoId as string,
        uploadedAt: item.uploadedAt as string,
      }));
    },

    /** Removes a pending marker once the sweep has dealt with its photo (6.11). */
    async deletePendingMarker({ uploadedAt, userId, photoId }: PendingMarker): Promise<void> {
      await db.client.send(
        new DeleteCommand({
          TableName: db.table,
          Key: pendingMarkerKey(uploadedAt, userId, photoId),
        }),
      );
    },

    /** Trashed photos of every user whose `purgeAt` has passed, oldest first (daily purge). */
    async listExpired(now: Date): Promise<ExpiredPhoto[]> {
      const items = await queryAll(db, {
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK BETWEEN :from AND :until",
        ProjectionExpression: "userId, photoId",
        ExpressionAttributeValues: {
          ":pk": TRASH_PK,
          ":from": "PURGE#",
          // "~" sorts after every character of the user and photo IDs that follow the date.
          ":until": `PURGE#${now.toISOString()}~`,
        },
      });
      return items.map((item) => ({
        userId: item.userId as string,
        photoId: item.photoId as string,
      }));
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trash / restore writes for a photo's place items (FR-DEL-3, 13.2c): its place photo items leave
 * GSI1 (or come back, sorted by takenAt), and each place moves one photo between `photoCount` and
 * `trashedCount`. The place lists hide places without counted photos; the purge drops a place only
 * once both counts are 0 (`dropEmptyPlaces`).
 */
function placeMoves(
  db: Db,
  userId: string,
  photoId: string,
  placeIds: Set<string> | undefined,
  direction: "trash" | "restore",
  takenAt: string,
) {
  const sign = direction === "trash" ? -1 : 1;
  return [...(placeIds ?? [])].flatMap((placeId) => [
    {
      Update: {
        TableName: db.table,
        Key: placePhotoKey(userId, placeId, photoId),
        ...(direction === "trash"
          ? { UpdateExpression: "REMOVE GSI1PK, GSI1SK" }
          : {
              UpdateExpression: "SET GSI1PK = :pk, GSI1SK = :sk",
              ExpressionAttributeValues: {
                ":pk": placePhotosPk(userId, placeId),
                ":sk": takenSk(takenAt, photoId),
              },
            }),
        // No stub items for a place photo item that is missing.
        ConditionExpression: "attribute_exists(PK)",
      },
    },
    {
      Update: {
        TableName: db.table,
        Key: placeKey(userId, placeId),
        UpdateExpression: "ADD photoCount :counted, trashedCount :trashed",
        ExpressionAttributeValues: { ":counted": sign, ":trashed": -sign },
      },
    },
  ]);
}

async function claimOf(
  db: Db,
  userId: string,
  uploadId: string,
): Promise<{ photoId: string; photo: PhotoRecord | null } | null> {
  // Consistent: a "claimed" answer from createPending must find the winner's claim.
  const claim = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: uploadClaimKey(userId, uploadId),
      ConsistentRead: true,
    }),
  );
  const photoId: unknown = claim.Item?.photoId;
  if (typeof photoId !== "string") return null;
  return { photoId, photo: await getPhoto(db, userId, photoId, true) };
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

/**
 * Removes place list entries left without photos, counted or trashed; one that gained a photo
 * meanwhile stays.
 */
async function dropEmptyPlaces(db: Db, userId: string, placeIds: Set<string> | undefined) {
  for (const placeId of placeIds ?? []) {
    try {
      await db.client.send(
        new DeleteCommand({
          TableName: db.table,
          Key: placeKey(userId, placeId),
          // Trashed photos still need it for a restore (FR-DEL-3).
          ConditionExpression:
            "photoCount <= :zero AND (attribute_not_exists(trashedCount) OR trashedCount <= :zero)",
          ExpressionAttributeValues: { ":zero": 0 },
        }),
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }
}
