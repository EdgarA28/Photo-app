import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The API has no CORS (§9): in production the browser reaches it on the app's own origin via
// CloudFront `/api/*` (Phase 7). Locally Vite proxies `/api` to a deployed API instead; the target
// comes from API_PROXY_TARGET (environment, or .env.development.local from `pnpm env:dev`).
export default defineConfig(({ mode }) => {
  const apiTarget = loadEnv(mode, process.cwd(), "").API_PROXY_TARGET;

  return {
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
  };
});
