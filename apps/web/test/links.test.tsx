import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { fakeApi, fakeAuth, testId, testPhotoPage } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

describe("Share link in the viewer (FR-SHR-8)", () => {
  it("makes a link and copies it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText }, share: undefined });
    const { api, request } = fakeApi({
      ...defaultResponses,
      "GET /photos": testPhotoPage(0, 2),
      "POST /links": { token: TOKEN, path: `/s/${TOKEN}`, expiresAt, photoCount: 1 },
    });
    await renderAt(`/photos/${testId(1)}`, { api });

    fireEvent.click(await screen.findByRole("button", { name: "Share link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share link" });
    const field = await within(dialog).findByRole("textbox", { name: "Link" });
    expect((field as HTMLInputElement).value).toBe(`${window.location.origin}/s/${TOKEN}`);
    expect(dialog.textContent).toContain("for 15 minutes");
    expect(within(dialog).queryByRole("button", { name: "Share…" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Copy link" }));
    await within(dialog).findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/s/${TOKEN}`);
    const posts = request.mock.calls.filter(([m]) => m === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]![2]).toMatchObject({ body: { photoIds: [testId(1)] } });
  });

  it("offers the share sheet where the browser has one", async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, share });
    const { api } = fakeApi({
      ...defaultResponses,
      "GET /photos": testPhotoPage(0, 1),
      "POST /links": { token: TOKEN, path: `/s/${TOKEN}`, expiresAt, photoCount: 1 },
    });
    await renderAt(`/photos/${testId(0)}`, { api });
    fireEvent.click(await screen.findByRole("button", { name: "Share link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Share…" }));
    expect(share).toHaveBeenCalledWith({ url: `${window.location.origin}/s/${TOKEN}` });
  });

  it("isn't offered for photos still processing", async () => {
    const page = testPhotoPage(0, 1);
    page.items[0] = {
      ...page.items[0]!,
      status: "pending",
      thumbUrl: null,
      previewUrl: null,
    } as never;
    const { api } = fakeApi({ ...defaultResponses, "GET /photos": page });
    await renderAt(`/photos/${testId(0)}`, { api });
    await screen.findByRole("button", { name: "Download original" });
    expect(screen.queryByRole("button", { name: "Share link" })).toBeNull();
  });
});

describe("Share link in the gallery's select mode (FR-SHR-8)", () => {
  it("makes one link for the picked photos and says which were left out", async () => {
    vi.stubGlobal("navigator", { ...navigator, share: undefined });
    const { api, request } = fakeApi({
      ...defaultResponses,
      "GET /photos": testPhotoPage(0, 3),
      "POST /links": { token: TOKEN, path: `/s/${TOKEN}`, expiresAt, photoCount: 1 },
    });
    await renderAt("/gallery", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("button", { name: "IMG_0.jpg" }));
    fireEvent.click(await screen.findByRole("button", { name: "IMG_2.jpg" }));
    const toolbar = screen.getByRole("toolbar");

    fireEvent.click(within(toolbar).getByRole("button", { name: "Share link" }));

    const dialog = await screen.findByRole("dialog", { name: "Share link" });
    expect(dialog.textContent).toContain("these 2 photos");
    await within(dialog).findByRole("textbox", { name: "Link" });
    expect(dialog.textContent).toContain("1 photo ·");
    expect(within(dialog).getByRole("status").textContent).toBe(
      "1 photo still processing or in the trash was left out.",
    );
    const post = request.mock.calls.find(([m]) => m === "POST")!;
    expect(post[2]).toMatchObject({ body: { photoIds: [testId(0), testId(2)] } });
  });
});

describe("public link page /s/$token (FR-SHR-8)", () => {
  const linked = (n: number) => ({
    photoId: testId(n),
    thumbUrl: `/users/u/thumbs/${n}.jpg?Expires=1&Signature=s`,
    previewUrl: `/users/u/previews/${n}.jpg?Expires=1&Signature=s`,
    width: 4000,
    height: 3000,
  });
  const signedOut = () => fakeAuth({ signedIn: false });

  it("one photo: shown full screen and downloadable, signed out", async () => {
    const { api, request } = fakeApi({
      [`GET /links/${TOKEN}`]: { photos: [linked(0)], expiresAt },
      [`GET /links/${TOKEN}/photos/${testId(0)}/download-url`]: {
        url: "https://s3.example/original",
        expiresAt,
      },
    });
    await renderAt(`/s/${TOKEN}`, { api, auth: signedOut() });

    const img = await screen.findByRole("img", { name: "Shared photo" });
    expect(img.getAttribute("src")).toBe(linked(0).previewUrl);
    expect(screen.getByText(/Link works until/)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to all photos" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    await waitFor(() =>
      expect(request.mock.calls.map(([, path]) => path)).toContain(
        `/links/${TOKEN}/photos/${testId(0)}/download-url`,
      ),
    );
  });

  it("several photos: a grid, a tap opens one large with prev/next and its own download", async () => {
    const { api, request } = fakeApi({
      [`GET /links/${TOKEN}`]: { photos: [linked(0), linked(1), linked(2)], expiresAt },
      [`GET /links/${TOKEN}/photos/${testId(2)}/download-url`]: {
        url: "https://s3.example/original",
        expiresAt,
      },
    });
    await renderAt(`/s/${TOKEN}`, { api, auth: signedOut() });

    expect(await screen.findByRole("heading", { name: "3 shared photos" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Photo 2" }));
    expect((await screen.findByRole("img", { name: "Photo 2" })).getAttribute("src")).toBe(
      linked(1).previewUrl,
    );
    expect(screen.getByText("2 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    await screen.findByRole("img", { name: "Photo 3" });
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    await waitFor(() =>
      expect(request.mock.calls.map(([, path]) => path)).toContain(
        `/links/${TOKEN}/photos/${testId(2)}/download-url`,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to all photos" }));
    expect(await screen.findByRole("heading", { name: "3 shared photos" })).toBeTruthy();
  });

  it("says when the link has expired", async () => {
    const { api } = fakeApi({
      [`GET /links/${TOKEN}`]: new ApiRequestError("NOT_FOUND", "Link not found or expired", 404),
    });
    await renderAt(`/s/${TOKEN}`, { api, auth: signedOut() });
    expect((await screen.findByRole("status")).textContent).toBe(
      "This link has expired or doesn't exist anymore.",
    );
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
  });
});
