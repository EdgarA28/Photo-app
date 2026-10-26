/// <reference lib="webworker" />
// The service worker (9.2, 9.4, 9.5, §12.5), built by vite-plugin-pwa (`injectManifest`). The
// WebWorker types come in through the reference above, next to the app's DOM types.
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { createApi } from "./api/api";
import { createRequest } from "./api/client";
import { createIdbSessionDb, readStoredSession } from "./auth/sessionDb";
import { loadConfig } from "./config";
import { uploadInBackground } from "./pwa/backgroundUploads";
import {
  THUMBNAIL_CACHE,
  THUMBNAIL_CACHE_LIMITS,
  isThumbnailRequest,
  onlyImages,
  thumbnailCacheKey,
} from "./pwa/thumbnailCache";
import { createWorkerAuth } from "./pwa/workerAuth";
import { SYNC_TAG, UPLOAD_CHANNEL_NAME } from "./upload/queue";
import { postToS3WithFetch } from "./upload/s3Post";
import { createIdbStore } from "./upload/store";

declare const self: ServiceWorkerGlobalScope;

/** Background Sync (Chromium); not in TypeScript's WebWorker types. */
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
}

// `registerType: 'prompt'` (9.4, FR-PWA-3): a new version waits until the user taps "Reload",
// which sends this message.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

// App shell: everything the build emits, fonts and icons included (globPatterns in
// vite.config.ts); `index.html` is served for every navigation, so the app opens offline
// (FR-PWA-2).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// Real responses, never the app shell: API calls and images (CloudFront `/api/*` and `/users/*`),
// e.g. a download link opened in the tab.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/users\//],
  }),
);

// Thumbnails: CacheFirst (9.2, NFR-PERF-4). Only 200 images are stored (a 403 from an expired
// cookie or signature must not stick). Everything else, `/api/*` included, has no route and goes
// straight to the network (NetworkOnly); offline data comes from the Query cache (9.3).
registerRoute(
  isThumbnailRequest,
  new CacheFirst({
    cacheName: THUMBNAIL_CACHE,
    plugins: [
      new ExpirationPlugin({ ...THUMBNAIL_CACHE_LIMITS, purgeOnQuotaError: true }),
      new CacheableResponsePlugin({ statuses: [200] }),
      { cacheKeyWillBeUsed: thumbnailCacheKey, cacheWillUpdate: onlyImages },
    ],
  }),
);

// Uploads the stored queue once online, even with the app closed (9.5, pwa/backgroundUploads.ts).
self.addEventListener("sync", (event) => {
  const sync = event as SyncEvent;
  if (sync.tag !== SYNC_TAG) return;
  const config = loadConfig(import.meta.env, self.location.origin);
  const sessions = createIdbSessionDb();
  sync.waitUntil(
    uploadInBackground({
      readSession: () => readStoredSession(sessions),
      connect: (session) => {
        const auth = createWorkerAuth(config, session);
        // No redirect to /login from here: the uploads stop and the app asks when it opens.
        return { api: createApi(createRequest({ auth, onUnauthorized: () => {} })), auth };
      },
      store: createIdbStore(),
      post: postToS3WithFetch(),
      locks: self.navigator.locks,
      createChannel: () => new BroadcastChannel(UPLOAD_CHANNEL_NAME),
    }),
  );
});
