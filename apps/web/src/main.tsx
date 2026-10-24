import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createAuth } from "./auth/auth";
import { loadConfig } from "./config";
import { createAppRouter, createQueryClient } from "./router";

const queryClient = createQueryClient();
const config = loadConfig();
const auth = createAuth(config);
const router = createAppRouter(queryClient, auth);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App config={config} queryClient={queryClient} router={router} />
  </StrictMode>,
);
