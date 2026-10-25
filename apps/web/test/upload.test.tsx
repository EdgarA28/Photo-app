import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { refreshAfterUpload } from "../src/queries/photos";
import type { UploadQueue } from "../src/upload/queue";
import { controlledPost, fakeApi, testFile, testId, testUploadQueue, testUser } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const uploadUrl = {
  photoId: testId(1),
  upload: { url: "https://photos.s3.amazonaws.com/", fields: { key: "k" } },
};

function setup(responses: Record<string, unknown> = {}) {
  const { api, request } = fakeApi({
    ...defaultResponses,
    "POST /photos/upload-url": uploadUrl,
    ...responses,
  });
  const { post, calls } = controlledPost();
  const { queue, store } = testUploadQueue(api, { post });
  return { api, request, queue, store, calls };
}

function pick(files: File[], testId = "upload-picker") {
  const input = screen.getByTestId(testId);
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

describe("upload page (FR-UP-1/5/6)", () => {
  it("queues picked files and shows each with its progress", async () => {
    const { api, queue, calls } = setup();
    await renderAt("/upload", { api, uploads: queue });

    pick([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);
    await waitFor(() => expect(calls).toHaveLength(2));
    calls[0]!.progress(0.4);

    expect(await screen.findByRole("progressbar", { name: "IMG_1.jpg" })).toHaveProperty(
      "ariaValueNow",
      "40",
    );
    expect(screen.getByText(/Uploading 40%/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "0 of 2 uploaded" })).toBeTruthy();

    calls[0]!.resolve();
    expect(await screen.findByRole("heading", { name: "1 of 2 uploaded" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(await screen.findByRole("heading", { name: "0 of 1 uploaded" })).toBeTruthy();
  });

  it("accepts dropped files and the camera", async () => {
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });

    const zone = screen.getByText(/Drag photos here/).closest("[class*='border-dashed']")!;
    fireEvent.drop(zone, { dataTransfer: { files: [testFile("dropped.jpg")], types: ["Files"] } });
    pick([testFile("camera.jpg")], "upload-camera");

    await waitFor(() =>
      expect(queue.getSnapshot().map((e) => e.fileName)).toEqual(["dropped.jpg", "camera.jpg"]),
    );
  });

  it("says which files weren't added and why", async () => {
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });

    pick([testFile("notes.pdf", 10, "application/pdf"), testFile("IMG_1.jpg")]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1 file wasn't added");
    expect(alert.textContent).toContain("notes.pdf: Not a supported type");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a permanent failure with its reason, and retries it on request (FR-UP-7)", async () => {
    let full = true;
    const { api, queue } = setup({
      "POST /photos/upload-url": () =>
        full ? new ApiRequestError("QUOTA_EXCEEDED", "over", 413) : uploadUrl,
    });
    await renderAt("/upload", { api, uploads: queue });

    pick([testFile("IMG_1.jpg")]);
    expect(await screen.findByText(/Your storage is full/)).toBeTruthy();

    full = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry IMG_1.jpg" }));
    expect(await screen.findByText(/Uploading 0%/)).toBeTruthy();
  });

  it("cancels an upload", async () => {
    const { api, queue, calls } = setup();
    await renderAt("/upload", { api, uploads: queue });
    pick([testFile("IMG_1.jpg")]);
    await waitFor(() => expect(calls).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel IMG_1.jpg" }));
    await waitFor(() => expect(screen.queryByText("IMG_1.jpg")).toBeNull());
    expect(calls[0]!.signal?.aborted).toBe(true);
  });
});

describe("uploads in the gallery and nav (FR-UP-6)", () => {
  it("shows queued and uploading files at the top of the gallery, linking to /upload", async () => {
    const { api, queue, calls } = setup();
    await renderAt("/gallery", { api, uploads: queue });
    expect(await screen.findByText("No photos yet.")).toBeTruthy();

    await queue.add([1, 2, 3, 4].map((n) => testFile(`NEW_${n}.jpg`)));
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[0]!.progress(0.5);

    const uploads = await screen.findByRole("region", { name: "Uploads" });
    const tiles = within(uploads).getAllByRole("link");
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual([
      "NEW_1.jpg, uploading",
      "NEW_2.jpg, uploading",
      "NEW_3.jpg, uploading",
      "NEW_4.jpg, waiting to upload",
    ]);
    expect(tiles[0]!.getAttribute("href")).toBe("/upload");
    expect(within(tiles[0]!).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.queryByText("No photos yet.")).toBeNull();
    // Nav badge: waiting + running.
    expect(screen.getAllByLabelText("4 uploading").length).toBeGreaterThan(0);
  });

  it("refreshes the gallery when an upload finishes, so it appears as processing", async () => {
    const pending = {
      items: [
        {
          photoId: testId(1),
          status: "pending",
          fileName: "NEW_1.jpg",
          contentType: "image/jpeg",
          sizeBytes: 1000,
          width: null,
          height: null,
          takenAt: new Date().toISOString(),
          uploadedAt: new Date().toISOString(),
          thumbUrl: null,
          previewUrl: null,
        },
      ],
      nextCursor: null,
    };
    let uploaded = false;
    const { api } = fakeApi({
      ...defaultResponses,
      "POST /photos/upload-url": uploadUrl,
      "GET /photos": () => (uploaded ? pending : { items: [], nextCursor: null }),
    });
    let queue: UploadQueue | undefined;
    await renderAt("/gallery", {
      api,
      // As in main.tsx: invalidate the gallery once the file is in S3.
      uploads: (queryClient) =>
        (queue = testUploadQueue(api, {
          post: async () => {
            uploaded = true;
          },
          onUploaded: () => refreshAfterUpload(queryClient),
        }).queue),
    });
    expect(await screen.findByText("No photos yet.")).toBeTruthy();

    await queue!.add([testFile("NEW_1.jpg")]);
    expect(await screen.findByRole("link", { name: "NEW_1.jpg, processing" })).toBeTruthy();
  });

  it("doesn't show uploads inside an album", async () => {
    const album = { albumId: testId(900), name: "Trip", createdAt: "2026-10-01T10:00:00.000Z" };
    const { api, queue } = setup({
      "GET /albums": {
        items: [{ ...album, coverPhotoId: null, coverThumbUrl: null, photoCount: 0 }],
      },
      [`GET /albums/${testId(900)}/photos`]: { items: [], nextCursor: null },
    });
    await queue.start(testUser.sub);
    await queue.add([testFile("NEW_1.jpg")]);
    await renderAt(`/gallery?album=${testId(900)}`, { api, uploads: queue });
    expect(await screen.findByText("This album has no photos yet.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Uploads" })).toBeNull();
  });
});
