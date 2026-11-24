import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setGroupingSimilar } from "../src/settings/groupSimilar";
import { fakeApi, testId, testPhoto } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
  setGroupingSimilar(true);
});

const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, second)).toISOString();

/**
 * A burst of three (IMG_0–2, seconds apart, hashes 0–2 bits apart, IMG_1 the sharpest) and a
 * different photo an hour earlier (IMG_3).
 */
function library(topPickAt: Record<string, string> = {}) {
  const burst = [
    { n: 0, second: 2, hash: "0000000000000001", sharpness: 400 },
    { n: 1, second: 1, hash: "0000000000000003", sharpness: 900 },
    { n: 2, second: 0, hash: "0000000000000000", sharpness: 300 },
  ].map(({ n, second, hash, sharpness }) =>
    testPhoto(n, {
      takenAt: at(second),
      similarityHash: hash,
      sharpness,
      topPickAt: topPickAt[testId(n)] ?? null,
    }),
  );
  const other = testPhoto(3, {
    takenAt: "2026-10-01T09:00:00.000Z",
    similarityHash: "ffffffffffffffff",
    sharpness: 100,
  });
  return { items: [...burst, other], nextCursor: null };
}

function setup(responses: Record<string, unknown> = {}) {
  return fakeApi({ ...defaultResponses, "GET /photos": library(), ...responses });
}

const tileLabels = () =>
  screen.queryAllByRole("link", { name: /^IMG_/ }).map((t) => t.getAttribute("aria-label"));

describe("stacks in the Gallery (FR-GAL-10/11)", () => {
  it("shows a burst as one tile: the sharpest photo, with a badge and the count", async () => {
    await renderAt("/gallery", { api: setup().api });
    await waitFor(() =>
      expect(tileLabels()).toEqual(["IMG_1.jpg, stack of 3 photos", "IMG_3.jpg"]),
    );
    const stack = screen.getByRole("link", { name: "IMG_1.jpg, stack of 3 photos" });
    expect(stack.querySelector("[data-stack-badge]")?.textContent).toBe("3");
    expect(stack.getAttribute("href")).toBe(`/photos/${testId(1)}?sort=taken-desc&mediaType=photo`);
    expect(
      screen.getByRole("link", { name: "IMG_3.jpg" }).querySelector("[data-stack-badge]"),
    ).toBeNull();
  });

  it("the user's top pick stands for the stack", async () => {
    const api = setup({
      "GET /photos": library({ [testId(2)]: "2026-11-24T10:00:00.000Z" }),
    }).api;
    await renderAt("/gallery", { api });
    await waitFor(() => expect(tileLabels()[0]).toBe("IMG_2.jpg, stack of 3 photos"));
  });

  it("switched off in Settings: every photo has its own tile", async () => {
    const { api } = setup();
    const { router } = await renderAt("/settings", { api });
    const toggle = await screen.findByRole("switch", { name: "Group similar photos" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("photo-app.groupSimilar")).toBe("off");

    await router.navigate({ to: "/gallery" });
    await waitFor(() =>
      expect(tileLabels()).toEqual(["IMG_0.jpg", "IMG_1.jpg", "IMG_2.jpg", "IMG_3.jpg"]),
    );
  });

  it("not in an album: every photo shows", async () => {
    const album = testId(900);
    const { api } = setup({
      "GET /albums": {
        items: [
          {
            albumId: album,
            name: "Holidays",
            createdAt: "2026-10-01T10:00:00.000Z",
            coverPhotoId: null,
            coverThumbUrl: null,
            photoCount: 4,
          },
        ],
      },
      [`GET /albums/${album}`]: {
        albumId: album,
        name: "Holidays",
        createdAt: "2026-10-01T10:00:00.000Z",
        coverPhotoId: null,
        coverThumbUrl: null,
        photoCount: 4,
      },
      [`GET /albums/${album}/photos`]: library(),
      [`GET /albums/${album}/shares`]: { items: [] },
    });
    await renderAt(`/albums/${album}`, { api });
    await waitFor(() => expect(tileLabels()).toHaveLength(4));
  });

  it("selecting a stack selects all its photos; delete moves them all", async () => {
    const { api, request } = setup({
      [`DELETE /photos/${testId(0)}`]: undefined,
      [`DELETE /photos/${testId(1)}`]: undefined,
      [`DELETE /photos/${testId(2)}`]: undefined,
    });
    await renderAt("/gallery", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    const stack = await screen.findByRole("button", { name: "IMG_1.jpg, stack of 3 photos" });
    fireEvent.click(stack);
    expect(stack.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("toolbar").textContent).toContain("3 selected");

    fireEvent.click(stack);
    expect(screen.getByRole("toolbar").textContent).toContain("Select photos");
    fireEvent.click(stack);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Move 3 photos to the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    await waitFor(() =>
      expect(
        request.mock.calls
          .filter(([method]) => method === "DELETE")
          .map(([, path]) => path)
          .sort(),
      ).toEqual([0, 1, 2].map((n) => `/photos/${testId(n)}`)),
    );
  });
});

describe("a stack in the viewer (FR-GAL-10/11)", () => {
  const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

  it("walks the tiles with prev/next and shows the stack as a strip", async () => {
    await renderAt("/gallery", { api: setup().api });
    fireEvent.click(await screen.findByRole("link", { name: "IMG_1.jpg, stack of 3 photos" }));
    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));

    const strip = screen.getByRole("region", { name: "Stack of 3 photos" });
    expect(
      within(strip)
        .getAllByRole("link")
        .map((l) => l.getAttribute("aria-label")),
    ).toEqual(["IMG_0.jpg", "IMG_1.jpg, top pick", "IMG_2.jpg"]);
    expect(within(strip).getByText("Top pick")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Previous photo" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Next photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_3.jpg"));
    expect(screen.queryByRole("region", { name: /^Stack/ })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Previous photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_1.jpg"));
  });

  it("another photo of the stack can be made the top pick", async () => {
    const picks: Record<string, string> = {};
    const { api, request } = setup({
      "GET /photos": () => library(picks),
      [`POST /photos/${testId(2)}/top-pick`]: () => {
        picks[testId(2)] = "2026-11-24T10:00:00.000Z";
      },
    });
    await renderAt(`/photos/${testId(1)}?mediaType=photo`, { api });
    const strip = await screen.findByRole("region", { name: "Stack of 3 photos" });
    fireEvent.click(within(strip).getByRole("link", { name: "IMG_2.jpg" }));
    await waitFor(() => expect(heading()).toBe("IMG_2.jpg"));

    fireEvent.click(within(strip).getByRole("button", { name: "Make top pick" }));
    await waitFor(() => expect(within(strip).getByText("Top pick")).toBeTruthy());
    expect(request.mock.calls.some(([m, p]) => m === "POST" && p.endsWith("/top-pick"))).toBe(true);
    expect(within(strip).getByRole("link", { name: "IMG_2.jpg, top pick" })).toBeTruthy();
  });

  it("switched off: prev/next walk every photo, no strip", async () => {
    setGroupingSimilar(false);
    await renderAt(`/photos/${testId(1)}?mediaType=photo`, { api: setup().api });
    await screen.findByRole("heading", { name: "IMG_1.jpg" });
    expect(screen.queryByRole("region", { name: /^Stack/ })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Next photo" }));
    await waitFor(() => expect(heading()).toBe("IMG_2.jpg"));
  });
});
