import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/errors";
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
    expect(links[0]!.getAttribute("href")).toBe(`/photos/${testId(0)}`);
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

  it("keeps a square placeholder without an image for photos still processing", async () => {
    const { api } = setup({
      "GET /photos": {
        items: [testPhoto(0, { status: "pending", width: null, height: null, thumbUrl: null })],
        nextCursor: null,
      },
    });
    await renderAt("/gallery", { api });
    const tile = await screen.findByRole("link", { name: "IMG_0.jpg" });
    expect(tile.style.width).toBe("192px");
    expect(tile.querySelector("img")).toBeNull();
  });

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

/** Opens the Radix select labelled `label` and picks `option`. */
async function chooseOption(label: string, option: string) {
  const trigger = await screen.findByRole("combobox", { name: label });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
