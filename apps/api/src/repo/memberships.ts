import { DeleteCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  conditionFailedAt,
  isConditionalCheckFailed,
  queryAll,
  transactWrite,
  type Db,
} from "./db";
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
 * Collaborative albums (FR-SHR-11): a membership's `ownerId` is the **photo's** owner, whose
 * partition holds the photo. When a member added it, `albumOwnerId` names the album's owner (whose
 * partition holds the album and its count); absent, both are the same user.
 */

/** Tries for an add whose photo got a new takenAt in between (processing just finished). */
const ADD_ATTEMPTS = 3;

export type AddResult =
  | "added"
  | "already-member"
  | "photo-not-found"
  | "album-not-found"
  /** A member's add, but the owner turned "Members can add photos" off or the share is gone. */
  | "not-allowed";

export interface MembershipRecord {
  albumId: string;
  photoId: string;
  /** The photo's owner. */
  ownerId: string;
  /** The album's owner, when not the photo's (FR-SHR-11). */
  albumOwnerId?: string;
  addedAt: string;
}

/** Whose album this membership is in. */
export const albumOwnerOf = (membership: MembershipRecord) =>
  membership.albumOwnerId ?? membership.ownerId;

/**
 * Adds `photoOwnerId`'s photo to `albumOwnerId`'s album. For a member's photo (the two differ) the
 * same transaction checks that the album lets members add and that the member's share is still
 * accepted, so a revoke or a switch turned off at the same moment can't let a photo slip in.
 */
export async function addMembership(
  db: Db,
  owners: { photoOwnerId: string; albumOwnerId: string },
  albumId: string,
  photoId: string,
  addedAt: string,
): Promise<AddResult> {
  for (let attempt = 1; ; attempt++) {
    const photo = await db.client.send(
      new GetCommand({
        TableName: db.table,
        Key: photoKey(owners.photoOwnerId, photoId),
        ProjectionExpression: "takenAt, trashedAt",
        ConsistentRead: true,
      }),
    );
    const takenAt = photo.Item?.takenAt as string | undefined;
    // A photo in the trash is in no album (FR-DEL-3).
    if (!takenAt || photo.Item?.trashedAt) return "photo-not-found";
    const result = await addWithTakenAt(db, owners, albumId, photoId, addedAt, takenAt);
    if (result !== "taken-at-changed") return result;
    if (attempt === ADD_ATTEMPTS) throw new Error(`Photo ${photoId} kept changing while adding it`);
  }
}

async function addWithTakenAt(
  db: Db,
  { photoOwnerId, albumOwnerId }: { photoOwnerId: string; albumOwnerId: string },
  albumId: string,
  photoId: string,
  addedAt: string,
  takenAt: string,
): Promise<AddResult | "taken-at-changed"> {
  const byMember = photoOwnerId !== albumOwnerId;
  try {
    await transactWrite(db, {
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
              ownerId: photoOwnerId,
              ...(byMember && { albumOwnerId }),
              addedAt,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...(byMember
          ? [
              {
                ConditionCheck: {
                  TableName: db.table,
                  Key: shareKey(albumId, photoOwnerId),
                  // Accepted (shares from before invitations have no status, FR-SHR-6).
                  ConditionExpression:
                    "attribute_exists(PK) AND ownerId = :albumOwner AND " +
                    "(attribute_not_exists(#status) OR #status <> :pending)",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":albumOwner": albumOwnerId,
                    ":pending": "pending",
                  },
                },
              },
            ]
          : []),
      ],
    });
    return "added";
  } catch (err) {
    if (conditionFailedAt(err, 0)) {
      if (!byMember) return "album-not-found";
      const album = await db.client.send(
        new GetCommand({
          TableName: db.table,
          Key: albumKey(albumOwnerId, albumId),
          ProjectionExpression: "PK",
        }),
      );
      return album.Item ? "not-allowed" : "album-not-found";
    }
    // The photo is gone or trashed, or the thumbnail Lambda changed its takenAt since it was read.
    if (conditionFailedAt(err, 1)) return "taken-at-changed";
    if (conditionFailedAt(err, 2)) return "already-member";
    if (conditionFailedAt(err, 3)) return "not-allowed";
    throw err;
  }
}

/**
 * Puts a photo back into an album it was in before going to the trash (FR-DEL-3): the user's own
 * album, or one they are a member of (FR-SHR-11), found through their share. Results as for
 * `addMembership`; an album gone, or no longer open to them, is skipped by the caller.
 */
export async function restoreMembership(
  db: Db,
  userId: string,
  albumId: string,
  photoId: string,
  addedAt: string,
): Promise<AddResult> {
  const own = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: albumKey(userId, albumId),
      ProjectionExpression: "PK",
    }),
  );
  if (own.Item) {
    return addMembership(
      db,
      { photoOwnerId: userId, albumOwnerId: userId },
      albumId,
      photoId,
      addedAt,
    );
  }
  const share = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: shareKey(albumId, userId),
      ProjectionExpression: "ownerId",
    }),
  );
  const albumOwnerId = share.Item?.ownerId as string | undefined;
  if (!albumOwnerId) return "album-not-found";
  // The transaction checks the share is accepted and the album still lets members add.
  return addMembership(db, { photoOwnerId: userId, albumOwnerId }, albumId, photoId, addedAt);
}

export async function getMembership(
  db: Db,
  albumId: string,
  photoId: string,
): Promise<MembershipRecord | null> {
  const output = await db.client.send(
    new GetCommand({
      TableName: db.table,
      Key: membershipKey(albumId, photoId),
      ConsistentRead: true,
    }),
  );
  if (!output.Item) return null;
  const { albumId: a, photoId: p, ownerId, albumOwnerId, addedAt } = output.Item;
  return {
    albumId: a as string,
    photoId: p as string,
    ownerId: ownerId as string,
    ...(typeof albumOwnerId === "string" && { albumOwnerId }),
    addedAt: addedAt as string,
  };
}

/**
 * Removes `photoOwnerId`'s photo from an album, whoever owns the album (the membership says).
 * Returns false if that user's photo was not in the album. Clears the album cover if it was this
 * photo. Not an access check: callers decide who may remove what (FR-ALB-2, FR-SHR-11).
 */
export async function removeMembership(
  db: Db,
  photoOwnerId: string,
  albumId: string,
  photoId: string,
): Promise<boolean> {
  const membership = await getMembership(db, albumId, photoId);
  if (!membership || membership.ownerId !== photoOwnerId) return false;
  const albumOwnerId = albumOwnerOf(membership);

  // The condition also catches a membership replaced since it was read.
  const deleteMembership = {
    Delete: {
      TableName: db.table,
      Key: membershipKey(albumId, photoId),
      ConditionExpression: "ownerId = :owner",
      ExpressionAttributeValues: { ":owner": photoOwnerId },
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
    await transactWrite(db, { TransactItems: [deleteMembership, decrementAlbum, unlinkPhoto] });
  } catch (err) {
    if (conditionFailedAt(err, 0)) return false;
    if (conditionFailedAt(err, 1) || conditionFailedAt(err, 2)) {
      // Album or photo already gone: still remove the membership and whatever else exists.
      return removeMembershipLeniently(db, photoOwnerId, albumOwnerId, albumId, photoId);
    }
    throw err;
  }
  await clearCover(db, albumOwnerId, albumId, photoId);
  return true;
}

/**
 * Takes all photos `memberId` added out of the album (FR-SHR-11: they left, or the owner removed
 * them). Reads the album's memberships (bounded by the album size). Safe to repeat.
 */
export async function removeMemberPhotos(
  db: Db,
  albumId: string,
  memberId: string,
): Promise<number> {
  const items = await queryAll(db, {
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :photo)",
    // Only photos a member added: never the album owner's own (an owner "leaving" their album).
    FilterExpression: "ownerId = :member AND attribute_exists(albumOwnerId)",
    ExpressionAttributeValues: { ":pk": albumPk(albumId), ":photo": "PHOTO#", ":member": memberId },
    ProjectionExpression: "photoId",
  });
  let removed = 0;
  for (const item of items) {
    if (await removeMembership(db, memberId, albumId, item.photoId as string)) removed++;
  }
  return removed;
}

async function removeMembershipLeniently(
  db: Db,
  photoOwnerId: string,
  albumOwnerId: string,
  albumId: string,
  photoId: string,
): Promise<boolean> {
  try {
    await db.client.send(
      new DeleteCommand({
        TableName: db.table,
        Key: membershipKey(albumId, photoId),
        ConditionExpression: "ownerId = :owner",
        ExpressionAttributeValues: { ":owner": photoOwnerId },
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

async function clearCover(db: Db, albumOwnerId: string, albumId: string, photoId: string) {
  try {
    await db.client.send(
      new UpdateCommand({
        TableName: db.table,
        Key: albumKey(albumOwnerId, albumId),
        UpdateExpression: "REMOVE coverPhotoId, coverOwnerId",
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
