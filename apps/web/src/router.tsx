import { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { Auth } from "./auth/auth";
import { routeTree } from "./routeTree.gen";

/** §12.2: below the 15-minute lifetime of signed URLs in API responses (§9). */
const STALE_TIME_MS = 10 * 60 * 1000;

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: STALE_TIME_MS } } });
}

export function createAppRouter(queryClient: QueryClient, auth: Auth, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient, auth },
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
}
