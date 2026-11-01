import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ErrorResponse } from "oidc-client-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { focusManager, onlineManager, type QueryClient } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { createIdbKeyValue, createPersistedQueryCache } from "../src/queries/persistedCache";
import { fakeApi, fakeAuth, fakeMedia, testConfig, testPhotoPage, testUser } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

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
    const { router } = await renderAt("/gallery?sort=taken-asc");
    expect(router.state.location.search).toEqual({ sort: "taken-asc" });
  });

  it("drops invalid gallery search params instead of failing", async () => {
    const { router } = await renderAt("/gallery?album=nope&sort=random");
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
    expect((await screen.findByRole("combobox", { name: "Sort order" })).textContent).toContain(
      "Newest first",
    );
  });

  it.each([
    ["/albums", "Albums"],
    ["/upload", "Upload"],
    ["/settings", "Settings"],
  ])("renders %s", async (url, heading) => {
    await renderAt(url);
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  });

  // jsdom applies no media queries, so both the side rail and the bottom bar are present.
  it("offers the sections and the map in both navigation bars", async () => {
    await renderAt("/gallery");
    const navs = await screen.findAllByRole("navigation", { name: "Main" });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      const links = within(nav).getAllByRole("link");
      expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
        ["Gallery", "/gallery"],
        ["Albums", "/albums"],
        ["Map", "/map"],
        ["Upload", "/upload"],
        ["Settings", "/settings"],
      ]);
    }
  });

  it.each([
    ["/albums", "Albums"],
    ["/albums/01JB2Z3M4N5P6Q7R8S9T0V1W2X", "Albums"],
    ["/gallery?sort=taken-asc", "Gallery"],
    ["/settings", "Settings"],
  ])("marks the current section on %s", async (url, label) => {
    await renderAt(url);
    for (const nav of await screen.findAllByRole("navigation", { name: "Main" })) {
      const current = within(nav).getAllByRole("link", { current: "page" });
      expect(current.map((link) => link.textContent)).toEqual([label]);
    }
  });

  // 7.3: the first images would fail with 403 without the cookies.
  it("renders signed-in pages only once the media cookies are ready", async () => {
    let release!: () => void;
    const media = {
      ensure: vi.fn(async () => {}),
      ready: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
      clear: vi.fn(async () => {}),
    };
    const rendered = renderAt("/gallery", { media });
    await waitFor(() => expect(media.ready).toHaveBeenCalledWith(testUser.sub));
    expect(screen.queryByRole("heading", { name: "Gallery" })).toBeNull();

    release();
    await rendered;
    expect(await screen.findByRole("heading", { name: "Gallery" })).toBeTruthy();
  });

  it("doesn't ask for media cookies without a session", async () => {
    const media = fakeMedia();
    await renderAt("/gallery", { auth: fakeAuth(), media });
    expect(media.ready).not.toHaveBeenCalled();
  });

  it("shows the signed-in email in the side rail", async () => {
    await renderAt("/gallery");
    expect(await screen.findByText(testUser.email!)).toBeTruthy();
  });

  it("shows a not-found page for unknown paths", async () => {
    await renderAt("/nowhere");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("authentication guard (FR-AUTH-6)", () => {
  // The viewer, like the gallery, puts its default `sort` in the URL.
  it.each([
    "/gallery?sort=taken-asc",
    "/photos/01JB2Z3M4N5P6Q7R8S9T0V1W2X?sort=taken-desc",
    "/settings",
  ])("sends signed-out users from %s to /login, remembering the page", async (url) => {
    const { router } = await renderAt(url, { auth: fakeAuth() });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: url });
  });

  it("lets signed-in users through", async () => {
    const { router, auth } = await renderAt("/gallery");
    expect(router.state.location.pathname).toBe("/gallery");
    expect(auth.getStoredUser).toHaveBeenCalled();
  });

  // 8.25b: the token refresh is the first API call's business, not the guard's.
  it("opens the app from the stored session without waiting for Cognito", async () => {
    const auth = fakeAuth({ signedIn: true });
    auth.getUser.mockReturnValue(new Promise(() => {}));
    await renderAt("/gallery", { auth });
    expect(await screen.findByRole("heading", { name: "Gallery" })).toBeTruthy();
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("restores the saved cache while the media cookies are requested (8.25b)", async () => {
    const media = { ...fakeMedia(), ready: vi.fn(() => new Promise<void>(() => {})) };
    const persistedCache = { start: vi.fn(() => new Promise<void>(() => {})), clear: vi.fn() };
    void renderAt("/gallery", { media, persistedCache });
    await waitFor(() => expect(media.ready).toHaveBeenCalled());
    expect(persistedCache.start).toHaveBeenCalledWith(testUser.sub);
  });

  it("deletes the saved cache when the session has ended without a logout (9.3)", async () => {
    const { persistedCache } = await renderAt("/gallery", { auth: fakeAuth() });
    expect(persistedCache.clear).toHaveBeenCalled();
    expect(persistedCache.start).not.toHaveBeenCalled();
  });

  it("restores the user's saved cache before the page loads (9.3)", async () => {
    const { persistedCache } = await renderAt("/gallery");
    expect(persistedCache.start).toHaveBeenCalledWith(testUser.sub);
  });
});

describe("offline start (9.3, FR-PWA-2)", () => {
  const offline = () => new TypeError("Failed to fetch");

  it("opens the gallery with the last saved photos when Cognito can't be reached", async () => {
    const storage = createIdbKeyValue(new IDBFactory());
    const persisted = (queryClient: QueryClient) =>
      createPersistedQueryCache(queryClient, { storage, throttleTime: 0 });
    // Online: the gallery loads and is saved.
    await renderAt("/gallery", {
      api: fakeApi({ ...defaultResponses, "GET /photos": testPhotoPage(0, 2) }).api,
      persistedCache: persisted,
    });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    await vi.waitFor(async () => expect(await storage.getItem("query-client")).toBeTruthy());
    cleanup();

    // Restart offline: the token refresh fails, and so would every API call.
    const auth = fakeAuth({ signedIn: true });
    auth.getUser.mockRejectedValue(offline());
    // The browser knows it's offline: Query pauses the refresh of the restored list.
    onlineManager.setOnline(false);
    try {
      const { api, request } = fakeApi({});
      const { router } = await renderAt("/gallery", { auth, api, persistedCache: persisted });
      expect(router.state.location.pathname).toBe("/gallery");
      expect(await screen.findByRole("link", { name: "IMG_1.jpg" })).toBeTruthy();
      expect(request.mock.calls.filter(([, path]) => path === "/photos")).toEqual([]);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("refetches a restored list from the first page, without a cursor", async () => {
    const storage = createIdbKeyValue(new IDBFactory());
    const persisted = (queryClient: QueryClient) =>
      createPersistedQueryCache(queryClient, { storage, throttleTime: 0 });
    await renderAt("/gallery", {
      api: fakeApi({ ...defaultResponses, "GET /photos": testPhotoPage(0, 2) }).api,
      persistedCache: persisted,
    });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    await vi.waitFor(async () => expect(await storage.getItem("query-client")).toBeTruthy());
    cleanup();

    // Restart after the saved list went stale (staleTime 10 min), so it refetches. The first
    // page's param is `undefined`, which JSON stores as `null`: sent as `?cursor=null` → 400.
    const later = Date.now() + 11 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const { api, request } = fakeApi({ ...defaultResponses, "GET /photos": testPhotoPage(0, 2) });
    await renderAt("/gallery", { api, persistedCache: persisted });
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([, path]) => path === "/photos").length).toBeGreaterThan(0),
    );
    for (const [, path, options] of request.mock.calls) {
      if (path === "/photos") expect(options?.query?.cursor).toBeUndefined();
    }
    vi.restoreAllMocks();
  });

  it("shows a restored list at once, then refreshes it even if it was saved moments ago", async () => {
    const storage = createIdbKeyValue(new IDBFactory());
    const persisted = (queryClient: QueryClient) =>
      createPersistedQueryCache(queryClient, { storage, throttleTime: 0 });
    await renderAt("/gallery", {
      api: fakeApi({ ...defaultResponses, "GET /photos": testPhotoPage(0, 2) }).api,
      persistedCache: persisted,
    });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    await vi.waitFor(async () => expect(await storage.getItem("query-client")).toBeTruthy());
    cleanup();

    // Photo 1 was deleted on another device in the meantime.
    const { api, request } = fakeApi({ ...defaultResponses, "GET /photos": testPhotoPage(0, 1) });
    await renderAt("/gallery", { api, persistedCache: persisted });
    await vi.waitFor(() => expect(screen.queryByRole("link", { name: "IMG_1.jpg" })).toBeNull());
    expect(request.mock.calls.some(([, path]) => path === "/photos")).toBe(true);
  });

  it("shows the error page when offline without a stored session", async () => {
    const auth = fakeAuth();
    auth.getUser.mockRejectedValue(offline());
    const { router } = await renderAt("/gallery", { auth });
    expect(router.state.location.pathname).toBe("/gallery");
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeTruthy();
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
  // The settings page itself (usage, username, logout): test/settings.test.tsx.

  it("shows API errors with a readable message", async () => {
    const api = fakeApi({
      ...defaultResponses,
      "GET /me": new ApiRequestError("INTERNAL_ERROR", "Internal server error", 500),
    }).api;
    await renderAt("/settings", { api });
    expect(
      await screen.findByText("Something went wrong on our side. Try again later."),
    ).toBeTruthy();
  });
});

describe("session and connection messages (8.14)", () => {
  it("says why the login page appeared when the session was rejected", async () => {
    await renderAt("/login?reason=expired", { auth: fakeAuth() });
    expect((await screen.findByRole("status")).textContent).toBe(
      "Your session has ended. Please log in again.",
    );
  });

  it("shows no message on a normal visit to the login page", async () => {
    await renderAt("/login", { auth: fakeAuth() });
    await screen.findByRole("button", { name: "Continue with email" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows an offline banner while the browser is offline", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await renderAt("/gallery");
    expect((await screen.findByText(/You're offline/)).textContent).toBe(
      "You're offline. Some things won't load until you're back online.",
    );

    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(screen.queryByText(/You're offline/)).toBeNull());
    onLine.mockRestore();
  });
});

describe("coming back to the app", () => {
  it("refreshes the gallery, even when its data is still fresh", async () => {
    const pages = [testPhotoPage(0, 2), testPhotoPage(0, 1)];
    const { api, request } = fakeApi({ ...defaultResponses, "GET /photos": () => pages.shift() });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });

    // Away (another app, another tab) while a photo is deleted elsewhere; then back.
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await vi.waitFor(() => expect(screen.queryByRole("link", { name: "IMG_1.jpg" })).toBeNull());
    expect(request.mock.calls.filter(([, path]) => path === "/photos")).toHaveLength(2);
    focusManager.setFocused(undefined);
  });
});
