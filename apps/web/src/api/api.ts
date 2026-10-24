import {
  albumListSchema,
  albumSchema,
  albumShareListSchema,
  albumShareSchema,
  downloadUrlResponseSchema,
  meResponseSchema,
  photoPageSchema,
  photoSchema,
  setUsernameResponseSchema,
  sharedAlbumPageSchema,
  uploadUrlResponseSchema,
  type AddAlbumPhotosRequest,
  type CreateAlbumRequest,
  type CreateShareRequest,
  type PageQuery,
  type PhotoSort,
  type UpdateAlbumRequest,
  type UploadUrlRequest,
} from "@photo-app/shared";
import type { Request } from "./client";

type Page = Partial<PageQuery>;
type Opts = { signal?: AbortSignal };

const enc = encodeURIComponent;

/** One function per API route (ARCHITECTURE §9), typed by the shared schemas. */
export function createApi(request: Request) {
  return {
    me: {
      get: (o?: Opts) => request("GET", "/me", { schema: meResponseSchema, ...o }),
      setUsername: (username: string) =>
        request("PUT", "/me/username", { schema: setUsernameResponseSchema, body: { username } }),
    },

    photos: {
      list: (query: Page & { sort?: PhotoSort } = {}, o?: Opts) =>
        request("GET", "/photos", { schema: photoPageSchema, query, ...o }),
      get: (photoId: string, o?: Opts) =>
        request("GET", `/photos/${enc(photoId)}`, { schema: photoSchema, ...o }),
      /** Also re-signs a pending upload when `photoId` is set (5.6a). */
      uploadUrl: (body: UploadUrlRequest) =>
        request("POST", "/photos/upload-url", { schema: uploadUrlResponseSchema, body }),
      /** `albumId` is required when the photo is seen through a shared album (5.13). */
      downloadUrl: (photoId: string, albumId?: string) =>
        request("GET", `/photos/${enc(photoId)}/download-url`, {
          schema: downloadUrlResponseSchema,
          query: { albumId },
        }),
      delete: (photoId: string) => request("DELETE", `/photos/${enc(photoId)}`),
    },

    albums: {
      list: (o?: Opts) => request("GET", "/albums", { schema: albumListSchema, ...o }),
      create: (body: CreateAlbumRequest) =>
        request("POST", "/albums", { schema: albumSchema, body }),
      update: (albumId: string, body: UpdateAlbumRequest) =>
        request("PATCH", `/albums/${enc(albumId)}`, { schema: albumSchema, body }),
      delete: (albumId: string) => request("DELETE", `/albums/${enc(albumId)}`),
      photos: (albumId: string, query: Page = {}, o?: Opts) =>
        request("GET", `/albums/${enc(albumId)}/photos`, { schema: photoPageSchema, query, ...o }),
      addPhotos: (albumId: string, body: AddAlbumPhotosRequest) =>
        request("POST", `/albums/${enc(albumId)}/photos`, { body }),
      removePhoto: (albumId: string, photoId: string) =>
        request("DELETE", `/albums/${enc(albumId)}/photos/${enc(photoId)}`),
      shares: (albumId: string, o?: Opts) =>
        request("GET", `/albums/${enc(albumId)}/shares`, { schema: albumShareListSchema, ...o }),
      share: (albumId: string, body: CreateShareRequest) =>
        request("POST", `/albums/${enc(albumId)}/shares`, { schema: albumShareSchema, body }),
      unshare: (albumId: string, userId: string) =>
        request("DELETE", `/albums/${enc(albumId)}/shares/${enc(userId)}`),
    },

    sharedAlbums: {
      list: (query: Page = {}, o?: Opts) =>
        request("GET", "/shared-albums", { schema: sharedAlbumPageSchema, query, ...o }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
