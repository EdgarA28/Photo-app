import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api/api";
import { createRequest } from "./api/client";
import { App } from "./App";
import { createAuth } from "./auth/auth";
import { createMediaCookies } from "./auth/mediaCookie";
import { loadConfig } from "./config";
import { createPersistedQueryCache } from "./queries/persistedCache";
import { refreshAfterUpload } from "./queries/photos";
import { createAppRouter, createQueryClient } from "./router";
import { createUploadQueue, SYNC_TAG, UPLOAD_CHANNEL_NAME } from "./upload/queue";
import { createIdbShareInbox } from "./upload/shareInbox";
import { createIdbBatchStore } from "./upload/batches";
import { createIdbStore } from "./upload/store";

const config = loadConfig();
const queryClient = createQueryClient();
const auth = createAuth(config);
const api = createApi(
  createRequest({
    auth,
    // The API rejected even a fresh token, or Cognito the refresh (the guard doesn't wait for it,
    // 8.25b): drop the session and its saved data (FR-AUTH-5), then log in again, coming back here.
    onUnauthorized: () => {
      void Promise.all([
        auth.clearSession(),
        persistedCache
          .clear()
          .catch((error: unknown) => console.warn("Deleting the saved query cache failed", error)),
      ]).then(() =>
        router.navigate({
          to: "/login",
          search: { redirect: router.state.location.href, reason: "expired" },
        }),
      );
    },
  }),
);
// Renewed with every token refresh, even while the user stays on one page (7.3).
const media = createMediaCookies({ auth, api });
auth.onTokens(() => void media.ensure());
const uploads = createUploadQueue({
  api,
  store: createIdbStore(),
  // Large batches remembered, so they can be continued after the tab closed (13.1f).
  batches: createIdbBatchStore(),
  onUploaded: () => refreshAfterUpload(queryClient),
  locks: navigator.locks,
  createChannel:
    typeof BroadcastChannel === "undefined"
      ? undefined
      : () => new BroadcastChannel(UPLOAD_CHANNEL_NAME),
  // Background Sync (9.5): Chromium only; `getRegistration` is undefined until the service worker
  // is registered (never in `pnpm dev`).
  registerSync: () =>
    navigator.serviceWorker
      ?.getRegistration()
      .then((registration) =>
        (
          registration as { sync?: { register(tag: string): Promise<void> } } | undefined
        )?.sync?.register(SYNC_TAG),
      ),
  requestPersistence: () => navigator.storage?.persist?.(),
});
const persistedCache = createPersistedQueryCache(queryClient);
const shareInbox = createIdbShareInbox();
const router = createAppRouter({
  queryClient,
  auth,
  api,
  media,
  uploads,
  persistedCache,
  shareInbox,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App config={config} queryClient={queryClient} router={router} />
  </StrictMode>,
);
