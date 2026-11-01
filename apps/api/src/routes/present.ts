import {
  MAP_COORDINATE_DECIMALS,
  previewKey,
  thumbKey,
  type Album,
  type Photo,
  type PhotoLocation,
  type SharedAlbum,
} from "@photo-app/shared";
import type { MediaSigner } from "../lib/media";
import type { AlbumRecord, LocatedPhoto, PhotoRecord, ShareRecord } from "../repo";

/**
 * Repository records → API objects (§9). Own images use stable CloudFront paths under
 * `/users/{sub}/`, authorised by the caller's media cookie (7.3). Photos from albums shared with
 * the caller get signed URLs instead (7.4): `toSharedPhoto` / `toSharedAlbum`, never `toPhoto`.
 */
export function toPhoto(record: PhotoRecord): Photo {
  const ready = record.status === "ready";
  return {
    photoId: record.photoId,
    status: record.status,
    fileName: record.fileName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    width: record.width ?? null,
    height: record.height ?? null,
    takenAt: record.takenAt,
    uploadedAt: record.uploadedAt,
    place: record.place
      ? {
          city: record.place.city,
          region: record.place.region ?? null,
          country: record.place.country,
        }
      : null,
    // Derived images exist only once the thumbnail Lambda is done (FR-GAL-5).
    thumbUrl: ready ? `/${thumbKey(record.userId, record.photoId)}` : null,
    previewUrl: ready ? `/${previewKey(record.userId, record.photoId)}` : null,
    trashedAt: record.trashedAt ?? null,
    purgeAt: record.purgeAt ?? null,
    ownerId: record.userId,
    ownerUsername: null,
  };
}

/**
 * A map pin for the owner (13.2h). Coordinates are rounded to about 100 m (FR-SRCH-5): enough for
 * pins and clusters, less exact than the original's EXIF. `placeId` is the photo's town, so the
 * viewer opened from the map walks that town's photos, like a place search.
 */
export function toPhotoLocation(userId: string, record: LocatedPhoto): PhotoLocation {
  const factor = 10 ** MAP_COORDINATE_DECIMALS;
  const round = (degrees: number) => Math.round(degrees * factor) / factor;
  return {
    photoId: record.photoId,
    lat: round(record.latitude),
    lon: round(record.longitude),
    takenAt: record.takenAt,
    thumbUrl: `/${thumbKey(userId, record.photoId)}`,
    placeId: [...(record.placeIds ?? [])].find((id) => id.startsWith("city:")) ?? null,
  };
}

/** `coverThumbUrl`: from `coverThumbUrl()` below, null without a cover. */
export function toAlbum(record: AlbumRecord, coverThumbUrl: string | null): Album {
  return {
    albumId: record.albumId,
    name: record.name,
    createdAt: record.createdAt,
    coverPhotoId: record.coverPhotoId ?? null,
    coverThumbUrl,
    photoCount: Math.max(0, record.photoCount),
    membersCanAdd: record.membersCanAdd === true,
    showLocations: record.showLocations === true,
  };
}

/**
 * The thumbnail URL of an album's cover for `viewerId`: their own photo by its stable path (media
 * cookie), anyone else's (a member's photo in a collaborative album, FR-SHR-11, or the owner's
 * for a recipient) signed, and only once processed. Null without a cover.
 */
export async function coverThumbUrl(
  cover: PhotoRecord | null | undefined,
  viewerId: string,
  media: MediaSigner,
  now: Date,
): Promise<string | null> {
  if (!cover) return null;
  const thumb = toPhoto(cover).thumbUrl;
  if (cover.userId === viewerId) return thumb;
  if (cover.status !== "ready" || cover.trashedAt !== undefined || !thumb) return null;
  return media.signUrl(thumb, now);
}

/**
 * A photo from an album shared with the caller (FR-SHR-4). The owner's image paths aren't covered
 * by the recipient's media cookie (own prefix only), so each image gets a 15-min signed URL for
 * exactly that file (7.4, §9). Callers pass only photos visible to recipients (ready).
 *
 * Signing is the expensive part (one RSA operation per URL), so album pages sign thumbnails only
 * (`preview: false`); the viewer fetches the photo on its own for the preview (GET /photos/{id}
 * with `albumId`).
 */
export async function toSharedPhoto(
  record: PhotoRecord,
  media: MediaSigner,
  now: Date,
  {
    preview,
    ownerUsername = null,
    withPlace = false,
  }: {
    preview: boolean;
    ownerUsername?: string | null;
    /** The album shares its photos' locations (FR-SHR-12): keep the place names. */
    withPlace?: boolean;
  },
): Promise<Photo> {
  const photo = toPhoto(record);
  const [thumbUrl, previewUrl] = await Promise.all([
    photo.thumbUrl ? media.signUrl(photo.thumbUrl, now) : null,
    preview && photo.previewUrl ? media.signUrl(photo.previewUrl, now) : null,
  ]);
  // Places are the owner's (13.2g): others don't learn where a photo was taken...
  // ...unless the album shares locations (FR-SHR-12). Names only: `Photo` has no coordinates.
  return { ...photo, place: withPlace ? photo.place : null, thumbUrl, previewUrl, ownerUsername };
}

/**
 * An album as its share recipient sees it (FR-SHR-3). `coverThumbUrl` from `coverThumbUrl()`.
 */
export function toSharedAlbum(
  album: AlbumRecord,
  share: ShareRecord,
  ownerUsername: string | null,
  coverThumbUrl: string | null,
): SharedAlbum {
  return {
    ...toAlbum(album, coverThumbUrl),
    ownerId: album.ownerId,
    ownerUsername,
    sharedAt: share.sharedAt,
  };
}
