import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The API has no CORS (§9): in production the browser reaches it on the app's own origin via
// CloudFront `/api/*` (Phase 7). Locally Vite proxies `/api` to a deployed API instead; the target
// comes from API_PROXY_TARGET (environment, or .env.development.local from `pnpm env:dev`).
// Images: `/users` goes to the deployed CloudFront (MEDIA_PROXY_TARGET, 7.3). The media cookies,
// set on localhost through the /api proxy, travel with these requests, and their policy names
// the CloudFront domain, which is what CloudFront sees after `changeOrigin`.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxy = {
    ...(env.API_PROXY_TARGET && { "/api": { target: env.API_PROXY_TARGET, changeOrigin: true } }),
    ...(env.MEDIA_PROXY_TARGET && {
      "/users": { target: env.MEDIA_PROXY_TARGET, changeOrigin: true },
    }),
  };

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
      proxy,
    },
  };
});
