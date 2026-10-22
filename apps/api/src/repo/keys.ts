/**
 * Single-table key layout (spec §8.2, ARCHITECTURE.md §8.2). The only place that formats
 * PK/SK/GSI values; repositories never build key strings themselves.
 */

export const userPk = (userId: string) => `USER#${userId}`;
export const albumPk = (albumId: string) => `ALBUM#${albumId}`;
export const usernamePk = (username: string) => `USERNAME#${username}`;

export const photoSk = (photoId: string) => `PHOTO#${photoId}`;
export const albumSk = (albumId: string) => `ALBUM#${albumId}`;
export const shareSk = (userId: string) => `SHARE#${userId}`;
export const USAGE_SK = "USAGE";
export const PROFILE_SK = "PROFILE";
export const USERNAME_SK = "USERNAME";

export const PHOTO_SK_PREFIX = "PHOTO#";
export const ALBUM_SK_PREFIX = "ALBUM#";
export const SHARE_SK_PREFIX = "SHARE#";

/** GSI1 sort key of a photo: gallery order by date taken, ties broken by ID (FR-GAL-1). */
export const takenSk = (takenAt: string, photoId: string) => `TAKEN#${takenAt}#${photoId}`;
export const sharedWithPk = (userId: string) => `SHAREDWITH#${userId}`;

export const photoKey = (userId: string, photoId: string) => ({
  PK: userPk(userId),
  SK: photoSk(photoId),
});
export const albumKey = (userId: string, albumId: string) => ({
  PK: userPk(userId),
  SK: albumSk(albumId),
});
export const membershipKey = (albumId: string, photoId: string) => ({
  PK: albumPk(albumId),
  SK: photoSk(photoId),
});
export const shareKey = (albumId: string, userId: string) => ({
  PK: albumPk(albumId),
  SK: shareSk(userId),
});
export const usageKey = (userId: string) => ({ PK: userPk(userId), SK: USAGE_SK });
export const profileKey = (userId: string) => ({ PK: userPk(userId), SK: PROFILE_SK });
/** One item per username: the key itself makes names unique (FR-ACC-3). */
export const usernameKey = (username: string) => ({ PK: usernamePk(username), SK: USERNAME_SK });

/** Key attributes of the table and its index, used to build pagination cursors. */
export const TABLE_KEY_ATTRIBUTES = ["PK", "SK"] as const;
export const GSI1 = "GSI1";
export const GSI1_KEY_ATTRIBUTES = ["GSI1PK", "GSI1SK", "PK", "SK"] as const;

/** Attributes that exist only for indexing and never leave the repository layer. */
export const KEY_ATTRIBUTES = ["PK", "SK", "GSI1PK", "GSI1SK", "entity"] as const;
