import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import {
  PROCESSING_POLL_MS,
  PROCESSING_WINDOW_MS,
  processingPollInterval,
} from "../src/queries/photos";
import { emptyPage, fakeApi, testId, testMe, testPhoto, testPhotoPage } from "./fakes";
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
    expect(links[0]!.getAttribute("href")).toBe(`/photos/${testId(0)}?sort=taken-desc`);
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

  it("shows a square spinner placeholder without an image while processing", async () => {
    const { api } = setup({ "GET /photos": { items: [pending(0)], nextCursor: null } });
    await renderAt("/gallery", { api });
    const tile = await screen.findByRole("link", { name: "IMG_0.jpg, processing" });
    expect(tile.style.width).toBe("192px");
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.querySelector("svg.lucide-loader-circle")).not.toBeNull();
  });

  it("shows an error state for a photo that failed processing", async () => {
    const { api } = setup({
      "GET /photos": { items: [testPhoto(0, { status: "failed" })], nextCursor: null },
    });
    await renderAt("/gallery", { api });
    const tile = await screen.findByRole("link", { name: "IMG_0.jpg, couldn't be processed" });
    expect(tile.textContent).toBe("Failed");
    expect(tile.querySelector("img")).toBeNull();
    // Still opens the viewer, where it can be downloaded or deleted (8.8/8.9).
    expect(tile.getAttribute("href")).toBe(`/photos/${testId(0)}?sort=taken-desc`);
  });

  it("refetches while a photo is processing and shows it once ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let ready = false;
    const { api, request } = setup({
      "GET /photos": () => ({ items: [ready ? testPhoto(0) : pending(0)], nextCursor: null }),
    });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: "IMG_0.jpg, processing" });
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

  it("filters to an album chosen in the album menu", async () => {
    const { api } = setup({ [`GET /albums/${album.albumId}/photos`]: testPhotoPage(50, 2) });
    const { router } = await renderAt("/gallery", { api });
    await chooseOption("Album", "Holidays");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ album: album.albumId, sort: "taken-desc" }),
    );
    expect(await screen.findByRole("link", { name: "IMG_50.jpg" })).toBeTruthy();
  });

  it("lists an album from the URL by date taken, with the sort menu (§12.3)", async () => {
    const { api, request } = setup({ [`GET /albums/${album.albumId}/photos`]: emptyPage });
    await renderAt(`/gallery?album=${album.albumId}&sort=taken-asc`, { api });
    expect(await screen.findByText("This album has no photos yet.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Upload photos" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Sort order" }).textContent).toContain(
      "Oldest first",
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Album" }).textContent).toBe("Holidays"),
    );
    expect(queriesTo(request, `/albums/${album.albumId}/photos`)).toEqual([
      { sort: "taken-asc", cursor: undefined },
    ]);
    expect(queriesTo(request, "/photos")).toEqual([]);
  });

  it("names an album that isn't in my list, e.g. one shared with me", async () => {
    const shared = testId(901);
    const { api } = setup({ [`GET /albums/${shared}/photos`]: testPhotoPage(0, 1) });
    await renderAt(`/gallery?album=${shared}`, { api });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Album" }).textContent).toBe("Selected album"),
    );
  });

  it("explains a missing album and goes back to all photos", async () => {
    const gone = testId(902);
    const { api } = setup({
      [`GET /albums/${gone}/photos`]: new ApiRequestError("NOT_FOUND", "Album not found", 404),
      "GET /photos": testPhotoPage(0, 1),
    });
    const { router } = await renderAt(`/gallery?album=${gone}`, { api });
    expect(await screen.findByText("This item doesn't exist or was deleted.")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Show all photos" }));
    expect(await screen.findByRole("link", { name: "IMG_0.jpg" })).toBeTruthy();
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
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
    const dialog = await selectAndConfirm(["IMG_0.jpg", "IMG_2.jpg"], "Delete 2 photos?");
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
    const dialog = await selectAndConfirm(["IMG_0.jpg", "IMG_2.jpg"], "Delete 2 photos?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect((await screen.findByRole("status")).textContent).toBe("Deleted 2 photos.");
    expect(deletes(request)).toEqual([`/photos/${testId(0)}`, `/photos/${testId(2)}`]);
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(tiles().map((t) => t.getAttribute("aria-label"))).toEqual(["IMG_1.jpg"]);
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
      "Delete 3 photos?",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "1 photo couldn't be deleted: Something went wrong on our side. Try again later.",
    );
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete this photo?");

    fail = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("status")).textContent).toBe("Deleted 3 photos.");
    expect(deletes(request)).toEqual([
      `/photos/${testId(0)}`,
      `/photos/${testId(1)}`,
      `/photos/${testId(2)}`,
      `/photos/${testId(1)}`,
    ]);
  });

  it("offers no delete in an album shared with me", async () => {
    const shared = testId(901);
    const { api } = setup({ [`GET /albums/${shared}/photos`]: testPhotoPage(0, 2) });
    await renderAt(`/gallery?album=${shared}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    await screen.findByRole("toolbar");
    expect(screen.getByRole("button", { name: "Add to album" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
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
