import type { GalleryFilter } from "@/queries/photos";
import type { GallerySearch } from "./search";

/** What a library page lists and how it talks about it (FR-VID-11). */
export type LibraryKind = "photo" | "video";

/** The list behind a library page: the Gallery (photos, also in a place) or Videos. */
export const libraryFilter = (kind: LibraryKind, search: GallerySearch): GalleryFilter =>
  kind === "video"
    ? { sort: search.sort, mediaType: "video" }
    : { album: search.album, place: search.place, sort: search.sort, mediaType: "photo" };
