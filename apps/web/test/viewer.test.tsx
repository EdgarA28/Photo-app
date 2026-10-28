import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { fakeApi, testId, testPhoto, testPhotoPage } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const album = testId(900);

function setup(responses: Record<string, unknown> = {}) {
  return fakeApi({ ...defaultResponses, "GET /photos": testPhotoPage(0, 3), ...responses });
}

const heading = () => screen.getByRole("heading", { level: 1 }).textContent;
const preview = () => screen.getByRole("img");

/** A pointer press at `x`, released at `x + dx` (touch swipe). */
function swipe(element: Element, dx: number, dy = 0) {
  fireEvent.pointerDown(element, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
  fireEvent.pointerUp(element, {
    pointerId: 1,
    isPrimary: true,
    clientX: 200 + dx,
    clientY: 300 + dy,
  });
}

describe("photo viewer (FR-GAL-4)", () => {
  it("opens from a gallery tile, full screen, with the preview and the photo's details", async () => {
    const { api } = setup();
    const { router } = await renderAt("/gallery", { api });
    fireEvent.click(await screen.findByRole("link", { name: "IMG_1.jpg" }));

    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));
    expect(router.state.location.pathname).toBe(`/photos/${testId(1)}`);
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
    expect(preview().getAttribute("src")).toBe(testPhoto(1).previewUrl);
    expect(preview().getAttribute("alt")).toBe("IMG_1.jpg");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("steps through the gallery list with the previous/next buttons", async () => {
    const { router } = await renderAt(`/photos/${testId(0)}`, { api: setup().api });
    expect(await screen.findByRole("heading", { name: "IMG_0.jpg" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Previous photo" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Next photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));
    fireEvent.click(screen.getByRole("link", { name: "Next photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_2.jpg"));
    expect(screen.queryByRole("link", { name: "Next photo" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Previous photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));
    expect(router.state.location.search).toEqual({ sort: "taken-desc" });
  });

  it("moves with the arrow keys", async () => {
    await renderAt(`/photos/${testId(1)}`, { api: setup().api });
    await screen.findByRole("heading", { name: "IMG_1.jpg" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(heading()).toBe("IMG_2.jpg"));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(heading()).toBe("IMG_0.jpg"));
  });

  it("moves with horizontal swipes and ignores mostly vertical ones", async () => {
    await renderAt(`/photos/${testId(1)}`, { api: setup().api });
    await screen.findByRole("heading", { name: "IMG_1.jpg" });
    // The swipe area around the photo (the zoom box inside it is replaced with each photo).
    const stage = screen.getByTestId("zoom-box").parentElement!;

    swipe(stage, -120);
    await waitFor(() => expect(heading()).toBe("IMG_2.jpg"));
    swipe(stage, 120);
    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));
    swipe(stage, 60, 200);
    swipe(stage, 30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heading()).toBe("IMG_1.jpg");
  });

  it("goes back to the gallery it came from with Escape or Close", async () => {
    const { router } = await renderAt("/gallery?sort=taken-asc", { api: setup().api });
    fireEvent.click(await screen.findByRole("link", { name: "IMG_0.jpg" }));
    await screen.findByRole("heading", { name: "IMG_0.jpg" });
    fireEvent.click(screen.getByRole("link", { name: "Next photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
    expect(router.state.location.search).toEqual({ sort: "taken-asc" });

    fireEvent.click(await screen.findByRole("link", { name: "IMG_2.jpg" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
  });

  it("closes to the gallery when opened directly from a link", async () => {
    const { router } = await renderAt(`/photos/${testId(0)}`, { api: setup().api });
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
  });

  it("walks the album it was opened from", async () => {
    const { api, request } = setup({ [`GET /albums/${album}/photos`]: testPhotoPage(50, 2) });
    await renderAt(`/photos/${testId(50)}?album=${album}`, { api });
    await screen.findByRole("heading", { name: "IMG_50.jpg" });
    fireEvent.click(screen.getByRole("link", { name: "Next photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_51.jpg"));
    // The album's own list, not the whole gallery.
    expect(request.mock.calls.map(([, path]) => path)).not.toContain("/photos");
  });

  it("loads the next gallery page when nearing the end of the loaded photos", async () => {
    const { api } = setup({
      "GET /photos": (query: { cursor?: string }) =>
        query.cursor === "page-2" ? testPhotoPage(3, 2) : testPhotoPage(0, 3, "page-2"),
    });
    await renderAt(`/photos/${testId(2)}`, { api });
    await screen.findByRole("heading", { name: "IMG_2.jpg" });
    fireEvent.click(await screen.findByRole("link", { name: "Next photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_3.jpg"));
  });

  describe("a shared album's photos (7.4)", () => {
    // Album pages carry signed thumbnails only; the preview comes with the photo on its own.
    const signed = (kind: string, n: number) =>
      `/users/owner/${kind}/${testId(n)}.jpg?Expires=1&Signature=s&Key-Pair-Id=K&Hash-Algorithm=SHA256`;
    const listed = (n: number) => testPhoto(n, { thumbUrl: signed("thumbs", n), previewUrl: null });
    const shared = (from: number, count: number) => {
      const fetched: string[] = [];
      const responses = {
        [`GET /albums/${album}/photos`]: {
          items: Array.from({ length: count }, (_, i) => listed(from + i)),
          nextCursor: null,
        },
      } as Record<string, unknown>;
      for (let n = from; n < from + count; n++) {
        responses[`GET /photos/${testId(n)}`] = (query: { albumId?: string }) => {
          fetched.push(`${testId(n)}?albumId=${query?.albumId}`);
          return testPhoto(n, { thumbUrl: signed("thumbs", n), previewUrl: signed("previews", n) });
        };
      }
      return { ...setup(responses), fetched };
    };

    it("fetches the photo through the album for its signed preview, and the neighbours' too", async () => {
      const { api, fetched } = shared(50, 3);
      await renderAt(`/photos/${testId(51)}?album=${album}`, { api });
      await screen.findByRole("heading", { name: "IMG_51.jpg" });

      await waitFor(() => expect(preview().getAttribute("src")).toBe(signed("previews", 51)));
      await waitFor(() =>
        expect(fetched.sort()).toEqual(
          [50, 51, 52].map((n) => `${testId(n)}?albumId=${album}`).sort(),
        ),
      );
    });

    it("shows the thumbnail while the preview URL is on its way", async () => {
      const { api, request } = shared(50, 1);
      const respond = request.getMockImplementation()!;
      request.mockImplementation(async (method, path, options) =>
        path === `/photos/${testId(50)}` ? new Promise(() => {}) : respond(method, path, options),
      );
      await renderAt(`/photos/${testId(50)}?album=${album}`, { api });
      await screen.findByRole("heading", { name: "IMG_50.jpg" });
      expect(preview().getAttribute("src")).toBe(signed("thumbs", 50));
    });

    it("own photos don't fetch anything extra", async () => {
      const { api, request } = setup();
      await renderAt(`/photos/${testId(1)}`, { api });
      await screen.findByRole("heading", { name: "IMG_1.jpg" });
      expect(request.mock.calls.map(([, path]) => path)).not.toContain(`/photos/${testId(1)}`);
    });
  });

  it("shows a photo outside the loaded pages on its own, without prev/next", async () => {
    const { api } = setup({ [`GET /photos/${testId(77)}`]: testPhoto(77) });
    await renderAt(`/photos/${testId(77)}`, { api });
    expect(await screen.findByRole("heading", { name: "IMG_77.jpg" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /photo$/ })).toBeNull();
  });

  it("explains a missing photo and offers the way back", async () => {
    const { api } = setup({
      [`GET /photos/${testId(78)}`]: new ApiRequestError("NOT_FOUND", "Photo not found", 404),
    });
    const { router } = await renderAt(`/photos/${testId(78)}`, { api });
    expect(await screen.findByText("This item doesn't exist or was deleted.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the gallery" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
  });
});

describe("viewer states (FR-GAL-5)", () => {
  it.each([
    [{ status: "pending", previewUrl: null, width: null, height: null }, "still processing"],
    [{ status: "failed", previewUrl: null }, "couldn't be processed"],
  ])("explains a photo without a preview: %o", async (overrides, message) => {
    const { api } = setup({
      "GET /photos": { items: [testPhoto(0, overrides)], nextCursor: null },
    });
    await renderAt(`/photos/${testId(0)}`, { api });
    expect((await screen.findByRole("status")).textContent).toContain(message);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("falls back to a message when the preview can't load", async () => {
    await renderAt(`/photos/${testId(0)}`, { api: setup().api });
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByRole("status").textContent).toContain("The preview can't be shown.");
  });
});

describe("download (FR-DL-1/2)", () => {
  const url = "https://photos.s3.amazonaws.com/users/u/originals/x.jpg?X-Amz-Signature=abc";
  const downloadUrl = { url, expiresAt: "2026-10-24T12:05:00.000Z" };

  /** Records the links the app clicks to start downloads. */
  function spyOnDownloads() {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });
    return clicked;
  }

  afterEach(() => vi.restoreAllMocks());

  it("saves the original through a pre-signed URL", async () => {
    const clicked = spyOnDownloads();
    const { api, request } = setup({
      [`GET /photos/${testId(0)}/download-url`]: downloadUrl,
    });
    await renderAt(`/photos/${testId(0)}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Download original" }));
    await waitFor(() => expect(clicked).toEqual([url]));
    const call = request.mock.calls.find(([, path]) => path.endsWith("/download-url"));
    expect(call?.[2]?.query).toEqual({ albumId: undefined });
  });

  it("names the shared album, and offers no delete for someone else's photo", async () => {
    const clicked = spyOnDownloads();
    const { api, request } = setup({
      [`GET /albums/${album}/photos`]: testPhotoPage(50, 1),
      [`GET /photos/${testId(50)}/download-url`]: downloadUrl,
    });
    await renderAt(`/photos/${testId(50)}?album=${album}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Download original" }));
    await waitFor(() => expect(clicked).toEqual([url]));
    const call = request.mock.calls.find(([, path]) => path.endsWith("/download-url"));
    expect(call?.[2]?.query).toEqual({ albumId: album });
    expect(screen.queryByRole("button", { name: "Delete photo" })).toBeNull();
  });

  it("is unavailable until the upload has finished", async () => {
    const { api } = setup({
      "GET /photos": { items: [testPhoto(0, { status: "pending" })], nextCursor: null },
    });
    await renderAt(`/photos/${testId(0)}`, { api });
    const button = await screen.findByRole("button", { name: "Download original" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a failed download", async () => {
    const { api } = setup({
      [`GET /photos/${testId(0)}/download-url`]: new ApiRequestError("NETWORK_ERROR", "x", 0),
    });
    await renderAt(`/photos/${testId(0)}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Download original" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Can't reach the server. Check your connection.",
    );
  });
});

describe("delete (FR-DEL-1/2)", () => {
  const deletes = (request: ReturnType<typeof fakeApi>["request"]) =>
    request.mock.calls.filter(([method]) => method === "DELETE").map(([, path]) => path);

  async function openDialog() {
    fireEvent.click(await screen.findByRole("button", { name: "Delete photo" }));
    return screen.findByRole("alertdialog", { name: "Move this photo to the trash?" });
  }

  it("asks for confirmation and does nothing when cancelled", async () => {
    const { api, request } = setup();
    await renderAt(`/photos/${testId(1)}`, { api });
    const dialog = await openDialog();
    expect(dialog.textContent).toContain("IMG_1.jpg will be removed from your library");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deletes(request)).toEqual([]);
    expect(heading()).toBe("IMG_1.jpg");
  });

  it("deletes, shows the next photo and drops it from the gallery", async () => {
    let deleted = false;
    const { api, request } = setup({
      "GET /photos": () =>
        deleted ? { items: [testPhoto(0), testPhoto(2)], nextCursor: null } : testPhotoPage(0, 3),
      [`DELETE /photos/${testId(1)}`]: () => {
        deleted = true;
      },
    });
    const { router } = await renderAt("/gallery", { api });
    fireEvent.click(await screen.findByRole("link", { name: "IMG_1.jpg" }));
    await screen.findByRole("heading", { name: "IMG_1.jpg" });

    fireEvent.click(within(await openDialog()).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(heading()).toBe("IMG_2.jpg"));
    expect(deletes(request)).toEqual([`/photos/${testId(1)}`]);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // The deleted photo is gone from the list prev/next walk, and from the gallery.
    const previous = screen.getByRole("link", { name: "Previous photo" });
    await waitFor(() => expect(previous.getAttribute("href")).toContain(testId(0)));
    fireEvent.click(previous);
    await waitFor(() => expect(heading()).toBe("IMG_0.jpg"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
    await screen.findByRole("link", { name: "IMG_0.jpg" });
    expect(screen.queryByRole("link", { name: "IMG_1.jpg" })).toBeNull();
  });

  it("goes back to the gallery after deleting the only photo", async () => {
    const { api } = setup({
      "GET /photos": testPhotoPage(0, 1),
      [`DELETE /photos/${testId(0)}`]: undefined,
    });
    const { router } = await renderAt(`/photos/${testId(0)}`, { api });
    fireEvent.click(within(await openDialog()).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/gallery"));
  });

  it("keeps the dialog open with the reason when the delete fails", async () => {
    const { api } = setup({
      [`DELETE /photos/${testId(1)}`]: new ApiRequestError("INTERNAL_ERROR", "x", 500),
    });
    await renderAt(`/photos/${testId(1)}`, { api });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Something went wrong on our side. Try again later.",
    );
    // Behind the modal dialog, hidden from assistive tech.
    expect(screen.getByRole("heading", { level: 1, hidden: true }).textContent).toBe("IMG_1.jpg");
  });

  it("closes only the dialog with Escape, and arrows don't change the photo behind it", async () => {
    const { router } = await renderAt(`/photos/${testId(1)}`, { api: setup().api });
    await openDialog();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(router.state.location.pathname).toBe(`/photos/${testId(1)}`);
    expect(heading()).toBe("IMG_1.jpg");
  });

  it("is offered in one of my own albums", async () => {
    const { api } = setup({
      "GET /albums": {
        items: [
          {
            albumId: album,
            name: "Mine",
            createdAt: "2026-10-01T10:00:00.000Z",
            coverPhotoId: null,
            coverThumbUrl: null,
            photoCount: 1,
          },
        ],
      },
      [`GET /albums/${album}/photos`]: testPhotoPage(50, 1),
    });
    await renderAt(`/photos/${testId(50)}?album=${album}`, { api });
    expect(await screen.findByRole("button", { name: "Delete photo" })).toBeTruthy();
  });
});
