import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { createAppRouter, createQueryClient } from "../src/router";

afterEach(cleanup);

async function renderAt(url: string) {
  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [url] }));
  render(<App queryClient={queryClient} router={router} />);
  await router.load();
  return router;
}

describe("routes (§12.1)", () => {
  it("redirects / to the gallery", async () => {
    const router = await renderAt("/");
    expect(router.state.location.pathname).toBe("/gallery");
    expect(await screen.findByRole("heading", { name: "Gallery" })).toBeTruthy();
  });

  it("defaults the gallery sort to taken-desc", async () => {
    const router = await renderAt("/gallery");
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
  });

  it("keeps valid gallery search params", async () => {
    const album = "01JB2Z3M4N5P6Q7R8S9T0V1W2X";
    const router = await renderAt(`/gallery?album=${album}&sort=taken-asc`);
    expect(router.state.location.search).toEqual({ album, sort: "taken-asc" });
  });

  it("drops invalid gallery search params instead of failing", async () => {
    const router = await renderAt("/gallery?album=nope&sort=random");
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
    expect(await screen.findByText("Sort: taken-desc")).toBeTruthy();
  });

  it.each([
    ["/login", "Log in"],
    ["/albums", "Albums"],
    ["/upload", "Upload"],
    ["/settings", "Settings"],
  ])("renders %s", async (url, heading) => {
    await renderAt(url);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  });

  it("passes route params to the viewer and album pages", async () => {
    await renderAt("/photos/01JB2Z3M4N5P6Q7R8S9T0V1W2X");
    expect(await screen.findByText("Photo 01JB2Z3M4N5P6Q7R8S9T0V1W2X")).toBeTruthy();
  });

  it("shows a not-found page for unknown paths", async () => {
    await renderAt("/nowhere");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});
