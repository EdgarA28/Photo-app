import {
  DeleteCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { conditionFailedAt, isConditionalCheckFailed, type Db } from "./db";
import { albumKey, albumPk, membershipKey, photoKey, takenSk } from "./keys";

/**
 * Album membership (spec §8.2): item `ALBUM#{albumId}` / `PHOTO#{photoId}`, mirrored on the photo
 * as `albumIds` (string set) so "which albums contain this photo" needs no extra index.
 *
 * Each change is one transaction over membership + photo + album count, guarded by conditions,
 * so retries and duplicates never double-count.
 *
 * Memberships are also in GSI1 under `ALBUM#{albumId}`, sorted like the gallery by the photo's
 * date taken (`TAKEN#{takenAt}#{photoId}`), so albums list by date taken too (§12.3). The thumbnail
 * Lambda moves them when processing replaces the provisional takenAt (§10).
 */

/** Tries for an add whose photo got a new takenAt in between (processing just finished). */
const ADD_ATTEMPTS = 3;

export type AddResult = "added" | "already-member" | "photo-not-found" | "album-not-found";

export async function addMembership(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
  addedAt: string,
): Promise<AddResult> {
  for (let attempt = 1; ; attempt++) {
    const photo = await db.client.send(
      new GetCommand({
        TableName: db.table,
        Key: photoKey(userId, photoId),
        ProjectionExpression: "takenAt, trashedAt",
        ConsistentRead: true,
      }),
    );
    const takenAt = photo.Item?.takenAt as string | undefined;
    // A photo in the trash is in no album (FR-DEL-3).
    if (!takenAt || photo.Item?.trashedAt) return "photo-not-found";
    const result = await addWithTakenAt(db, userId, albumId, photoId, addedAt, takenAt);
    if (result !== "taken-at-changed") return result;
    if (attempt === ADD_ATTEMPTS) throw new Error(`Photo ${photoId} kept changing while adding it`);
  }
}

async function addWithTakenAt(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
  addedAt: string,
  takenAt: string,
): Promise<AddResult | "taken-at-changed"> {
  try {
    await db.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.table,
              Key: albumKey(userId, albumId),
              UpdateExpression: "ADD photoCount :one",
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: { ":one": 1 },
            },
          },
          {
            Update: {
              TableName: db.table,
              Key: photoKey(userId, photoId),
              UpdateExpression: "ADD albumIds :album",
              // The membership's sort key below must match the photo's current takenAt, and the
              // photo must not have gone to the trash since it was read.
              ConditionExpression:
                "attribute_exists(PK) AND takenAt = :takenAt AND attribute_not_exists(trashedAt)",
              ExpressionAttributeValues: { ":album": new Set([albumId]), ":takenAt": takenAt },
            },
          },
          {
            Put: {
              TableName: db.table,
              Item: {
                ...membershipKey(albumId, photoId),
                GSI1PK: albumPk(albumId),
                GSI1SK: takenSk(takenAt, photoId),
                entity: "membership",
                albumId,
                photoId,
                ownerId: userId,
                addedAt,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
    return "added";
  } catch (err) {
    if (conditionFailedAt(err, 0)) return "album-not-found";
    // The photo is gone or trashed, or the thumbnail Lambda changed its takenAt since it was read.
    if (conditionFailedAt(err, 1)) return "taken-at-changed";
    if (conditionFailedAt(err, 2)) return "already-member";
    throw err;
  }
}

/**
 * Returns false if the photo was not in the album or the album isn't the caller's. Clears the
 * album cover if it was this photo.
 */
export async function removeMembership(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
): Promise<boolean> {
  // Membership keys carry no user, so the owner check is what stops another user removing
  // photos from an album that isn't theirs.
  const deleteMembership = {
    Delete: {
      TableName: db.table,
      Key: membershipKey(albumId, photoId),
      ConditionExpression: "ownerId = :owner",
      ExpressionAttributeValues: { ":owner": userId },
    },
  };
  const decrementAlbum = {
    Update: {
      TableName: db.table,
      Key: albumKey(userId, albumId),
      UpdateExpression: "ADD photoCount :minusOne",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":minusOne": -1 },
    },
  };
  const unlinkPhoto = {
    Update: {
      TableName: db.table,
      Key: photoKey(userId, photoId),
      UpdateExpression: "DELETE albumIds :album",
      // Without the condition, UpdateItem would create a stub item for a missing photo.
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":album": new Set([albumId]) },
    },
  };

  try {
    await db.client.send(
      new TransactWriteCommand({ TransactItems: [deleteMembership, decrementAlbum, unlinkPhoto] }),
    );
  } catch (err) {
    if (conditionFailedAt(err, 0)) return false;
    if (conditionFailedAt(err, 1) || conditionFailedAt(err, 2)) {
      // Album or photo already gone: still remove the membership and whatever else exists.
      return removeMembershipLeniently(db, userId, albumId, photoId);
    }
    throw err;
  }
  await clearCover(db, userId, albumId, photoId);
  return true;
}

async function removeMembershipLeniently(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
): Promise<boolean> {
  try {
    await db.client.send(
      new DeleteCommand({
        TableName: db.table,
        Key: membershipKey(albumId, photoId),
        ConditionExpression: "ownerId = :owner",
        ExpressionAttributeValues: { ":owner": userId },
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
  for (const update of [
    {
      Key: albumKey(userId, albumId),
      UpdateExpression: "ADD photoCount :v",
      ExpressionAttributeValues: { ":v": -1 },
    },
    {
      Key: photoKey(userId, photoId),
      UpdateExpression: "DELETE albumIds :v",
      ExpressionAttributeValues: { ":v": new Set([albumId]) },
    },
  ]) {
    await updateIfExists(db, update);
  }
  await clearCover(db, userId, albumId, photoId);
  return true;
}

async function clearCover(db: Db, userId: string, albumId: string, photoId: string) {
  try {
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        Key: albumKey(userId, albumId),
        UpdateExpression: "REMOVE coverPhotoId",
        ConditionExpression: "coverPhotoId = :photoId",
        ExpressionAttributeValues: { ":photoId": photoId },
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err; // Cover is another photo, or none.
  }
}

async function updateIfExists(
  db: Db,
  update: {
    Key: Record<string, string>;
    UpdateExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  },
) {
  try {
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        ...update,
        ConditionExpression: "attribute_exists(PK)",
      }),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err;
  }
}
