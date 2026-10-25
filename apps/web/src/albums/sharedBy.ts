import type { SharedAlbum } from "@photo-app/shared";

/** Who shared an album with me. The API never exposes the owner's email (FR-SHR-5). */
export const sharedBy = (album: SharedAlbum) =>
  album.ownerUsername ? `Shared by @${album.ownerUsername}` : "Shared with you";
