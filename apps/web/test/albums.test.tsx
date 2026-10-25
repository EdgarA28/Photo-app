import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { batches } from "../src/queries/albums";
import { fakeApi, testId, testPhoto, testPhotoPage } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const HOLIDAYS = testId(900);
const TRIP = testId(901);

function album(albumId: string, name: string, photoCount = 0, overrides = {}) {
  return {
    albumId,
    name,
    createdAt: "2026-10-01T10:00:00.000Z",
    coverPhotoId: null,
    coverThumbUrl: null,
    photoCount,
    ...overrides,
  };
}

/**
 * A fake API with a mutable album list: create/rename/delete change what `GET /albums` returns,
 * like the real one.
 */
function setup(responses: Record<string, unknown> = {}) {
  let albums = [album(HOLIDAYS, "Holidays", 3), album(TRIP, "Trip", 0)];
  const fake = fakeApi({
    ...defaultResponses,
    "GET /photos": testPhotoPage(0, 3),
    "GET /albums": () => ({ items: albums }),
    [`GET /albums/${HOLIDAYS}/photos`]: testPhotoPage(0, 3),
    [`GET /albums/${TRIP}/photos`]: { items: [], nextCursor: null },
    [`GET /albums/${testId(950)}/photos`]: { items: [], nextCursor: null },
    "POST /albums": () => {
      const created = album(testId(950), lastBody(fake.request)!.name!);
      albums = [...albums, created];
      return created;
    },
    [`PATCH /albums/${HOLIDAYS}`]: () => {
      const changes = lastBody(fake.request)!;
      albums = albums.map((a) => (a.albumId === HOLIDAYS ? { ...a, ...changes } : a));
      return albums[0];
    },
    [`DELETE /albums/${HOLIDAYS}`]: () => {
      albums = albums.filter((a) => a.albumId !== HOLIDAYS);
      return undefined;
    },
    [`POST /albums/${HOLIDAYS}/photos`]: undefined,
    [`POST /albums/${TRIP}/photos`]: undefined,
    [`POST /albums/${testId(950)}/photos`]: undefined,
    ...Object.fromEntries(
      [0, 1, 2].map((n) => [`DELETE /albums/${HOLIDAYS}/photos/${testId(n)}`, undefined]),
    ),
    ...responses,
  });
  return fake;
}

type Request = ReturnType<typeof fakeApi>["request"];

const lastBody = (request: Request) =>
  request.mock.calls.at(-1)?.[2]?.body as Record<string, string> | undefined;

/** Every request as "METHOD /path", with its JSON body if any. */
const calls = (request: Request, method?: string) =>
  request.mock.calls
    .filter(([m]) => !method || m === method)
    .map(([m, path, options]) => (options?.body ? [`${m} ${path}`, options.body] : `${m} ${path}`));

/** Radix menus open from the keyboard in jsdom (no pointer events). */
async function openMenu(label: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: label }), { key: "Enter" });
  return screen.findByRole("menu");
}

const tile = (name: string) => screen.findByRole("button", { name });

describe("albums list (FR-ALB-1)", () => {
  it("lists my albums, newest first, with their photo counts", async () => {
    const { api } = setup();
    await renderAt("/albums", { api });
    const links = await screen.findAllByRole("link", { name: /photo/ });
    expect(links.map((l) => l.textContent)).toEqual(["Trip0 photos", "Holidays3 photos"]);
    expect(links[1]!.getAttribute("href")).toBe(`/albums/${HOLIDAYS}`);
  });

  it("shows an empty state", async () => {
    const { api } = setup({ "GET /albums": { items: [] } });
    await renderAt("/albums", { api });
    expect(await screen.findByText("No albums yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create your first album" })).toBeTruthy();
  });

  it("creates an album and opens it", async () => {
    const { api, request } = setup();
    const { router } = await renderAt("/albums", { api });
    fireEvent.click(await screen.findByRole("button", { name: "New album" }));

    const dialog = await screen.findByRole("dialog", { name: "New album" });
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create).toHaveProperty("disabled", true); // blank name
    fireEvent.change(within(dialog).getByLabelText("Album name"), {
      target: { value: "  Summer  " },
    });
    fireEvent.click(create);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/albums/${testId(950)}`));
    expect(calls(request, "POST")).toEqual([["POST /albums", { name: "Summer" }]]);
    expect(await screen.findByRole("heading", { name: "Summer" })).toBeTruthy();
  });

  it("shows the API's reason when the name is refused", async () => {
    const { api } = setup({
      "POST /albums": new ApiRequestError("VALIDATION_ERROR", "name: Too long", 400),
    });
    await renderAt("/albums", { api });
    fireEvent.click(await screen.findByRole("button", { name: "New album" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Album name"), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("name: Too long");
  });
});

describe("album view (FR-ALB-1/2)", () => {
  it("shows the album's photos, opening the viewer inside the album", async () => {
    const { api } = setup();
    await renderAt(`/albums/${HOLIDAYS}`, { api });
    expect(await screen.findByRole("heading", { name: "Holidays" })).toBeTruthy();
    expect(screen.getByText("3 photos")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "IMG_0.jpg" });
    expect(link.getAttribute("href")).toBe(
      `/photos/${testId(0)}?album=${HOLIDAYS}&sort=taken-desc`,
    );
  });

  it("offers adding photos to an empty album", async () => {
    const { api } = setup();
    await renderAt(`/albums/${TRIP}`, { api });
    expect(await screen.findByText("This album has no photos yet.")).toBeTruthy();
    const links = screen.getAllByRole("link", { name: /Add photos/ });
    expect(links[0]!.getAttribute("href")).toBe(`/gallery?addTo=${TRIP}`);
  });

  it("renames the album", async () => {
    const { api, request } = setup();
    await renderAt(`/albums/${HOLIDAYS}`, { api });
    const menu = await openMenu("Album actions");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));

    const dialog = await screen.findByRole("dialog", { name: "Rename album" });
    const field = within(dialog).getByLabelText("Album name");
    expect(field).toHaveProperty("value", "Holidays");
    fireEvent.change(field, { target: { value: "Summer 2026" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("heading", { name: "Summer 2026" })).toBeTruthy();
    expect(calls(request, "PATCH")).toEqual([
      [`PATCH /albums/${HOLIDAYS}`, { name: "Summer 2026" }],
    ]);
  });

  it("deletes the album but never its photos, then goes back to the list", async () => {
    const { api, request } = setup();
    const { router } = await renderAt(`/albums/${HOLIDAYS}`, { api });
    const menu = await openMenu("Album actions");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete album" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("The photos in it stay in your library.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete album" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/albums"));
    expect(calls(request, "DELETE")).toEqual([`DELETE /albums/${HOLIDAYS}`]);
    expect(await screen.findByRole("link", { name: /Trip/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Holidays/ })).toBeNull();
    expect(screen.queryByText("Album not found")).toBeNull();
  });

  it("removes selected photos from the album only", async () => {
    let removed = false;
    const { api, request } = setup({
      [`GET /albums/${HOLIDAYS}/photos`]: () =>
        removed ? { items: [testPhoto(1)], nextCursor: null } : testPhotoPage(0, 3),
    });
    await renderAt(`/albums/${HOLIDAYS}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(await tile("IMG_0.jpg"));
    fireEvent.click(await tile("IMG_2.jpg"));
    expect((await tile("IMG_0.jpg")).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("2 selected")).toBeTruthy();

    removed = true;
    fireEvent.click(screen.getByRole("button", { name: "Remove from album" }));
    expect(await screen.findByText("2 photos removed from the album.")).toBeTruthy();
    expect(calls(request, "DELETE")).toEqual([
      `DELETE /albums/${HOLIDAYS}/photos/${testId(0)}`,
      `DELETE /albums/${HOLIDAYS}/photos/${testId(2)}`,
    ]);
    // Select mode ends; only the remaining photo is left.
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^IMG_/ })).toHaveLength(1));
    expect(screen.getByRole("link", { name: "IMG_1.jpg" })).toBeTruthy();
  });

  it("sets one selected photo as the cover", async () => {
    const { api, request } = setup();
    await renderAt(`/albums/${HOLIDAYS}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    expect(screen.queryByRole("button", { name: "Set as cover" })).toBeNull();
    fireEvent.click(await tile("IMG_1.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Set as cover" }));
    expect(await screen.findByText("Album cover updated.")).toBeTruthy();
    expect(calls(request, "PATCH")).toEqual([
      [`PATCH /albums/${HOLIDAYS}`, { coverPhotoId: testId(1) }],
    ]);
  });

  it("leaves select mode with Escape", async () => {
    const { api } = setup();
    await renderAt(`/albums/${HOLIDAYS}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    expect(screen.getByRole("toolbar", { name: "Selection" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(screen.getByRole("link", { name: "IMG_0.jpg" })).toBeTruthy();
  });

  it("says when the album doesn't exist (or is no longer shared with me)", async () => {
    const { api } = setup({
      [`GET /albums/${testId(999)}/photos`]: new ApiRequestError(
        "NOT_FOUND",
        "Album not found",
        404,
      ),
    });
    await renderAt(`/albums/${testId(999)}`, { api });
    expect(await screen.findByRole("heading", { name: "Album not found" })).toBeTruthy();
    expect(screen.getByText(/no longer shared with you/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to albums" })).toBeTruthy();
  });
});

describe("adding photos to albums (FR-ALB-2)", () => {
  it("picks photos for an album from the library and returns to it", async () => {
    const { api, request } = setup();
    const { router } = await renderAt(`/albums/${TRIP}`, { api });
    fireEvent.click((await screen.findAllByRole("link", { name: /Add photos/ }))[0]!);

    expect(await screen.findByRole("heading", { name: "Add to Trip" })).toBeTruthy();
    // No filters or uploads here, only the photos to pick.
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(await tile("IMG_2.jpg"));
    fireEvent.click(await tile("IMG_0.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 photos" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/albums/${TRIP}`));
    expect(calls(request, "POST")).toEqual([
      [`POST /albums/${TRIP}/photos`, { photoIds: [testId(2), testId(0)] }],
    ]);
  });

  it("adds selected gallery photos to an album chosen in a dialog", async () => {
    const { api, request } = setup();
    await renderAt("/gallery", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(await tile("IMG_0.jpg"));
    fireEvent.click(await tile("IMG_1.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Add to album" }));

    const dialog = await screen.findByRole("dialog", { name: "Add to album" });
    expect(dialog.textContent).toContain("Choose an album for 2 photos.");
    fireEvent.click(await within(dialog).findByRole("button", { name: /Holidays/ }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Added 2 photos to Holidays.");
    expect(within(status).getByRole("link").getAttribute("href")).toBe(`/albums/${HOLIDAYS}`);
    expect(calls(request, "POST")).toEqual([
      [`POST /albums/${HOLIDAYS}/photos`, { photoIds: [testId(0), testId(1)] }],
    ]);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("creates a new album from the dialog and adds the photos to it", async () => {
    const { api, request } = setup();
    await renderAt("/gallery", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(await tile("IMG_2.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Add to album" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "New album" }));
    fireEvent.change(within(dialog).getByLabelText("Album name"), { target: { value: "Best" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create and add" }));

    expect((await screen.findByRole("status")).textContent).toBe("Added 1 photo to Best.");
    expect(calls(request, "POST")).toEqual([
      ["POST /albums", { name: "Best" }],
      [`POST /albums/${testId(950)}/photos`, { photoIds: [testId(2)] }],
    ]);
  });

  it("keeps the selection and explains a failure", async () => {
    const { api } = setup({
      [`POST /albums/${HOLIDAYS}/photos`]: new ApiRequestError("NOT_FOUND", "Photo not found", 404),
    });
    await renderAt("/gallery", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(await tile("IMG_0.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Add to album" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /Holidays/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "This item doesn't exist or was deleted.",
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("splits large selections into requests of at most 100 photos", () => {
    const ids = Array.from({ length: 250 }, (_, i) => testId(i));
    expect(batches(ids, 100).map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches(ids, 100).flat()).toEqual(ids);
    expect(batches([], 100)).toEqual([]);
  });
});

describe("album actions in the viewer (FR-ALB-2)", () => {
  it("adds the photo to an album", async () => {
    const { api, request } = setup();
    await renderAt(`/photos/${testId(1)}`, { api });
    const menu = await openMenu("Album actions");
    // Outside an album only adding makes sense.
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Add to album…"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Add to album…" }));

    const dialog = await screen.findByRole("dialog", { name: "Add to album" });
    // Arrow keys belong to the dialog now, not to prev/next.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Trip/ }));

    expect((await screen.findByRole("status")).textContent).toBe("Added to Trip");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("IMG_1.jpg");
    expect(calls(request, "POST")).toEqual([
      [`POST /albums/${TRIP}/photos`, { photoIds: [testId(1)] }],
    ]);
  });

  it("removes the photo from the album it was opened from and moves to the next", async () => {
    const { api, request } = setup();
    await renderAt(`/photos/${testId(1)}?album=${HOLIDAYS}`, { api });
    const menu = await openMenu("Album actions");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove from album" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("IMG_2.jpg"),
    );
    expect(calls(request, "DELETE")).toEqual([`DELETE /albums/${HOLIDAYS}/photos/${testId(1)}`]);
  });

  it("sets the photo as the album's cover", async () => {
    const { api, request } = setup();
    await renderAt(`/photos/${testId(0)}?album=${HOLIDAYS}`, { api });
    const menu = await openMenu("Album actions");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Set as album cover" }));
    expect((await screen.findByRole("status")).textContent).toBe("Set as album cover");
    expect(calls(request, "PATCH")).toEqual([
      [`PATCH /albums/${HOLIDAYS}`, { coverPhotoId: testId(0) }],
    ]);
  });

  it("has no album actions for a photo in an album shared with me", async () => {
    const shared = testId(940);
    const { api } = setup({ [`GET /albums/${shared}/photos`]: testPhotoPage(0, 2) });
    await renderAt(`/photos/${testId(0)}?album=${shared}`, { api });
    await screen.findByRole("button", { name: "Download original" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Album actions" })).toBeNull());
  });
});
