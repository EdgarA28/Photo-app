import {
  albumListSchema,
  albumSchema,
  albumShareListSchema,
  albumShareSchema,
  downloadUrlResponseSchema,
  photoLinkSchema,
  sharedLinkSchema,
  mediaCookieResponseSchema,
  meResponseSchema,
  photoLocationListSchema,
  photoPageSchema,
  placeListSchema,
  photoSchema,
  setUsernameResponseSchema,
  sharedAlbumPageSchema,
  shareInvitationPageSchema,
  trashListSchema,
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
      /** With `albumId`: a photo of an album shared with me, with signed image URLs (7.4). */
      get: (photoId: string, albumId?: string, o?: Opts) =>
        request("GET", `/photos/${enc(photoId)}`, {
          schema: photoSchema,
          query: { albumId },
          ...o,
        }),
      /** Also re-signs a pending upload when `photoId` is set (5.6a). */
      uploadUrl: (body: UploadUrlRequest) =>
        request("POST", "/photos/upload-url", { schema: uploadUrlResponseSchema, body }),
      /** `albumId` is required when the photo is seen through a shared album (5.13). */
      downloadUrl: (photoId: string, albumId?: string) =>
        request("GET", `/photos/${enc(photoId)}/download-url`, {
          schema: downloadUrlResponseSchema,
          query: { albumId },
        }),
      /** Moves it to the trash; a pending upload is deleted at once (FR-DEL-3). */
      delete: (photoId: string) => request("DELETE", `/photos/${enc(photoId)}`),
    },

    /** Public photo links (FR-SHR-8): created signed in, opened without a login. */
    links: {
      /** A link to these own photos, valid 15 min. */
      create: (photoIds: string[]) =>
        request("POST", "/links", { schema: photoLinkSchema, body: { photoIds } }),
      get: (token: string, o?: Opts) =>
        request("GET", `/links/${enc(token)}`, { schema: sharedLinkSchema, public: true, ...o }),
      downloadUrl: (token: string, photoId: string) =>
        request("GET", `/links/${enc(token)}/photos/${enc(photoId)}/download-url`, {
          schema: downloadUrlResponseSchema,
          public: true,
        }),
    },

    trash: {
      list: (o?: Opts) => request("GET", "/trash", { schema: trashListSchema, ...o }),
      restore: (photoId: string) =>
        request("POST", `/trash/${enc(photoId)}/restore`, { schema: photoSchema }),
      deleteForever: (photoId: string) => request("DELETE", `/trash/${enc(photoId)}`),
      empty: () => request("DELETE", "/trash"),
    },

    places: {
      list: (o?: Opts) => request("GET", "/places", { schema: placeListSchema, ...o }),
      /** Own photos with GPS as map pins, coordinates rounded (13.2h). */
      map: (o?: Opts) => request("GET", "/places/map", { schema: photoLocationListSchema, ...o }),
      photos: (placeId: string, query: Page & { sort?: PhotoSort } = {}, o?: Opts) =>
        request("GET", `/places/${enc(placeId)}/photos`, { schema: photoPageSchema, query, ...o }),
    },
    albums: {
      list: (o?: Opts) => request("GET", "/albums", { schema: albumListSchema, ...o }),
      create: (body: CreateAlbumRequest) =>
        request("POST", "/albums", { schema: albumSchema, body }),
      update: (albumId: string, body: UpdateAlbumRequest) =>
        request("PATCH", `/albums/${enc(albumId)}`, { schema: albumSchema, body }),
      delete: (albumId: string) => request("DELETE", `/albums/${enc(albumId)}`),
      photos: (albumId: string, query: Page & { sort?: PhotoSort } = {}, o?: Opts) =>
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
      /** Accepts an invitation (FR-SHR-6). */
      accept: (albumId: string) => request("POST", `/shared-albums/${enc(albumId)}/accept`),
      /** Declines an invitation or removes an accepted album (FR-SHR-7). */
      leave: (albumId: string) => request("DELETE", `/shared-albums/${enc(albumId)}`),
    },

    shareInvitations: {
      list: (query: Page = {}, o?: Opts) =>
        request("GET", "/share-invitations", { schema: shareInvitationPageSchema, query, ...o }),
    },

    /** CloudFront cookies for own images (7.3); set by the response's Set-Cookie headers. */
    session: {
      createMediaCookie: () =>
        request("POST", "/session/media-cookie", { schema: mediaCookieResponseSchema }),
      deleteMediaCookie: () => request("DELETE", "/session/media-cookie"),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
