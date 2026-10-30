import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { App } from "../src/App";
import type { MediaCookies } from "../src/auth/mediaCookie";
import type { AppConfig } from "../src/config";
import { createAppRouter, createQueryClient } from "../src/router";
import type { QueryClient } from "@tanstack/react-query";
import type { PersistedQueryCache } from "../src/queries/persistedCache";
import { refreshAfterUpload } from "../src/queries/photos";
import type { UploadQueue } from "../src/upload/queue";
import {
  emptyPage,
  fakeApi,
  fakeAuth,
  fakeMedia,
  fakePersistedCache,
  MemoryShareInbox,
  testConfig,
  testMe,
  testUploadQueue,
} from "./fakes";

/** Default API responses for a signed-in user with no photos and no albums. */
export const defaultResponses = {
  "GET /me": testMe,
  "GET /photos": emptyPage,
  "GET /albums": { items: [] },
  "GET /shared-albums": emptyPage,
  "GET /share-invitations": emptyPage,
  "GET /places": { items: [] },
};

/**
 * Renders the whole app at `url` with a memory history (or `history`, then `url` is ignored) and
 * waits for the first load.
 */
export async function renderAt(
  url: string,
  {
    auth = fakeAuth({ signedIn: true }),
    config = testConfig as AppConfig,
    api = fakeApi(defaultResponses).api,
    media = fakeMedia() as MediaCookies,
    uploads = undefined as UploadQueue | ((queryClient: QueryClient) => UploadQueue) | undefined,
    persistedCache = undefined as
      PersistedQueryCache | ((queryClient: QueryClient) => PersistedQueryCache) | undefined,
    shareInbox = new MemoryShareInbox(),
    history = undefined as RouterHistory | undefined,
  } = {},
) {
  const queryClient = createQueryClient();
  // The app's retry rules stay, without the 1 s + 2 s pauses (a failing request cost 3 s per test).
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
  });
  const cache =
    typeof persistedCache === "function"
      ? persistedCache(queryClient)
      : (persistedCache ?? fakePersistedCache());
  const queue =
    typeof uploads === "function"
      ? uploads(queryClient)
      : (uploads ??
        testUploadQueue(api, { onUploaded: () => refreshAfterUpload(queryClient) }).queue);
  const router = createAppRouter(
    { queryClient, auth, api, media, uploads: queue, persistedCache: cache, shareInbox },
    history ?? createMemoryHistory({ initialEntries: [url] }),
  );
  render(<App config={config} queryClient={queryClient} router={router} />);
  await router.load();
  return { router, auth, media, persistedCache: cache };
}
