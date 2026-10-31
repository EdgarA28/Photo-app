import {
  isAccepted,
  type AlbumRecord,
  type MembershipRecord,
  type PhotoRecord,
  type Repositories,
} from "../repo";

/**
 * "Can user X see …?" for shared albums (spec §8.2, 5.13). Everything other users own is reached
 * only through an album the caller owns or a share item addressed to the caller, so without one
 * the answer is "not found", exactly like for missing items (NFR-SEC-2), and only once the caller
 * accepted it: an invitation gives no access (FR-SHR-6). Share reads are consistent: a revoked or
 * left share stops working straight away (FR-SHR-2, FR-SHR-7).
 *
 * Collaborative albums (FR-SHR-11): an album can hold photos of several people. Each membership
 * says whose photo it is; a photo of someone other than the album owner counts only while that
 * person still holds an accepted share (their photos are also taken out when they leave, but this
 * check doesn't depend on that cleanup having finished).
 */

export type AlbumAccess = { album: AlbumRecord; shared: boolean };

/** The caller's own album, or an album shared with them; null otherwise. */
export async function albumAccess(
  repos: Repositories,
  userId: string,
  albumId: string,
): Promise<AlbumAccess | null> {
  const own = await repos.albums.get(userId, albumId);
  if (own) return { album: own, shared: false };
  const share = await repos.shares.get(albumId, userId);
  if (!share || !isAccepted(share)) return null;
  const album = await repos.albums.get(share.ownerId, albumId);
  return album ? { album, shared: true } : null;
}

/**
 * Of these photo owners in `album`, the ones whose photos count: the album owner, and members
 * with an accepted share (FR-SHR-11). One consistent share read per other owner.
 */
export async function activeContributors(
  repos: Repositories,
  album: AlbumRecord,
  ownerIds: Iterable<string>,
): Promise<Set<string>> {
  const others = [...new Set(ownerIds)].filter((id) => id !== album.ownerId);
  const shares = await Promise.all(others.map((id) => repos.shares.get(album.albumId, id)));
  return new Set([
    album.ownerId,
    ...others.filter((_, i) => {
      const share = shares[i];
      return (
        share !== null &&
        share !== undefined &&
        isAccepted(share) &&
        share.ownerId === album.ownerId
      );
    }),
  ]);
}

/** Whose partition a membership's photo is in. */
export const photoOwnerOf = (membership: MembershipRecord) => membership.ownerId;

/**
 * A photo of someone else that the caller can see because it is in `albumId`, an album they own
 * or that is shared with them. Others' photos are only visible once processed. Null for the
 * caller's own photos too: those are looked up directly.
 */
export async function albumPhoto(
  repos: Repositories,
  userId: string,
  albumId: string,
  photoId: string,
): Promise<PhotoRecord | null> {
  const access = await albumAccess(repos, userId, albumId);
  if (!access) return null;
  const membership = await repos.albums.getMembership(albumId, photoId);
  if (!membership) return null;
  const ownerId = photoOwnerOf(membership);
  if (ownerId === userId) return null;
  const active = await activeContributors(repos, access.album, [ownerId]);
  if (!active.has(ownerId)) return null;
  // Looked up under the owner named by the membership of an album the caller can see.
  const photo = await repos.photos.get(ownerId, photoId);
  return photo && isVisibleToOthers(photo) ? photo : null;
}

/**
 * Other people only see `ready` photos: uploads in progress and failed ones are the owner's
 * business, and have no images to show anyway.
 */
export const isVisibleToOthers = (photo: PhotoRecord) =>
  photo.status === "ready" && photo.trashedAt === undefined;
