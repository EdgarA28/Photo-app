import { previewKey, thumbKey, type Album, type Photo } from "@photo-app/shared";
import type { AlbumRecord, PhotoRecord } from "../repo";

/**
 * Repository records → API objects (§9). Own images use stable CloudFront paths under
 * `/users/{sub}/`, authorised by the caller's media cookie (7.3). Photos from albums shared with
 * the caller need signed URLs instead (7.4) and must not go through these helpers.
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
