import { execSync } from "node:child_process";
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
        // Our own service worker, src/sw.ts: Workbox caching (9.2, NFR-PERF-4) plus Background
        // Sync for the upload queue (9.5), which generateSW can't add.
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        injectManifest: {
          // App shell precache: everything the build emits, fonts and icons included (FR-PWA-2).
          globPatterns: ["**/*.{js,css,html,woff2,ico,png,svg}"],
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
          // Android share sheet (9.6, FR-PWA-4): shared photos are POSTed to the service worker
          // (src/pwa/shareTarget.ts, which has the path and field name). Any image: the upload
          // page explains which types it can't take.
          share_target: {
            action: "/share-target",
            method: "POST",
            enctype: "multipart/form-data",
            params: { files: [{ name: "photos", accept: ["image/*"] }] },
          },
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
