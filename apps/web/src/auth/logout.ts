import type { QueryClient } from "@tanstack/react-query";
import type { UploadQueue } from "@/upload/queue";
import type { Auth } from "./auth";
import type { MediaCookies } from "./mediaCookie";

export interface LogoutDeps {
  auth: Pick<Auth, "logout">;
  queryClient: QueryClient;
  uploads: Pick<UploadQueue, "stop" | "clear">;
  media: Pick<MediaCookies, "clear">;
}

/**
 * Logs out and leaves nothing private on the device (FR-AUTH-5, §5.2 Logout): the upload queue
 * (files in IndexedDB, every account's), the Query cache, the media cookies, then the tokens and
 * the Cognito session (`auth.logout` ends with a full-page redirect). The session always ends, even if clearing local
 * data fails (e.g. IndexedDB blocked or evicted): staying signed in would be the worse outcome.
 */
export async function logout({ auth, queryClient, uploads, media }: LogoutDeps): Promise<void> {
  try {
    uploads.stop();
    await uploads.clear();
  } catch (error) {
    console.warn("Clearing the upload queue failed", error);
  } finally {
    queryClient.clear();
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
