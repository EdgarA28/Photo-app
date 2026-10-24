import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorResponse } from "oidc-client-ts";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { AppConfig } from "../src/config";
import { createAppRouter, createQueryClient } from "../src/router";
import { fakeAuth, testConfig } from "./fakes";

afterEach(cleanup);

async function renderAt(
  url: string,
  { auth = fakeAuth({ signedIn: true }), config = testConfig as AppConfig } = {},
) {
  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient, auth, createMemoryHistory({ initialEntries: [url] }));
  render(<App config={config} queryClient={queryClient} router={router} />);
  await router.load();
  return { router, auth };
}

describe("routes (§12.1)", () => {
  it("redirects / to the gallery", async () => {
    const { router } = await renderAt("/");
    expect(router.state.location.pathname).toBe("/gallery");
    expect(await screen.findByRole("heading", { name: "Gallery" })).toBeTruthy();
  });

  it("defaults the gallery sort to taken-desc", async () => {
    const { router } = await renderAt("/gallery");
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
  });

  it("keeps valid gallery search params", async () => {
    const album = "01JB2Z3M4N5P6Q7R8S9T0V1W2X";
    const { router } = await renderAt(`/gallery?album=${album}&sort=taken-asc`);
    expect(router.state.location.search).toEqual({ album, sort: "taken-asc" });
  });

  it("drops invalid gallery search params instead of failing", async () => {
    const { router } = await renderAt("/gallery?album=nope&sort=random");
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
    expect(await screen.findByText("Sort: taken-desc")).toBeTruthy();
  });

  it.each([
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

  it("marks the current page in the navigation", async () => {
    await renderAt("/albums");
    const current = await screen.findByRole("link", { current: "page" });
    expect(current.textContent).toBe("Albums");
    expect(current.dataset.slot).toBe("button");
  });

  it("shows a not-found page for unknown paths", async () => {
    await renderAt("/nowhere");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("authentication guard (FR-AUTH-6)", () => {
  it.each(["/gallery?sort=taken-asc", "/photos/01JB2Z3M4N5P6Q7R8S9T0V1W2X", "/settings"])(
    "sends signed-out users from %s to /login, remembering the page",
    async (url) => {
      const { router } = await renderAt(url, { auth: fakeAuth() });
      expect(router.state.location.pathname).toBe("/login");
      expect(router.state.location.search).toEqual({ redirect: url });
    },
  );

  it("lets signed-in users through", async () => {
    const { router, auth } = await renderAt("/gallery");
    expect(router.state.location.pathname).toBe("/gallery");
    expect(auth.getUser).toHaveBeenCalled();
  });
});

describe("login page", () => {
  it.each([
    ["Continue with Google", "Google"],
    ["Continue with email", "email"],
  ])("%s starts a login that returns to the remembered page", async (name, provider) => {
    const { auth } = await renderAt("/login?redirect=%2Falbums", { auth: fakeAuth() });
    fireEvent.click(await screen.findByRole("button", { name }));
    expect(auth.login).toHaveBeenCalledWith({ provider, redirect: "/albums" });
    // No second request while the browser leaves for Cognito.
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("offers only email when Google isn't configured", async () => {
    await renderAt("/login", {
      auth: fakeAuth(),
      config: { ...testConfig, googleLogin: false },
    });
    expect(await screen.findByRole("button", { name: "Continue with email" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  });

  it("skips the login page when already signed in", async () => {
    const { router } = await renderAt("/login?redirect=%2Fupload");
    expect(router.state.location.pathname).toBe("/upload");
  });

  it("never redirects off the app", async () => {
    const { router } = await renderAt("/login?redirect=https%3A%2F%2Fevil.example");
    expect(router.state.location.href).toBe("/gallery?sort=taken-desc");
  });
});

describe("/auth/callback", () => {
  it("completes the login and continues to the remembered page", async () => {
    const auth = fakeAuth({ callbackTarget: "/albums" });
    const { router } = await renderAt("/auth/callback?code=c&state=s", { auth });
    expect(auth.completeLogin).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/albums");
  });

  it("explains a cancelled login and offers a retry", async () => {
    const auth = fakeAuth();
    auth.completeLogin.mockRejectedValueOnce(new ErrorResponse({ error: "access_denied" }));
    await renderAt("/auth/callback?error=access_denied&state=s", { auth });
    expect(await screen.findByText("The sign-in was cancelled.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/login");
  });

  it("shows other failures, e.g. a replayed or forged callback", async () => {
    const auth = fakeAuth();
    auth.completeLogin.mockRejectedValueOnce(new Error("No matching state found in storage"));
    await renderAt("/auth/callback?code=c&state=old", { auth });
    expect(await screen.findByText("No matching state found in storage")).toBeTruthy();
  });
});

describe("settings", () => {
  it("shows who is signed in and logs out", async () => {
    const { auth } = await renderAt("/settings");
    expect(await screen.findByText("user@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(auth.logout).toHaveBeenCalledOnce();
  });
});
