import { albumsRepo } from "./albums";
import type { Db } from "./db";
import { linksRepo } from "./links";
import { photosRepo } from "./photos";
import { placesRepo } from "./places";
import { sharesRepo } from "./shares";
import { usageRepo } from "./usage";
import { usernamesRepo } from "./usernames";

export type { AlbumRecord, AlbumUpdate, MembershipRecord } from "./albums";
export { createDocumentClient, type Db } from "./db";
export type { LinkRecord } from "./links";
export { albumOwnerOf, type AddResult } from "./memberships";
export type { ExpiredPhoto, LocatedPhoto, NewPhoto, PendingMarker, PhotoRecord } from "./photos";
export type { PlacePhotoRecord, PlaceRecord } from "./places";
export type { CreateShareResult, ShareRecord } from "./shares";
export { isAccepted, shareStatus } from "./shares";
export type { UsageRecord } from "./usage";
export type { ProfileRecord, SetUsernameResult } from "./usernames";

/** DynamoDB access for the API (task 5.3). Routes get this object; nothing else touches the table. */
export function createRepositories(db: Db) {
  return {
    photos: photosRepo(db),
    albums: albumsRepo(db),
    places: placesRepo(db),
    links: linksRepo(db),
    shares: sharesRepo(db),
    usage: usageRepo(db),
    usernames: usernamesRepo(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
