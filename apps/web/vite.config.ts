import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
      // Installable app (9.1, FR-PWA-1, §12.5). The service worker is still built but not
      // registered (`injectRegister: false`) until its caching (9.2) and the update prompt
      // (`registerType: 'prompt'`, 9.4) exist.
      VitePWA({
        injectRegister: false,
        // Icons from pwa-assets.config.ts; their <link> tags and the manifest `icons` are added
        // by the plugin. Theme colour metas are written in index.html, one per colour scheme.
        pwaAssets: { config: true, injectThemeColor: false },
        manifest: {
          id: "/",
          name: "Photo App",
          short_name: "Photos",
          description: "Your photos, backed up and shared.",
          start_url: "/gallery",
          scope: "/",
          display: "standalone",
          // Light theme `--background` (index.css); the manifest has no per-scheme colours.
          theme_color: "#ffffff",
          background_color: "#ffffff",
        },
      }),
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
