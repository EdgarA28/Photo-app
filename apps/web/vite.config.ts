import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API has no CORS (§9): in production the browser reaches it on the app's own origin via
// CloudFront `/api/*` (Phase 7). Locally Vite proxies `/api` to a deployed API instead, e.g.
//   API_PROXY_TARGET=$(tofu -chdir=infra/envs/dev output -raw api_endpoint) pnpm dev
const apiTarget = process.env.API_PROXY_TARGET;

export default defineConfig({
  plugins: [
    // Generates src/routeTree.gen.ts from src/routes (§12.1); must run before the React plugin.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Fixed: http://localhost:5173/auth/callback is a registered Cognito callback URL (4.2).
    port: 5173,
    strictPort: true,
    proxy: apiTarget ? { "/api": { target: apiTarget, changeOrigin: true } } : undefined,
  },
});
