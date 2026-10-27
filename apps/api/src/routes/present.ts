import { previewKey, thumbKey, type Album, type Photo, type SharedAlbum } from "@photo-app/shared";
import type { MediaSigner } from "../lib/media";
import type { AlbumRecord, PhotoRecord, ShareRecord } from "../repo";

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
  };
}

/** `cover` is the album's cover photo, if it has one and it still exists. */
export function toAlbum(record: AlbumRecord, cover: PhotoRecord | null | undefined): Album {
  return {
    albumId: record.albumId,
    name: record.name,
    createdAt: record.createdAt,
    coverPhotoId: record.coverPhotoId ?? null,
    coverThumbUrl: cover ? toPhoto(cover).thumbUrl : null,
    photoCount: Math.max(0, record.photoCount),
  };
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
  { preview }: { preview: boolean },
): Promise<Photo> {
  const photo = toPhoto(record);
  const [thumbUrl, previewUrl] = await Promise.all([
    photo.thumbUrl ? media.signUrl(photo.thumbUrl, now) : null,
    preview && photo.previewUrl ? media.signUrl(photo.previewUrl, now) : null,
  ]);
  // Places are the owner's (13.2g): recipients don't learn where a photo was taken.
  return { ...photo, place: null, thumbUrl, previewUrl };
}

/**
 * An album as its share recipient sees it (FR-SHR-3). `cover`: the owner's cover photo if it
 * still exists and is visible to recipients; its thumbnail gets a signed URL like the photos.
 */
export async function toSharedAlbum(
  album: AlbumRecord,
  share: ShareRecord,
  ownerUsername: string | null,
  cover: PhotoRecord | undefined,
  media: MediaSigner,
  now: Date,
): Promise<SharedAlbum> {
  const thumb = cover ? toPhoto(cover).thumbUrl : null;
  return {
    ...toAlbum(album, null),
    coverThumbUrl: thumb ? await media.signUrl(thumb, now) : null,
    ownerId: album.ownerId,
    ownerUsername,
    sharedAt: share.sharedAt,
  };
}
