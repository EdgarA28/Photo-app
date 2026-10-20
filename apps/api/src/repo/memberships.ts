import { DeleteCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { conditionFailedAt, isConditionalCheckFailed, type Db } from "./db";
import { albumKey, membershipKey, photoKey } from "./keys";

/**
 * Album membership (spec §8.2): item `ALBUM#{albumId}` / `PHOTO#{photoId}`, mirrored on the photo
 * as `albumIds` (string set) so "which albums contain this photo" needs no extra index.
 *
 * Each change is one transaction over membership + photo + album count, guarded by conditions,
 * so retries and duplicates never double-count.
 */

export type AddResult = "added" | "already-member" | "photo-not-found" | "album-not-found";

export async function addMembership(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
  addedAt: string,
): Promise<AddResult> {
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
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: { ":album": new Set([albumId]) },
            },
          },
          {
            Put: {
              TableName: db.table,
              Item: {
                ...membershipKey(albumId, photoId),
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
    if (conditionFailedAt(err, 1)) return "photo-not-found";
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
