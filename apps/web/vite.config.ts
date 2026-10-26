import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import {
  THUMBNAIL_CACHE,
  THUMBNAIL_CACHE_LIMITS,
  isThumbnailRequest,
  onlyImages,
  thumbnailCacheKey,
} from "./src/pwa/thumbnailCache";

// The API has no CORS (§9): in production the browser reaches it on the app's own origin via
// CloudFront `/api/*` (Phase 7). Locally Vite proxies `/api` to a deployed API instead; the target
// comes from API_PROXY_TARGET (environment, or .env.development.local from `pnpm env:dev`).
// Images: `/users` goes to the deployed CloudFront (MEDIA_PROXY_TARGET, 7.3). The media cookies,
// set on localhost through the /api proxy, travel with these requests, and their policy names
// the CloudFront domain, which is what CloudFront sees after `changeOrigin`.
/** Shown in Settings (src/version.ts): commit, "+" if there are uncommitted changes, UTC time. */
function appVersion() {
  const git = (args: string) => execSync(`git ${args}`, { encoding: "utf8" }).trim();
  try {
    const dirty = git("status --porcelain") ? "+" : "";
    return `${git("rev-parse --short HEAD")}${dirty} ${new Date().toISOString().slice(0, 16)}Z`;
  } catch {
    return `unknown ${new Date().toISOString().slice(0, 16)}Z`;
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxy = {
    ...(env.API_PROXY_TARGET && { "/api": { target: env.API_PROXY_TARGET, changeOrigin: true } }),
    ...(env.MEDIA_PROXY_TARGET && {
      "/users": { target: env.MEDIA_PROXY_TARGET, changeOrigin: true },
    }),
  };

  return {
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    plugins: [
      // Generates src/routeTree.gen.ts from src/routes (§12.1); must run before the React plugin.
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      // Installable app (9.1, FR-PWA-1, §12.5). The service worker is registered by
      // src/pwa/UpdatePrompt.tsx (`useRegisterSW`), not by an injected script; a new version
      // waits for the user's "Reload" (9.4, FR-PWA-3).
      VitePWA({
        registerType: "prompt",
        injectRegister: false,
        // Service worker caching (9.2, NFR-PERF-4).
        workbox: {
          // App shell: everything the build emits, fonts and icons included; `index.html` is
          // served for every navigation, so the app opens offline (FR-PWA-2).
          globPatterns: ["**/*.{js,css,html,woff2,ico,png,svg}"],
          navigateFallback: "/index.html",
          // Real responses, never the app shell: API calls and images (CloudFront `/api/*` and
          // `/users/*`), e.g. a download link opened in the tab.
          navigateFallbackDenylist: [/^\/api\//, /^\/users\//],
          cleanupOutdatedCaches: true,
          // Thumbnails: CacheFirst. Only 200 images are stored (a 403 from an expired cookie or
          // signature must not stick). Everything else, `/api/*` included, has no route and goes
          // straight to the network (NetworkOnly); offline data comes from the Query cache (9.3).
          runtimeCaching: [
            {
              urlPattern: isThumbnailRequest,
              handler: "CacheFirst",
              options: {
                cacheName: THUMBNAIL_CACHE,
                expiration: { ...THUMBNAIL_CACHE_LIMITS, purgeOnQuotaError: true },
                cacheableResponse: { statuses: [200] },
                plugins: [{ cacheKeyWillBeUsed: thumbnailCacheKey, cacheWillUpdate: onlyImages }],
              },
            },
          ],
        },
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
