import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  BATCH_POLL_MS,
  PROCESSING_POLL_MS,
  PROCESSING_WINDOW_MS,
  processingPollInterval,
  refreshAfterUpload,
  setUploadsRunning,
} from "../src/queries/photos";
import { fakeApi, testId, testMe, testPhoto, testPhotoPage } from "./fakes";
import { REMOTE_CHANGES_POLL_MS } from "../src/queries/remoteChanges";
import { defaultResponses, renderAt } from "./render";
import { LONG_PRESS_MS } from "../src/gallery/useDragSelect";
import { createBrowserHistory } from "@tanstack/react-router";

afterEach(cleanup);

const album = { albumId: testId(900), name: "Holidays", createdAt: "2026-10-01T10:00:00.000Z" };
const albums = {
  items: [{ ...album, coverPhotoId: null, coverThumbUrl: null, photoCount: 2 }],
};

function setup(responses: Record<string, unknown>) {
  return fakeApi({ ...defaultResponses, "GET /albums": albums, ...responses });
}

/** Query of every request the gallery made to `path`. */
const queriesTo = (request: ReturnType<typeof fakeApi>["request"], path: string) =>
  request.mock.calls.filter(([, p]) => p === path).map(([, , options]) => options?.query);

const tiles = () => screen.queryAllByRole("link", { name: /^IMG_/ });

describe("Videos section (FR-VID-11)", () => {
  const video = (n: number) =>
    testPhoto(n, {
      fileName: `CLIP_${n}.mp4`,
      mediaType: "video",
      contentType: "video/mp4",
      videoUrl: `/users/u/originals/${testId(n)}.mp4`,
      durationMs: 65_000,
    });

  it("lists own videos apart from the Gallery, and its tiles open the viewer in that list", async () => {
    const { api, request } = setup({
      "GET /photos": (query: { mediaType?: string } | undefined) =>
        query?.mediaType === "video"
          ? { items: [video(5)], nextCursor: null }
          : testPhotoPage(0, 1),
    });
    await renderAt("/videos", { api });

    expect(await screen.findByRole("heading", { name: "Videos" })).toBeTruthy();
    // FR-VID-4: the tile says it's a video and how long; the badge shows it.
    const link = await screen.findByRole("link", { name: "CLIP_5.mp4, Video, 1:05" });
    expect(link.querySelector("[data-video-badge]")?.textContent).toBe("1:05");
    expect(link.getAttribute("href")).toBe(`/photos/${testId(5)}?sort=taken-desc&mediaType=video`);
    expect(screen.queryByRole("link", { name: "IMG_0.jpg" })).toBeNull();
    expect(queriesTo(request, "/photos")).toEqual([
      { sort: "taken-desc", cursor: undefined, mediaType: "video" },
    ]);
    // The map covers places; no place search here.
    expect(screen.queryByRole("combobox", { name: "Search places" })).toBeNull();
  });

  it("a video that couldn't be processed has no badge", async () => {
    const { api } = setup({
      "GET /photos": {
        items: [{ ...video(5), status: "failed", durationMs: null, thumbUrl: null }],
        nextCursor: null,
      },
    });
    await renderAt("/videos", { api });
    const link = await screen.findByRole("link", {
      name: "CLIP_5.mp4, Video, couldn't be processed",
    });
    expect(link.querySelector("[data-video-badge]")).toBeNull();
  });

  it("an empty Videos section says so and links to the upload page", async () => {
    const { api } = setup({ "GET /photos": { items: [], nextCursor: null } });
    await renderAt("/videos", { api });
    expect(await screen.findByText("No videos yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload videos" }).getAttribute("href")).toBe(
      "/upload",
    );
  });
});

describe("gallery (FR-GAL-1/2/3)", () => {
  it("shows the photos as thumbnail links to the viewer, newest first by default", async () => {
    const { api, request } = setup({ "GET /photos": testPhotoPage(0, 3) });
    await renderAt("/gallery", { api });

    const links = await screen.findAllByRole("link", { name: /^IMG_/ });
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "IMG_0.jpg",
      "IMG_1.jpg",
      "IMG_2.jpg",
    ]);
    // The viewer walks the Gallery's photos (FR-VID-11: videos have their own list).
    expect(links[0]!.getAttribute("href")).toBe(
      `/photos/${testId(0)}?sort=taken-desc&mediaType=photo`,
    );
    expect(links[0]!.querySelector("img")!.getAttribute("src")).toBe(testPhoto(0).thumbUrl);
    expect(queriesTo(request, "/photos")).toEqual([{ sort: "taken-desc", cursor: undefined }]);
  });

  it("reserves each tile's size from width/height before the image loads", async () => {
    const { api } = setup({
      "GET /photos": {
        items: [testPhoto(0, { width: 3000, height: 1000 }), testPhoto(1)],
        nextCursor: null,
      },
    });
    await renderAt("/gallery", { api });
    const [wide, normal] = await screen.findAllByRole("link", { name: /^IMG_/ });
    // An unfilled last row keeps the 192 px target height: 3:1 → 576 px, 4:3 → 256 px.
    expect(wide!.style.width).toBe("576px");
    expect(normal!.style.width).toBe("256px");
  });

  it("renders only the rows near the viewport (NFR-PERF-3)", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 200) });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_0.jpg" });
    expect(tiles().length).toBeGreaterThan(0);
    expect(tiles().length).toBeLessThan(100);
    expect(screen.queryByRole("link", { name: "IMG_199.jpg" })).toBeNull();
  });

  it("loads the next page with the cursor when the end comes into view", async () => {
    const { api, request } = setup({
      "GET /photos": (query: { cursor?: string }) =>
        query.cursor === "page-2" ? testPhotoPage(10, 10) : testPhotoPage(0, 10, "page-2"),
    });
    await renderAt("/gallery", { api });
    expect(await screen.findByRole("link", { name: "IMG_19.jpg" })).toBeTruthy();
    expect(queriesTo(request, "/photos")).toEqual([
      { sort: "taken-desc", cursor: undefined },
      { sort: "taken-desc", cursor: "page-2" },
    ]);
  });

  it("offers a retry when the next page fails", async () => {
    let fail = true;
    const { api } = setup({
      "GET /photos": (query: { cursor?: string }) => {
        if (!query.cursor) return testPhotoPage(0, 10, "page-2");
        return fail ? new ApiRequestError("NOT_FOUND", "Gone", 404) : testPhotoPage(10, 1);
      },
    });
    await renderAt("/gallery", { api });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("More photos couldn't be loaded.");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "IMG_10.jpg" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("month headings (§12.3)", () => {
  const monthOf = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(iso));
  const october = "2026-10-15T12:00:00.000Z";
  const september = "2026-09-15T12:00:00.000Z";
  const page = {
    items: [
      testPhoto(0, { takenAt: october }),
      testPhoto(1, { takenAt: october }),
      testPhoto(2, { takenAt: september }),
    ],
    nextCursor: null,
  };

  it("puts a heading above each month, and a month's photos never share a row", async () => {
    const { api } = setup({ "GET /photos": page });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_2.jpg" });

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([monthOf(october), monthOf(september)]);
    // Document order: October heading, its two photos, September heading, its photo.
    const order = [...document.querySelectorAll("h2, a[aria-label^='IMG_']")].map(
      (el) => el.textContent || el.getAttribute("aria-label"),
    );
    expect(order).toEqual([
      monthOf(october),
      "IMG_0.jpg",
      "IMG_1.jpg",
      monthOf(september),
      "IMG_2.jpg",
    ]);
    const rowOf = (name: string) => screen.getByRole("link", { name }).parentElement;
    expect(rowOf("IMG_1.jpg")).toBe(rowOf("IMG_0.jpg"));
    expect(rowOf("IMG_2.jpg")).not.toBe(rowOf("IMG_1.jpg"));
  });

  it("has them in an album list too, which is by date taken as well", async () => {
    const { api } = setup({ [`GET /albums/${album.albumId}/photos`]: page });
    await renderAt(`/gallery?album=${album.albumId}`, { api });
    await screen.findByRole("link", { name: "IMG_2.jpg" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      monthOf(october),
      monthOf(september),
    ]);
  });
});

describe("processing and failed photos (FR-GAL-5)", () => {
  const pending = (n: number, uploadedAt = new Date().toISOString()) =>
    testPhoto(n, { status: "pending", width: null, height: null, thumbUrl: null, uploadedAt });

  afterEach(() => vi.useRealTimers());

  it("doesn't show photos still processing: they appear once ready (user, 2026-11-01)", async () => {
    const { api } = setup({
      "GET /photos": { items: [pending(0), testPhoto(1)], nextCursor: null },
    });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    expect(screen.queryByRole("link", { name: /IMG_0\.jpg/ })).toBeNull();
    expect(document.querySelector("svg.lucide-loader-circle")).toBeNull();
  });

  it("refetches while a photo is processing and shows it once ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let ready = false;
    const { api, request } = setup({
      "GET /photos": () => ({ items: [ready ? testPhoto(0) : pending(0)], nextCursor: null }),
    });
    await renderAt("/gallery", { api });
    // Nothing shown while it processes, but the gallery keeps asking.
    await waitFor(() => expect(queriesTo(request, "/photos").length).toBeGreaterThan(0));
    expect(screen.queryByRole("link", { name: /IMG_0\.jpg/ })).toBeNull();
    ready = true;
    await vi.advanceTimersByTimeAsync(PROCESSING_POLL_MS);
    const tile = await screen.findByRole("link", { name: "IMG_0.jpg" });
    expect(tile.querySelector("img")).not.toBeNull();
    const calls = queriesTo(request, "/photos").length;
    await vi.advanceTimersByTimeAsync(PROCESSING_POLL_MS * 3);
    expect(queriesTo(request, "/photos")).toHaveLength(calls);
  });
});

describe("processingPollInterval", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const pageOf = (...items: ReturnType<typeof testPhoto>[]) =>
    ({ pages: [{ items, nextCursor: null }], pageParams: [undefined] }) as never;
  const uploaded = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("polls while a recent upload is pending", () => {
    const data = pageOf(
      testPhoto(0),
      testPhoto(1, { status: "pending", uploadedAt: uploaded(5000) }),
    );
    expect(processingPollInterval(data, now)).toBe(PROCESSING_POLL_MS);
  });

  it("stops for ready/failed photos and for abandoned uploads", () => {
    expect(processingPollInterval(undefined, now)).toBe(false);
    expect(processingPollInterval(pageOf(testPhoto(0, { status: "failed" })), now)).toBe(false);
    const stale = testPhoto(0, { status: "pending", uploadedAt: uploaded(PROCESSING_WINDOW_MS) });
    expect(processingPollInterval(pageOf(stale), now)).toBe(false);
  });

  it("polls slowly while uploads run, processing or not (13.1j)", () => {
    const processing = pageOf(testPhoto(0, { status: "pending", uploadedAt: uploaded(5000) }));
    expect(processingPollInterval(processing, now, true)).toBe(BATCH_POLL_MS);
    expect(processingPollInterval(pageOf(testPhoto(0)), now, true)).toBe(BATCH_POLL_MS);
    expect(processingPollInterval(undefined, now, true)).toBe(BATCH_POLL_MS);
  });
});

describe("refreshAfterUpload (13.1j)", () => {
  async function observed() {
    const queryClient = new QueryClient();
    const photos = vi.fn(async () => "photos");
    const me = vi.fn(async () => "me");
    const unsubscribe = [
      new QueryObserver(queryClient, {
        queryKey: ["photos", { sort: "taken-desc" }],
        queryFn: photos,
      }),
      new QueryObserver(queryClient, { queryKey: ["me"], queryFn: me }),
    ].map((observer) => observer.subscribe(() => {}));
    await waitFor(() => expect(photos).toHaveBeenCalledOnce());
    await waitFor(() => expect(me).toHaveBeenCalledOnce());
    return { queryClient, photos, me, unsubscribe };
  }

  it("only marks the lists and usage stale while more uploads are going", async () => {
    const { queryClient, photos, me, unsubscribe } = await observed();
    await refreshAfterUpload(queryClient, true);
    expect(photos).toHaveBeenCalledOnce();
    expect(me).toHaveBeenCalledOnce();
    expect(queryClient.getQueryState(["me"])?.isInvalidated).toBe(true);
    unsubscribe.forEach((stop) => stop());
  });

  it("refetches what is on screen after the last upload", async () => {
    const { queryClient, photos, me, unsubscribe } = await observed();
    await refreshAfterUpload(queryClient, false);
    expect(photos).toHaveBeenCalledTimes(2);
    expect(me).toHaveBeenCalledTimes(2);
    unsubscribe.forEach((stop) => stop());
  });
});

describe("gallery while uploads run (13.1j)", () => {
  afterEach(() => {
    setUploadsRunning(() => false);
    vi.useRealTimers();
  });

  it("refetches every BATCH_POLL_MS instead of every few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setUploadsRunning(() => true);
    const { api, request } = setup({
      "GET /photos": () => ({
        items: [
          testPhoto(1),
          testPhoto(0, { status: "pending", uploadedAt: new Date().toISOString() }),
        ],
        nextCursor: null,
      }),
    });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    const before = queriesTo(request, "/photos").length;
    await vi.advanceTimersByTimeAsync(BATCH_POLL_MS - PROCESSING_POLL_MS);
    expect(queriesTo(request, "/photos")).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(PROCESSING_POLL_MS);
    await waitFor(() => expect(queriesTo(request, "/photos")).toHaveLength(before + 1));
  });

  it("doesn't reload places on every usage change while uploads run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setUploadsRunning(() => true);
    let count = 1;
    const { api, request } = setup({
      "GET /photos": testPhotoPage(0, 1),
      "GET /me": () => ({ ...testMe, usage: { ...testMe.usage, photoCount: count++ } }),
    });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_0.jpg" });
    const places = () => queriesTo(request, "/places").length;
    const before = places();
    await vi.advanceTimersByTimeAsync(REMOTE_CHANGES_POLL_MS * 2);
    expect(places()).toBe(before);
  });
});

describe("gallery fallbacks", () => {
  it("falls back to the placeholder when a thumbnail can't load", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 1) });
    await renderAt("/gallery", { api });
    const tile = await screen.findByRole("link", { name: "IMG_0.jpg" });
    fireEvent.error(tile.querySelector("img")!);
    expect(tile.querySelector("img")).toBeNull();
  });

  it("invites the first upload when there are no photos", async () => {
    await renderAt("/gallery", { api: setup({}).api });
    expect(await screen.findByText("No photos yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload photos" }).getAttribute("href")).toBe(
      "/upload",
    );
  });
});

describe("gallery filters in the URL (FR-GAL-3)", () => {
  it("changes the sort order through the URL", async () => {
    const { api, request } = setup({ "GET /photos": testPhotoPage(0, 1) });
    const { router } = await renderAt("/gallery", { api });
    await chooseOption("Sort order", "Oldest first");
    await waitFor(() => expect(router.state.location.search).toEqual({ sort: "taken-asc" }));
    await waitFor(() =>
      expect(queriesTo(request, "/photos")).toContainEqual({
        sort: "taken-asc",
        cursor: undefined,
      }),
    );
  });

  it("has no album menu, only the sort order (user request 2026-11-01)", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 1) });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_0.jpg" });
    expect(screen.queryByRole("combobox", { name: "Album" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Sort order" })).toBeTruthy();
  });

  it("opens an old album link on the album's own page", async () => {
    const { api } = setup({ [`GET /albums/${album.albumId}/photos`]: testPhotoPage(50, 2) });
    const { router } = await renderAt(`/gallery?album=${album.albumId}&sort=taken-asc`, { api });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/albums/${album.albumId}`));
    expect(await screen.findByRole("heading", { name: "Holidays" })).toBeTruthy();
  });
});

describe("press and slide to select (8.11)", () => {
  const X = 100; // tile n is under x = n * X (layout is stubbed in jsdom)
  const tileNamed = (n: number) => screen.getByLabelText(`IMG_${n}.jpg`);
  const toolbar = () => screen.queryByRole("toolbar")?.textContent;
  const pressed = () =>
    screen
      .queryAllByRole("button", { pressed: true })
      .map((tile) => tile.getAttribute("aria-label"));

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  /**
   * A touch on tile `from`, held for `hold` ms, then slid over tiles `over` and lifted; the menu
   * and the click go to what is under the finger by then, as in a browser. Fake timers from here.
   */
  function gesture(from: number, { hold = LONG_PRESS_MS, over = [] as number[], early = 0 } = {}) {
    document.elementFromPoint = (x: number) => tileNamed(Math.round(x / X));
    vi.useFakeTimers();
    const at = (n: number) => ({ clientX: n * X, clientY: 10, pointerId: 1, isPrimary: true });
    const touched = tileNamed(from);
    fireEvent.pointerDown(touched, { ...at(from), button: 0, pointerType: "touch" });
    if (early) fireEvent.pointerMove(window, { ...at(from), clientY: 10 + early });
    act(() => vi.advanceTimersByTime(hold));
    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    tileNamed(from).dispatchEvent(touchMove);
    for (const n of over) act(() => void fireEvent.pointerMove(window, at(n)));
    // A touch whose target leaves the DOM gets no more events in a browser.
    const kept = touched.isConnected;
    const last = over.at(-1) ?? from;
    const menu = fireEvent.contextMenu(tileNamed(last));
    act(() => void fireEvent.pointerUp(window, at(last)));
    const clicked = fireEvent.click(tileNamed(last), { detail: 1 });
    return { menu, clicked, kept, scrollPrevented: touchMove.defaultPrevented };
  }

  it("picks the held photo, starting select mode, without opening it", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 6) });
    const { router } = await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    const { menu, clicked, kept, scrollPrevented } = gesture(1);
    expect(kept).toBe(true);

    expect(menu).toBe(false); // Android's image/link menu
    expect(clicked).toBe(false); // the click that ends the press
    expect(scrollPrevented).toBe(true);
    expect(router.state.location.pathname).toBe("/gallery");
    expect(toolbar()).toContain("1 selected");
    expect(pressed()).toEqual(["IMG_1.jpg"]);
    // Then taps toggle, as in select mode.
    fireEvent.click(tileNamed(4));
    expect(pressed()).toEqual(["IMG_1.jpg", "IMG_4.jpg"]);
  });

  it("picks every photo it slides over, and unpicks them sliding back", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 6) });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    gesture(1, { over: [2, 4, 3] });
    expect(pressed()).toEqual(["IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg"]);
    expect(toolbar()).toContain("3 selected");
  });

  it("in select mode, starting on a picked photo unpicks the range", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 6) });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    gesture(0, { over: [4] });
    vi.useRealTimers();
    expect(gesture(3, { over: [2] }).kept).toBe(true);
    expect(pressed()).toEqual(["IMG_0.jpg", "IMG_1.jpg", "IMG_4.jpg"]);
    // Starting on an unpicked one picks again.
    vi.useRealTimers();
    gesture(5);
    expect(pressed()).toEqual(["IMG_0.jpg", "IMG_1.jpg", "IMG_4.jpg", "IMG_5.jpg"]);
  });

  it("is a plain tap when let go early, and nothing when the finger scrolls", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 3) });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    const scroll = gesture(1, { early: 30 });
    expect(scroll.menu).toBe(true);
    expect(scroll.scrollPrevented).toBe(false);
    expect(toolbar()).toBeUndefined();
    vi.useRealTimers();
    // Not swallowed: the link opens the viewer (covered by the viewer tests).
    expect(gesture(1, { hold: LONG_PRESS_MS - 100 }).clicked).toBe(false);
    expect(toolbar()).toBeUndefined();
  });
});

describe("the Select button (8.11)", () => {
  it("turns into Unselect all in select mode, which unpicks everything and leaves it", async () => {
    const { api } = setup({ "GET /photos": testPhotoPage(0, 3) });
    await renderAt("/gallery", { api });
    const button = await screen.findByRole("button", { name: "Select" });
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole("button", { name: "IMG_0.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "IMG_2.jpg" }));

    // The same element, so the header (and the grid below it) doesn't move.
    expect(screen.getByRole("button", { name: "Unselect all" })).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(screen.queryAllByRole("button", { pressed: true })).toEqual([]);
    expect(screen.getByRole("button", { name: "Select" })).toBe(button);
  });
});

describe("leaving select mode with Back (8.11)", () => {
  let history: ReturnType<typeof createBrowserHistory> | undefined;
  afterEach(() => history?.destroy());

  /** The app in the window's own history, opened on `url`, in select mode with one photo. */
  async function selecting(url: string) {
    window.history.replaceState(null, "", url);
    history = createBrowserHistory();
    const { api } = setup({ "GET /photos": testPhotoPage(0, 3) });
    const { router } = await renderAt("", { api, history });
    if (url !== "/gallery") await router.navigate({ to: "/gallery" });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("button", { name: "IMG_1.jpg" }));
    return router;
  }

  it("ends select mode instead of leaving the page", async () => {
    const router = await selecting("/settings");
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(await screen.findByRole("link", { name: "IMG_1.jpg" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/gallery");

    // Out of select mode, Back leaves as usual.
    window.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });

  it("also when the app was opened on this page (Back would close it)", async () => {
    const router = await selecting("/gallery");
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(router.state.location.pathname).toBe("/gallery");
    // Selecting again works the same way.
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    await screen.findByRole("toolbar");
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(router.state.location.pathname).toBe("/gallery");
  });

  it("takes its history entry off when select mode ends otherwise", async () => {
    const router = await selecting("/settings");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    await waitFor(() => expect(window.history.state?.photoAppSelectMode).toBeUndefined());
    window.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });
});

describe("deleting selected photos (FR-DEL-1/2)", () => {
  const deletes = (request: ReturnType<typeof fakeApi>["request"]) =>
    request.mock.calls.filter(([method]) => method === "DELETE").map(([, path]) => path);
  const tile = (name: string) => screen.findByRole("button", { name });

  async function selectAndConfirm(names: string[], title: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    for (const name of names) fireEvent.click(await tile(name));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    return screen.findByRole("alertdialog", { name: title });
  }

  it("asks for confirmation and does nothing when cancelled", async () => {
    const { api, request } = setup({ "GET /photos": testPhotoPage(0, 3) });
    await renderAt("/gallery", { api });
    const dialog = await selectAndConfirm(
      ["IMG_0.jpg", "IMG_2.jpg"],
      "Move 2 photos to the trash?",
    );
    expect(dialog.textContent).toContain("They will be removed from your library");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletes(request)).toEqual([]);
    expect(screen.getByRole("toolbar").textContent).toContain("2 selected");
  });

  it("deletes every selected photo and leaves select mode", async () => {
    const gone = new Set<string>();
    const { api, request } = setup({
      "GET /photos": () => ({
        items: testPhotoPage(0, 3).items.filter((p) => !gone.has(p.photoId)),
        nextCursor: null,
      }),
      [`DELETE /photos/${testId(0)}`]: () => void gone.add(testId(0)),
      [`DELETE /photos/${testId(2)}`]: () => void gone.add(testId(2)),
    });
    await renderAt("/gallery", { api });
    const dialog = await selectAndConfirm(
      ["IMG_0.jpg", "IMG_2.jpg"],
      "Move 2 photos to the trash?",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    expect((await screen.findByRole("status")).textContent).toBe("Moved 2 photos to the trash.");
    expect(deletes(request)).toEqual([`/photos/${testId(0)}`, `/photos/${testId(2)}`]);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(tiles().map((t) => t.getAttribute("aria-label"))).toEqual(["IMG_1.jpg"]);
  });

  it("says that uploads still processing aren't included (dev, 2026-11-01)", async () => {
    const processing = (n: number) =>
      testPhoto(n, {
        status: "pending",
        width: null,
        height: null,
        thumbUrl: null,
        uploadedAt: new Date().toISOString(),
      });
    // An abandoned upload (pending for long) is not "processing" and isn't mentioned.
    const abandoned = testPhoto(9, {
      status: "pending",
      width: null,
      height: null,
      thumbUrl: null,
      uploadedAt: new Date(Date.now() - PROCESSING_WINDOW_MS - 1000).toISOString(),
    });
    const { api } = setup({
      "GET /photos": {
        items: [testPhoto(0), processing(5), processing(6), abandoned],
        nextCursor: null,
      },
      [`DELETE /photos/${testId(0)}`]: undefined,
    });
    await renderAt("/gallery", { api });
    const dialog = await selectAndConfirm(["IMG_0.jpg"], "Move this photo to the trash?");
    expect(dialog.textContent).toContain(
      "2 photos still processing aren't included and will appear in the gallery when ready.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Moved 1 photo to the trash. 2 photos still processing aren't included and will appear in the gallery when ready.",
    );
  });

  it("keeps the failed photos selected and retries only those", async () => {
    let fail = true;
    const { api, request } = setup({
      "GET /photos": testPhotoPage(0, 3),
      [`DELETE /photos/${testId(0)}`]: undefined,
      [`DELETE /photos/${testId(1)}`]: () => {
        if (fail) throw new ApiRequestError("INTERNAL_ERROR", "x", 500);
      },
      // Already deleted elsewhere: counts as done.
      [`DELETE /photos/${testId(2)}`]: new ApiRequestError("NOT_FOUND", "x", 404),
    });
    await renderAt("/gallery", { api });
    const dialog = await selectAndConfirm(
      ["IMG_0.jpg", "IMG_1.jpg", "IMG_2.jpg"],
      "Move 3 photos to the trash?",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "1 photo couldn't be moved: Something went wrong on our side. Try again later.",
    );
    expect(within(dialog).getByRole("heading").textContent).toBe("Move this photo to the trash?");

    fail = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("status")).textContent).toBe("Moved 3 photos to the trash.");
    expect(deletes(request)).toEqual([
      `/photos/${testId(0)}`,
      `/photos/${testId(1)}`,
      `/photos/${testId(2)}`,
      `/photos/${testId(1)}`,
    ]);
  });
});

/** Opens the Radix select labelled `label` and picks `option`. */
async function chooseOption(label: string, option: string) {
  const trigger = await screen.findByRole("combobox", { name: label });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("changes made on another device", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a photo uploaded elsewhere while the gallery stays on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let uploadedElsewhere = false;
    const { api } = setup({
      "GET /photos": () => (uploadedElsewhere ? testPhotoPage(0, 2) : testPhotoPage(1, 1)),
      "GET /me": () => ({
        ...testMe,
        usage: { ...testMe.usage, photoCount: uploadedElsewhere ? 2 : 1 },
      }),
    });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_1.jpg" });
    expect(screen.queryByRole("link", { name: "IMG_0.jpg" })).toBeNull();

    uploadedElsewhere = true;
    await vi.advanceTimersByTimeAsync(REMOTE_CHANGES_POLL_MS);
    expect(await screen.findByRole("link", { name: "IMG_0.jpg" })).toBeTruthy();
  });

  it("doesn't reload the photos while nothing changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, request } = setup({ "GET /photos": testPhotoPage(0, 1) });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_0.jpg" });
    const photoCalls = () => request.mock.calls.filter(([, path]) => path === "/photos").length;
    const before = photoCalls();

    await vi.advanceTimersByTimeAsync(REMOTE_CHANGES_POLL_MS * 3);
    expect(request.mock.calls.filter(([, path]) => path === "/me").length).toBeGreaterThan(2);
    expect(photoCalls()).toBe(before);
  });
});

describe("pinch to resize the tiles (FR-GAL-8)", () => {
  // 1000 px wide in jsdom (setup.ts): the wider screens' heights; a 4:3 tile alone in its row is
  // 4/3 × the target height.
  const tileWidth = async () =>
    parseFloat((await screen.findByRole("link", { name: "IMG_0.jpg" })).style.width);
  const grid = () => screen.getByRole("link", { name: "IMG_0.jpg" }).closest(".touch-pan-y")!;
  const one = () => setup({ "GET /photos": { items: [testPhoto(0)], nextCursor: null } });

  /** Two fingers `from` px apart, moved to each of `to` (px apart), then lifted. */
  function pinch(from: number, ...to: number[]) {
    const fingers = (d: number) => ({
      touches: [
        { clientX: 500 - d / 2, clientY: 50 },
        { clientX: 500 + d / 2, clientY: 50 },
      ],
    });
    fireEvent.touchStart(grid(), fingers(from));
    const moves = to.map((d) => {
      const event = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.assign(event, fingers(d));
      act(() => void grid().dispatchEvent(event));
      return event;
    });
    fireEvent.touchEnd(grid(), { touches: [] });
    return moves;
  }

  afterEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(document, "elementFromPoint");
    vi.restoreAllMocks();
  });

  it("fingers apart make the tiles bigger, a step per 25 %, several in one gesture", async () => {
    await renderAt("/gallery", { api: one().api });
    expect(await tileWidth()).toBe(256); // 192 px rows

    const [first] = pinch(100, 120, 130);
    expect(await tileWidth()).toBeCloseTo((272 * 4) / 3); // 130 / 100 ≥ 1.25: one step
    // The browser doesn't zoom the page meanwhile.
    expect(first!.defaultPrevented).toBe(true);

    pinch(100, 130, 170); // 1.3, then 170 / 130 ≈ 1.31 from there: two steps
    expect(await tileWidth()).toBeCloseTo((520 * 4) / 3);
    pinch(100, 200); // already the largest
    expect(await tileWidth()).toBeCloseTo((520 * 4) / 3);
  });

  it("fingers together make them smaller, and the size is remembered", async () => {
    await renderAt("/gallery", { api: one().api });
    await tileWidth();
    pinch(200, 150);
    expect(await tileWidth()).toBeCloseTo((136 * 4) / 3);
    expect(localStorage.getItem("photo-app.gridZoom")).toBe("1");

    cleanup();
    await renderAt("/videos", { api: one().api });
    await screen.findByRole("heading", { name: "Videos" });
    cleanup();
    await renderAt("/gallery", { api: one().api });
    expect(await tileWidth()).toBeCloseTo((136 * 4) / 3);
  });

  it("a trackpad pinch (Ctrl + wheel) steps too; a plain wheel scrolls", async () => {
    await renderAt("/gallery", { api: one().api });
    await tileWidth();
    const plain = fireEvent.wheel(grid(), { deltaY: -100 });
    expect(plain).toBe(true);
    expect(await tileWidth()).toBe(256);
    const pinched = fireEvent.wheel(grid(), { deltaY: -100, ctrlKey: true });
    expect(pinched).toBe(false); // the page doesn't zoom
    expect(await tileWidth()).toBeCloseTo((272 * 4) / 3);
  });

  it("keeps the photo under the fingers where it was", async () => {
    const scroll = vi.spyOn(window, "scrollTo");
    await renderAt("/gallery", { api: setup({ "GET /photos": testPhotoPage(0, 30) }).api });
    await tileWidth();
    const target = screen.getByRole("link", { name: "IMG_9.jpg" });
    document.elementFromPoint = () => target;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 120, 100, 100));
    scroll.mockClear();
    pinch(100, 130);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    // 4:3 tiles at 272 px rows: 3 per 1000 px row, so IMG_9 is in the 4th row (3 rows above,
    // under the 44 px month heading); its row lands where the tile was (120 px from the top).
    const [options] = scroll.mock.calls.at(-1)! as unknown as [ScrollToOptions];
    const rowHeight = (1000 - 2 * 4) / (3 * (4 / 3));
    expect(options.top).toBeCloseTo(44 + 3 * (rowHeight + 4) - 120);
  });

  it("a second finger cancels a press-to-select", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderAt("/gallery", { api: setup({ "GET /photos": testPhotoPage(0, 3) }).api });
      const tile = await screen.findByRole("link", { name: "IMG_0.jpg" });
      fireEvent.pointerDown(tile, { pointerId: 1, isPrimary: true, button: 0, clientX: 10 });
      fireEvent.pointerDown(tile, { pointerId: 2, isPrimary: false, button: 0, clientX: 90 });
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 50));
      expect(screen.queryByRole("toolbar")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
