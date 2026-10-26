import type { QueryClient } from "@tanstack/react-query";
import { THUMBNAIL_CACHE } from "@/pwa/thumbnailCache";
import type { PersistedQueryCache } from "@/queries/persistedCache";
import type { UploadQueue } from "@/upload/queue";
import type { ShareInbox } from "@/upload/shareInbox";
import type { Auth } from "./auth";
import type { MediaCookies } from "./mediaCookie";

export interface LogoutDeps {
  auth: Pick<Auth, "logout">;
  queryClient: QueryClient;
  uploads: Pick<UploadQueue, "stop" | "clear">;
  media: Pick<MediaCookies, "clear">;
  persistedCache: Pick<PersistedQueryCache, "clear">;
  shareInbox: Pick<ShareInbox, "clear">;
}

/**
 * Logs out and leaves nothing private on the device (FR-AUTH-5, §5.2 Logout): the upload queue
 * (files in IndexedDB, every account's) and photos shared to the app not yet added (9.6), the Query
 * cache (in memory and saved, 9.3), the service
 * worker's thumbnail cache (9.2), the media cookies, then the tokens and the Cognito session
 * (`auth.logout` ends with a full-page redirect). The session always ends, even if clearing local
 * data fails (e.g. IndexedDB blocked or evicted): staying signed in would be the worse outcome.
 */
export async function logout({
  auth,
  queryClient,
  uploads,
  media,
  persistedCache,
  shareInbox,
}: LogoutDeps): Promise<void> {
  try {
    uploads.stop();
    await uploads.clear();
  } catch (error) {
    console.warn("Clearing the upload queue failed", error);
  } finally {
    try {
      await shareInbox.clear();
    } catch (error) {
      console.warn("Clearing the shared photos failed", error);
    }
    // Stop saving first, so clearing the memory cache isn't written back.
    try {
      await persistedCache.clear();
    } catch (error) {
      console.warn("Deleting the saved query cache failed", error);
    }
    queryClient.clear();
    // Thumbnails the service worker kept (9.2): the next account on this device mustn't see them.
    try {
      await globalThis.caches?.delete(THUMBNAIL_CACHE);
    } catch (error) {
      console.warn("Clearing the thumbnail cache failed", error);
    }
    // HttpOnly, so only a server response can expire them; needs the token, so before revoking.
    // If it fails they expire on their own (≤ 8 h, own prefix only, §9).
    try {
      await media.clear();
    } catch (error) {
      console.warn("Expiring the media cookies failed", error);
    }
    await auth.logout();
  }
}
