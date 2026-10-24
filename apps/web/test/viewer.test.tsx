import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
    const stage = preview().parentElement!;

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
