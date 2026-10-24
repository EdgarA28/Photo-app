import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api/api";
import { createRequest } from "./api/client";
import { App } from "./App";
import { createAuth } from "./auth/auth";
import { loadConfig } from "./config";
import { createAppRouter, createQueryClient } from "./router";

const config = loadConfig();
const queryClient = createQueryClient();
const auth = createAuth(config);
const api = createApi(
  createRequest({
    auth,
    // The API rejected even a fresh token: drop the session and log in again, coming back here.
    onUnauthorized: () => {
      void auth
        .clearSession()
        .then(() =>
          router.navigate({ to: "/login", search: { redirect: router.state.location.href } }),
        );
    },
  }),
);
const router = createAppRouter({ queryClient, auth, api });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App config={config} queryClient={queryClient} router={router} />
  </StrictMode>,
);
