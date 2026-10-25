import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api/api";
import type { Request } from "../src/api/client";

const P = "01JB2Z3M4N5P6Q7R8S9T0V1W2X";
const A = "01JB2Z3M4N5P6Q7R8S9T0V1W2Y";
const U = "04e8b4b8-0000-4000-8000-000000000001";

describe("api routes (ARCHITECTURE §9)", () => {
  const request = vi.fn(async (..._args: unknown[]) => undefined);
  const api = createApi(request as unknown as Request);

  it.each<[string, () => Promise<unknown>, string, string]>([
    ["me.get", () => api.me.get(), "GET", "/me"],
    ["me.setUsername", () => api.me.setUsername("ana"), "PUT", "/me/username"],
    ["photos.list", () => api.photos.list({ sort: "taken-asc" }), "GET", "/photos"],
    ["photos.get", () => api.photos.get(P), "GET", `/photos/${P}`],
    ["photos.get (shared, 7.4)", () => api.photos.get(P, A), "GET", `/photos/${P}`],
    [
      "photos.uploadUrl",
      () => api.photos.uploadUrl({ fileName: "a.jpg", contentType: "image/jpeg", sizeBytes: 1 }),
      "POST",
      "/photos/upload-url",
    ],
    ["photos.downloadUrl", () => api.photos.downloadUrl(P, A), "GET", `/photos/${P}/download-url`],
    ["photos.delete", () => api.photos.delete(P), "DELETE", `/photos/${P}`],
    ["albums.list", () => api.albums.list(), "GET", "/albums"],
    ["albums.create", () => api.albums.create({ name: "Trip" }), "POST", "/albums"],
    ["albums.update", () => api.albums.update(A, { name: "Trip 2" }), "PATCH", `/albums/${A}`],
    ["albums.delete", () => api.albums.delete(A), "DELETE", `/albums/${A}`],
    ["albums.photos", () => api.albums.photos(A), "GET", `/albums/${A}/photos`],
    [
      "albums.addPhotos",
      () => api.albums.addPhotos(A, { photoIds: [P] }),
      "POST",
      `/albums/${A}/photos`,
    ],
    [
      "albums.removePhoto",
      () => api.albums.removePhoto(A, P),
      "DELETE",
      `/albums/${A}/photos/${P}`,
    ],
    ["albums.shares", () => api.albums.shares(A), "GET", `/albums/${A}/shares`],
    [
      "albums.share",
      () => api.albums.share(A, { email: "b@example.com" }),
      "POST",
      `/albums/${A}/shares`,
    ],
    ["albums.unshare", () => api.albums.unshare(A, U), "DELETE", `/albums/${A}/shares/${U}`],
    ["sharedAlbums.list", () => api.sharedAlbums.list(), "GET", "/shared-albums"],
  ])("%s → %s %s", async (_, call, method, path) => {
    await call();
    expect(request.mock.lastCall?.slice(0, 2)).toEqual([method, path]);
  });

  it("passes the shared album to the download URL", async () => {
    await api.photos.downloadUrl(P, A);
    expect(request).toHaveBeenLastCalledWith(
      "GET",
      `/photos/${P}/download-url`,
      expect.objectContaining({ query: { albumId: A } }),
    );
  });

  it("passes the shared album to the single photo (7.4)", async () => {
    await api.photos.get(P, A);
    expect(request).toHaveBeenLastCalledWith(
      "GET",
      `/photos/${P}`,
      expect.objectContaining({ query: { albumId: A } }),
    );
  });

  it("encodes path segments", async () => {
    await api.photos.get("../me");
    expect(request.mock.lastCall?.slice(0, 2)).toEqual(["GET", "/photos/..%2Fme"]);
  });
});
