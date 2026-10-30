import {
  DeleteCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { conditionFailedAt, isConditionalCheckFailed, type Db } from "./db";
import { albumKey, albumPk, membershipKey, photoKey, shareKey, takenSk } from "./keys";

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
 *
 * The album and the photo usually belong to the same user. In a shared album that lets members
 * add photos (FR-SHR-9), a member's photo stays theirs (their partition, their quota): the
 * membership keeps the album's owner in `ownerId` and the photo's in `photoOwnerId` (absent on
 * memberships from before FR-SHR-9 = the album's owner). Either of the two may remove it.
 */

/** Tries for an add whose photo got a new takenAt in between (processing just finished). */
const ADD_ATTEMPTS = 3;

export type AddResult = "added" | "already-member" | "photo-not-found" | "album-not-found";

/**
 * Adds `photoOwnerId`'s photo to `userId`'s album. For a member's photo (`photoOwnerId` is not the
 * album's owner) the same transaction checks that the album lets members add photos and that the
 * member's share is accepted (FR-SHR-9); otherwise the result is "album-not-found".
 */
export async function addMembership(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
  addedAt: string,
  photoOwnerId: string = userId,
): Promise<AddResult> {
  for (let attempt = 1; ; attempt++) {
    const photo = await db.client.send(
      new GetCommand({
        TableName: db.table,
        Key: photoKey(photoOwnerId, photoId),
        ProjectionExpression: "takenAt, trashedAt",
        ConsistentRead: true,
      }),
    );
    const takenAt = photo.Item?.takenAt as string | undefined;
    // A photo in the trash is in no album (FR-DEL-3).
    if (!takenAt || photo.Item?.trashedAt) return "photo-not-found";
    const result = await addWithTakenAt(
      db,
      { albumOwnerId: userId, photoOwnerId },
      albumId,
      photoId,
      addedAt,
      takenAt,
    );
    if (result !== "taken-at-changed") return result;
    if (attempt === ADD_ATTEMPTS) throw new Error(`Photo ${photoId} kept changing while adding it`);
  }
}

async function addWithTakenAt(
  db: Db,
  { albumOwnerId, photoOwnerId }: { albumOwnerId: string; photoOwnerId: string },
  albumId: string,
  photoId: string,
  addedAt: string,
  takenAt: string,
): Promise<AddResult | "taken-at-changed"> {
  const byMember = photoOwnerId !== albumOwnerId;
  try {
    await db.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.table,
              Key: albumKey(albumOwnerId, albumId),
              UpdateExpression: "ADD photoCount :one",
              ConditionExpression: byMember
                ? "attribute_exists(PK) AND membersCanAdd = :true"
                : "attribute_exists(PK)",
              ExpressionAttributeValues: { ":one": 1, ...(byMember && { ":true": true }) },
            },
          },
          {
            Update: {
              TableName: db.table,
              Key: photoKey(photoOwnerId, photoId),
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
                ownerId: albumOwnerId,
                photoOwnerId,
                addedAt,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          // A member adds only through a share they accepted (FR-SHR-6, FR-SHR-9).
          ...(byMember
            ? [
                {
                  ConditionCheck: {
                    TableName: db.table,
                    Key: shareKey(albumId, photoOwnerId),
                    ConditionExpression:
                      "attribute_exists(PK) AND (attribute_not_exists(#status) OR #status = :accepted)",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: { ":accepted": "accepted" },
                  },
                },
              ]
            : []),
        ],
      }),
    );
    return "added";
  } catch (err) {
    if (conditionFailedAt(err, 0) || conditionFailedAt(err, 3)) return "album-not-found";
    // The photo is gone or trashed, or the thumbnail Lambda changed its takenAt since it was read.
    if (conditionFailedAt(err, 1)) return "taken-at-changed";
    if (conditionFailedAt(err, 2)) return "already-member";
    throw err;
  }
}

/**
 * Takes a photo out of an album. `userId` must be the album's owner or the photo's (a member
 * removing their own photo, FR-SHR-9); returns false otherwise, or if the photo was not in the
 * album. Clears the album cover if it was this photo.
 */
export async function removeMembership(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
): Promise<boolean> {
  const membership = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: membershipKey(albumId, photoId),
      ProjectionExpression: "ownerId, photoOwnerId",
      ConsistentRead: true,
    }),
  );
  if (!membership.Item) return false;
  const albumOwnerId = membership.Item.ownerId as string;
  const photoOwnerId = (membership.Item.photoOwnerId as string | undefined) ?? albumOwnerId;
  // Membership keys carry no user, so this check is what stops anyone else removing photos.
  if (userId !== albumOwnerId && userId !== photoOwnerId) return false;
  const owners = { albumOwnerId, photoOwnerId };

  const deleteMembership = {
    Delete: {
      TableName: db.table,
      Key: membershipKey(albumId, photoId),
      ConditionExpression: "ownerId = :owner",
      ExpressionAttributeValues: { ":owner": albumOwnerId },
    },
  };
  const decrementAlbum = {
    Update: {
      TableName: db.table,
      Key: albumKey(albumOwnerId, albumId),
      UpdateExpression: "ADD photoCount :minusOne",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":minusOne": -1 },
    },
  };
  const unlinkPhoto = {
    Update: {
      TableName: db.table,
      Key: photoKey(photoOwnerId, photoId),
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
      return removeMembershipLeniently(db, owners, albumId, photoId);
    }
    throw err;
  }
  await clearCover(db, albumOwnerId, albumId, photoId);
  return true;
}

async function removeMembershipLeniently(
  db: Db,
  { albumOwnerId, photoOwnerId }: { albumOwnerId: string; photoOwnerId: string },
  albumId: string,
  photoId: string,
): Promise<boolean> {
  try {
    await db.client.send(
      new DeleteCommand({
        TableName: db.table,
        Key: membershipKey(albumId, photoId),
        ConditionExpression: "ownerId = :owner",
        ExpressionAttributeValues: { ":owner": albumOwnerId },
      }),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) return false;
    throw err;
  }
  for (const update of [
    {
      Key: albumKey(albumOwnerId, albumId),
      UpdateExpression: "ADD photoCount :v",
      ExpressionAttributeValues: { ":v": -1 },
    },
    {
      Key: photoKey(photoOwnerId, photoId),
      UpdateExpression: "DELETE albumIds :v",
      ExpressionAttributeValues: { ":v": new Set([albumId]) },
    },
  ]) {
    await updateIfExists(db, update);
  }
  await clearCover(db, albumOwnerId, albumId, photoId);
  return true;
}

/**
 * Whose album `albumId` is, seen from `userId`: theirs, or the owner named by their share of it
 * (FR-SHR-9; whether the share still lets them add is checked when adding). Null if neither.
 */
export async function albumOwnerFor(
  db: Db,
  userId: string,
  albumId: string,
): Promise<string | null> {
  const own = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: albumKey(userId, albumId),
      ProjectionExpression: "PK",
    }),
  );
  if (own.Item) return userId;
  const share = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: shareKey(albumId, userId),
      ProjectionExpression: "ownerId",
    }),
  );
  return (share.Item?.ownerId as string | undefined) ?? null;
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
