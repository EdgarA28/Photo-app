import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";
import { createAppRouter, createQueryClient } from "../src/router";
import { emptyPage, fakeApi, fakeAuth, testConfig, testMe } from "./fakes";

/** Default API responses for a signed-in user with no photos and no albums. */
export const defaultResponses = {
  "GET /me": testMe,
  "GET /photos": emptyPage,
  "GET /albums": { items: [] },
};

/** Renders the whole app at `url` with a memory history and waits for the first load. */
export async function renderAt(
  url: string,
  {
    auth = fakeAuth({ signedIn: true }),
    config = testConfig as AppConfig,
    api = fakeApi(defaultResponses).api,
  } = {},
) {
  const queryClient = createQueryClient();
  const router = createAppRouter(
    { queryClient, auth, api },
    createMemoryHistory({ initialEntries: [url] }),
  );
  render(<App config={config} queryClient={queryClient} router={router} />);
  await router.load();
  return { router, auth };
}
