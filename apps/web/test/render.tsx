import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";
import { createAppRouter, createQueryClient } from "../src/router";
import type { QueryClient } from "@tanstack/react-query";
import { refreshAfterUpload } from "../src/queries/photos";
import type { UploadQueue } from "../src/upload/queue";
import { emptyPage, fakeApi, fakeAuth, testConfig, testMe, testUploadQueue } from "./fakes";

/** Default API responses for a signed-in user with no photos and no albums. */
export const defaultResponses = {
  "GET /me": testMe,
  "GET /photos": emptyPage,
  "GET /albums": { items: [] },
  "GET /shared-albums": emptyPage,
};

/** Renders the whole app at `url` with a memory history and waits for the first load. */
export async function renderAt(
  url: string,
  {
    auth = fakeAuth({ signedIn: true }),
    config = testConfig as AppConfig,
    api = fakeApi(defaultResponses).api,
    uploads = undefined as UploadQueue | ((queryClient: QueryClient) => UploadQueue) | undefined,
  } = {},
) {
  const queryClient = createQueryClient();
  const queue =
    typeof uploads === "function"
      ? uploads(queryClient)
      : (uploads ??
        testUploadQueue(api, { onUploaded: () => refreshAfterUpload(queryClient) }).queue);
  const router = createAppRouter(
    { queryClient, auth, api, uploads: queue },
    createMemoryHistory({ initialEntries: [url] }),
  );
  render(<App config={config} queryClient={queryClient} router={router} />);
  await router.load();
  return { router, auth };
}
