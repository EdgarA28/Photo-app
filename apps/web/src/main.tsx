import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api/api";
import { createRequest } from "./api/client";
import { App } from "./App";
import { createAuth } from "./auth/auth";
import { createMediaCookies } from "./auth/mediaCookie";
import { loadConfig } from "./config";
import { refreshAfterUpload } from "./queries/photos";
import { createAppRouter, createQueryClient } from "./router";
import { createUploadQueue, UPLOAD_CHANNEL_NAME } from "./upload/queue";
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
  requestPersistence: () => navigator.storage?.persist?.(),
});
const router = createAppRouter({ queryClient, auth, api, media, uploads });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App config={config} queryClient={queryClient} router={router} />
  </StrictMode>,
);
