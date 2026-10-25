import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import {
  PROCESSING_POLL_MS,
  PROCESSING_WINDOW_MS,
  processingPollInterval,
} from "../src/queries/photos";
import { emptyPage, fakeApi, testId, testPhoto, testPhotoPage } from "./fakes";
import { defaultResponses, renderAt } from "./render";

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

  it("lists an album from the URL in its own order, without a sort menu", async () => {
    const { api, request } = setup({ [`GET /albums/${album.albumId}/photos`]: emptyPage });
    await renderAt(`/gallery?album=${album.albumId}`, { api });
    expect(await screen.findByText("This album has no photos yet.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Upload photos" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sort order" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Album" }).textContent).toBe("Holidays"),
    );
    expect(queriesTo(request, `/albums/${album.albumId}/photos`)).toEqual([{ cursor: undefined }]);
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
