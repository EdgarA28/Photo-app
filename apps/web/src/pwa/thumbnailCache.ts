// Service worker thumbnail cache (9.2, §12.5, NFR-PERF-4, FR-PWA-2). Used by vite.config.ts for
// the Workbox runtime route, by logout (FR-AUTH-5) to delete the cache, and by the tests.
//
// Workbox copies the two functions into sw.js as source text, so they must not use anything
// outside their own body (no imports, no module constants).

/** Cache Storage name of the thumbnail cache. */
export const THUMBNAIL_CACHE = "thumbnails";

/** Up to ~3,000 thumbnails (~8 KB each, ~24 MB) for 30 days (§12.5). */
export const THUMBNAIL_CACHE_LIMITS = { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 60 * 60 };

/**
 * Route match: same-origin `/users/{sub}/thumbs/{photoId}.jpg`, own (media cookie, 7.3) or
 * shared (signed URL, 7.4). Previews and originals are never cached (§12.5).
 */
export const isThumbnailRequest = ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
  sameOrigin && /^\/users\/[^/]+\/thumbs\/[^/]+$/.test(url.pathname);

/**
 * `cacheKeyWillBeUsed` plugin: stores and looks up thumbnails without the query string. A shared
 * album's thumbnail URL carries a new `Expires`/`Signature` every time the list is fetched (7.4);
 * keyed by the full URL, every refetch would add another copy of the same image.
 */
export const thumbnailCacheKey = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  url.search = "";
  return url.href;
};

/**
 * `cacheWillUpdate` plugin: stores only images. With the 200-only rule, a 200 that isn't an image
 * (an HTML fallback page from a misrouted request) would otherwise be served for 30 days.
 */
export const onlyImages = async ({ response }: { response: Response }) =>
  response.headers.get("content-type")?.startsWith("image/") ? response : null;
