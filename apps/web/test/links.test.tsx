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
      [`POST /photos/${testId(1)}/links`]: { token: TOKEN, path: `/s/${TOKEN}`, expiresAt },
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
    expect(request.mock.calls.filter(([m]) => m === "POST")).toHaveLength(1);
  });

  it("offers the share sheet where the browser has one", async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, share });
    const { api } = fakeApi({
      ...defaultResponses,
      "GET /photos": testPhotoPage(0, 1),
      [`POST /photos/${testId(0)}/links`]: { token: TOKEN, path: `/s/${TOKEN}`, expiresAt },
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

describe("public link page /s/$token (FR-SHR-8)", () => {
  const linked = {
    photoId: testId(0),
    previewUrl: "/users/u/previews/p.jpg?Expires=1&Signature=s",
    width: 4000,
    height: 3000,
    expiresAt,
  };

  it("shows the photo and downloads the original, signed out", async () => {
    const { api, request } = fakeApi({
      [`GET /links/${TOKEN}`]: linked,
      [`GET /links/${TOKEN}/download-url`]: { url: "https://s3.example/original", expiresAt },
    });
    await renderAt(`/s/${TOKEN}`, { api, auth: fakeAuth({ signedIn: false }) });

    const img = await screen.findByRole("img", { name: "Shared photo" });
    expect(img.getAttribute("src")).toBe(linked.previewUrl);
    expect(screen.getByText(/Link works until/)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download original" }));
    await waitFor(() =>
      expect(request.mock.calls.map(([, path]) => path)).toContain(`/links/${TOKEN}/download-url`),
    );
  });

  it("says when the link has expired", async () => {
    const { api } = fakeApi({
      [`GET /links/${TOKEN}`]: new ApiRequestError("NOT_FOUND", "Link not found or expired", 404),
    });
    await renderAt(`/s/${TOKEN}`, { api, auth: fakeAuth({ signedIn: false }) });
    expect((await screen.findByRole("status")).textContent).toBe(
      "This link has expired or doesn't exist anymore.",
    );
    expect(screen.queryByRole("button", { name: "Download original" })).toBeNull();
  });
});
