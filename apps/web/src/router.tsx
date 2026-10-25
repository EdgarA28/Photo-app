import { QueryClient } from "@tanstack/react-query";
import type { Api } from "./api/api";
import { ApiRequestError } from "./api/errors";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { Auth } from "./auth/auth";
import type { MediaCookies } from "./auth/mediaCookie";
import type { UploadQueue } from "./upload/queue";
import { routeTree } from "./routeTree.gen";

/** §12.2: below the 15-minute lifetime of signed URLs in API responses (§9). */
const STALE_TIME_MS = 10 * 60 * 1000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
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
}

export function createAppRouter(
  { queryClient, auth, api, media, uploads }: AppDeps,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient, auth, api, media, uploads },
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
