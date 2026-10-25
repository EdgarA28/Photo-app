import type { QueryClient } from "@tanstack/react-query";
import type { UploadQueue } from "@/upload/queue";
import type { Auth } from "./auth";

export interface LogoutDeps {
  auth: Pick<Auth, "logout">;
  queryClient: QueryClient;
  uploads: Pick<UploadQueue, "stop" | "clear">;
}

/**
 * Logs out and leaves nothing private on the device (FR-AUTH-5, §5.2 Logout): the upload queue
 * (files in IndexedDB, every account's), the Query cache, then the tokens and the Cognito session
 * (`auth.logout` ends with a full-page redirect).
 */
export async function logout({ auth, queryClient, uploads }: LogoutDeps): Promise<void> {
  uploads.stop();
  await uploads.clear();
  queryClient.clear();
  // 7.3: `DELETE /session/media-cookie` goes here, before the tokens are revoked. The cookies are
  // HttpOnly, so only a server response can expire them; until 7.3 there are none.
  await auth.logout();
}
