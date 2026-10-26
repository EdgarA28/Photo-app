import { QueryClient } from "@tanstack/react-query";
import type { Api } from "./api/api";
import { ApiRequestError } from "./api/errors";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { Auth } from "./auth/auth";
import type { MediaCookies } from "./auth/mediaCookie";
import { QUERY_GC_TIME_MS, type PersistedQueryCache } from "./queries/persistedCache";
import type { UploadQueue } from "./upload/queue";
import type { ShareInbox } from "./upload/shareInbox";
import { routeTree } from "./routeTree.gen";

/** §12.2: below the 15-minute lifetime of signed URLs in API responses (§9). */
const STALE_TIME_MS = 10 * 60 * 1000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        // Unused data stays in memory, and so in the saved cache, for a day (9.3).
        gcTime: QUERY_GC_TIME_MS,
        // Coming back to the app (another app or tab, a phone woken up) refreshes what's on
        // screen, fresh or not: photos may have been deleted or added on another device.
        refetchOnWindowFocus: "always",
        // Retrying a 404 or a validation error can't help; network, 429 and 5xx can.
        retry: (failures, error) =>
          failures < 2 && (!(error instanceof ApiRequestError) || error.retryable),
      },
    },
  });
}

export interface AppDeps {
  queryClient: QueryClient;
  auth: Auth;
  api: Api;
  media: MediaCookies;
  uploads: UploadQueue;
  persistedCache: PersistedQueryCache;
  /** Photos shared from Android's share sheet, waiting for the upload page (9.6). */
  shareInbox: ShareInbox;
}

export function createAppRouter(
  { queryClient, auth, api, media, uploads, persistedCache, shareInbox }: AppDeps,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient, auth, api, media, uploads, persistedCache, shareInbox },
    ...(history ? { history } : {}),
    defaultPreload: "intent",
    // Loaders read through the Query cache (ensureQueryData), which decides freshness.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface StaticDataRouteOption {
    /** Render without the app shell's navigation (the viewer, FR-GAL-4). */
    fullScreen?: boolean;
  }
}
