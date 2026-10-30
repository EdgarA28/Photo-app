import {
  isAccepted,
  photoOwnerOf,
  type AlbumRecord,
  type PhotoRecord,
  type Repositories,
} from "../repo";

/**
 * "Can user X see …?" for shared albums (spec §8.2, 5.13). Everything other users own is reached
 * only through a share item addressed to the caller, so without one the answer is "not found",
 * exactly like for missing items (NFR-SEC-2), and only once the caller accepted it: an invitation
 * gives no access (FR-SHR-6). Share reads are consistent: a revoked or left share stops working
 * straight away (FR-SHR-2, FR-SHR-7).
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
 * A photo the caller can see because it is in `albumId`, which is theirs or shared with them
 * (accepted). The photo may belong to the album's owner or to a member who added it (FR-SHR-9):
 * it is looked up under the owner the membership names, so only a photo that really is in the
 * album can come back. Other people's photos are visible only once `ready`: uploads in progress
 * and failed ones are their owner's business, and have no images to show anyway.
 */
export async function albumPhoto(
  repos: Repositories,
  userId: string,
  albumId: string,
  photoId: string,
): Promise<PhotoRecord | null> {
  if (!(await albumAccess(repos, userId, albumId))) return null;
  const membership = await repos.albums.getMembership(albumId, photoId);
  if (!membership) return null;
  const photo = await repos.photos.get(photoOwnerOf(membership), photoId);
  if (!photo) return null;
  return photo.userId === userId || isVisibleToRecipient(photo) ? photo : null;
}

export const isVisibleToRecipient = (photo: PhotoRecord) => photo.status === "ready";
