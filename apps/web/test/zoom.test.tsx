import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clamp, fitted, maxScale, NO_ZOOM, zoomAt } from "../src/viewer/zoomMath";
import { fakeApi, testId, testPhoto, testPhotoPage } from "./fakes";
import { defaultResponses, renderAt } from "./render";

describe("zoom geometry", () => {
  const box = { width: 1000, height: 750 };
  const photo = { width: 4000, height: 3000 };
  const fit = fitted(box, photo);

  it("fits the photo like object-fit: contain", () => {
    expect(fit).toEqual({ width: 1000, height: 750 });
    expect(fitted(box, { width: 3000, height: 4000 })).toEqual({ width: 562.5, height: 750 });
    expect(fitted({ width: 0, height: 0 }, photo)).toEqual({ width: 0, height: 0 });
  });

  it("allows zooming to twice the real pixels, between 3× and 12×", () => {
    expect(maxScale(fit, photo)).toBe(8);
    expect(maxScale(fit, { width: 800, height: 600 })).toBe(3);
    expect(maxScale({ width: 100, height: 75 }, { width: 8000, height: 6000 })).toBe(12);
  });

  it("zooms around a point, keeping it in place", () => {
    const zoomed = zoomAt(NO_ZOOM, 2, { x: 100, y: 50 });
    expect(zoomed).toEqual({ scale: 2, x: -100, y: -50 });
    // The photo point that was under (100, 50) still is: (100 - x) / scale = 100.
    expect((100 - zoomed.x) / zoomed.scale).toBe(100);
  });

  it("keeps the zoomed photo covering the screen, and snaps back at 1×", () => {
    expect(clamp({ scale: 2, x: 900, y: -900 }, box, fit, 8)).toEqual({
      scale: 2,
      x: 500,
      y: -375,
    });
    expect(clamp({ scale: 20, x: 0, y: 0 }, box, fit, 8).scale).toBe(8);
    expect(clamp({ scale: 1.01, x: 30, y: 30 }, box, fit, 8)).toEqual(NO_ZOOM);
    expect(clamp({ scale: 0.5, x: 0, y: 0 }, box, fit, 8)).toEqual(NO_ZOOM);
  });
});

describe("zooming in the viewer", () => {
  // jsdom has no layout: a 1000 × 750 viewing area (clientWidth is 1000 in setup.ts).
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 750,
    });
  });
  afterAll(() => {
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const original = "https://photos.test.example/original.jpg?signature";
  function setup(photo = testPhoto(1)) {
    return fakeApi({
      ...defaultResponses,
      "GET /photos": { items: [testPhoto(0), photo, testPhoto(2)], nextCursor: null },
      [`GET /photos/${photo.photoId}/download-url`]: {
        url: original,
        expiresAt: "2026-10-27T20:00:00.000Z",
      },
    });
  }
  const box = () => screen.getByTestId("zoom-box");
  const scale = () => Number(box().dataset.scale);
  const heading = () => screen.getByRole("heading", { level: 1 }).textContent;

  async function open(photo = testPhoto(1)) {
    const api = setup(photo);
    await renderAt(`/photos/${photo.photoId}`, { api: api.api });
    await screen.findByRole("heading", { name: photo.fileName });
    return api;
  }

  /** What `useOriginal` reads from fetch (jsdom's Blob doesn't mix with Node's Response). */
  const okResponse = (body: string) => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([body]),
  });

  /** The preview finished loading with this many pixels across. */
  function previewLoaded(width = 1600) {
    const img = screen.getByRole("img");
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
    fireEvent.load(img);
  }

  it("zooms with the wheel and back out, never below fitting the screen", async () => {
    await open();
    fireEvent.wheel(box(), { deltaY: -200, clientX: 500, clientY: 375 });
    expect(scale()).toBeCloseTo(Math.exp(0.4), 2);
    // Drawn at the zoomed size (1000 px fit × 1.49), not scaled (no tile seams, full detail).
    expect(screen.getByRole("img").style.width).toMatch(/^149\d\./);
    expect(screen.getByRole("img").style.transform).not.toMatch(/scale/);
    fireEvent.wheel(box(), { deltaY: 2000 });
    expect(scale()).toBe(1);
  });

  it("toggles with a double click", async () => {
    await open();
    fireEvent.doubleClick(box(), { clientX: 500, clientY: 375 });
    expect(scale()).toBe(2.5);
    fireEvent.doubleClick(box(), { clientX: 500, clientY: 375 });
    expect(scale()).toBe(1);
  });

  it("works with + / - / 0, and arrows still change photo", async () => {
    await open();
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "+" });
    expect(scale()).toBe(2.25);
    fireEvent.keyDown(window, { key: "-" });
    expect(scale()).toBe(1.5);
    fireEvent.keyDown(window, { key: "0" });
    expect(scale()).toBe(1);

    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(heading()).toBe("IMG_2.jpg"));
    // A new photo starts unzoomed.
    expect(scale()).toBe(1);
  });

  it("zoomed in, a drag pans the photo instead of changing it", async () => {
    await open();
    fireEvent.doubleClick(box(), { clientX: 500, clientY: 375 });
    const before = screen.getByRole("img").style.transform;
    // Zoomed in at the right edge, so drag right (further left is the edge already); unzoomed,
    // this drag would go to the previous photo.
    fireEvent.pointerDown(box(), { pointerId: 1, isPrimary: true, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(box(), { pointerId: 1, isPrimary: true, clientX: 420, clientY: 300 });
    fireEvent.pointerUp(box(), { pointerId: 1, isPrimary: true, clientX: 420, clientY: 300 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heading()).toBe("IMG_1.jpg");
    expect(screen.getByRole("img").style.transform).not.toBe(before);
  });

  it("pinches with two fingers", async () => {
    await open();
    fireEvent.pointerDown(box(), { pointerId: 1, isPrimary: true, clientX: 400, clientY: 375 });
    fireEvent.pointerDown(box(), { pointerId: 2, isPrimary: false, clientX: 600, clientY: 375 });
    fireEvent.pointerMove(box(), { pointerId: 2, isPrimary: false, clientX: 800, clientY: 375 });
    // Fingers 200 px → 400 px apart: twice the size.
    expect(scale()).toBe(2);
    fireEvent.pointerUp(box(), { pointerId: 2, isPrimary: false, clientX: 800, clientY: 375 });
    fireEvent.pointerUp(box(), { pointerId: 1, isPrimary: true, clientX: 400, clientY: 375 });
    expect(heading()).toBe("IMG_1.jpg");
  });

  it("loads the original once zoomed past the preview's detail, and shows it", async () => {
    const fetchSpy = vi.fn(async () => okResponse("jpeg"));
    vi.stubGlobal("fetch", fetchSpy);
    const { request } = await open();
    previewLoaded(1600);

    // 1.5× of a 1000 px wide fit = 1500 px: the 1600 px preview is still enough.
    fireEvent.keyDown(window, { key: "+" });
    expect(fetchSpy).not.toHaveBeenCalled();
    // 2.25× = 2250 px: load the original.
    fireEvent.keyDown(window, { key: "+" });
    expect(await screen.findByText("Loading full resolution")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toMatch(/^blob:/));
    expect(fetchSpy).toHaveBeenCalledWith(original, expect.anything());
    expect(request.mock.calls.filter(([, path]) => path.endsWith("/download-url"))).toHaveLength(1);
    expect(screen.queryByText("Loading full resolution")).toBeNull();

    // Zooming out and in again doesn't load it twice.
    await act(async () => fireEvent.keyDown(window, { key: "0" }));
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "+" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview when the original can't be shown (HEIC outside Safari)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse("heic")),
    );
    const decode = vi.fn(() => Promise.reject(new Error("unsupported")));
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = decode;
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const heic = testPhoto(1, { contentType: "image/heic", fileName: "IMG_1.heic" });
    await open(heic);
    previewLoaded(1600);
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "+" });
    await waitFor(() => expect(decode).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Loading full resolution")).toBeNull());
    expect(screen.getByRole("img").getAttribute("src")).toBe(heic.previewUrl);
    warn.mockRestore();
  });
});

// Keeps the photo list used above in sync with the fixtures (IDs 0–2).
it("fixture IDs", () => {
  expect(testPhotoPage(0, 3).items.map((p) => p.photoId)).toEqual([
    testId(0),
    testId(1),
    testId(2),
  ]);
});
