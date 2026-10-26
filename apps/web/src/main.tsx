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
import { createIdbStore } from "./upload/store";

const config = loadConfig();
const queryClient = createQueryClient();
const auth = createAuth(config);
const api = createApi(
  createRequest({
    auth,
    // The API rejected even a fresh token: drop the session and log in again, coming back here.
    onUnauthorized: () => {
      void auth.clearSession().then(() =>
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
const router = createAppRouter({ queryClient, auth, api, media, uploads, persistedCache });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App config={config} queryClient={queryClient} router={router} />
  </StrictMode>,
);
