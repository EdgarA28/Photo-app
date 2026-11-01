import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { refreshAfterUpload } from "../src/queries/photos";
import type { UploadQueue } from "../src/upload/queue";
import {
  controlledPost,
  fakeApi,
  fakeAuth,
  MemoryShareInbox,
  testFile,
  testId,
  testMe,
  testUploadQueue,
  testUser,
} from "./fakes";
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
    // A finished upload leaves the list at once (user request 2026-11-01); the count stays.
    expect(screen.queryByText("IMG_1.jpg")).toBeNull();
    expect(screen.getByText("IMG_2.jpg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear finished" })).toBeNull();
  });

  it("accepts dropped files and the camera", async () => {
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });

    const zone = screen
      .getByText(/Drag photos or a folder here/)
      .closest("[class*='border-dashed']")!;
    fireEvent.drop(zone, { dataTransfer: { files: [testFile("dropped.jpg")], types: ["Files"] } });
    pick([testFile("camera.jpg")], "upload-camera");

    await waitFor(() =>
      // A drop is handed over after the (folder) check, so it may come second.
      expect(
        queue
          .getSnapshot()
          .map((e) => e.fileName)
          .sort(),
      ).toEqual(["camera.jpg", "dropped.jpg"]),
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

  it("shows a permanent failure with its reason, and retries it on request", async () => {
    let refused = true;
    const { api, queue } = setup({
      "POST /photos/upload-url": () =>
        refused ? new ApiRequestError("UNSUPPORTED_MEDIA_TYPE", "no", 415) : uploadUrl,
    });
    await renderAt("/upload", { api, uploads: queue });

    pick([testFile("IMG_1.jpg")]);
    expect(await screen.findByText(/This file type isn't supported/)).toBeTruthy();

    refused = false;
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
    // The UI hears about changes once per animation frame (13.1-0).
    await waitFor(() =>
      expect(within(tiles[0]!).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50"),
    );
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

/** The upload page loads the usage in the background; wait until it has it. */
const usageLoaded = (router: Awaited<ReturnType<typeof renderAt>>["router"]) =>
  waitFor(() => expect(router.options.context.queryClient.getQueryData(["me"])).toBeDefined());

describe("storage full (FR-UP-7, 8.14)", () => {
  const GiB = 1024 ** 3;
  const usage = (bytesUsed: number) => ({
    ...testMe,
    usage: { bytesUsed, photoCount: 40, quotaBytes: 2 * GiB },
  });

  it("explains refused uploads once, with usage, a way to free space and Retry all", async () => {
    let full = true;
    const { api, queue } = setup({
      "GET /me": usage(2 * GiB - 1000),
      "POST /photos/upload-url": () =>
        full ? new ApiRequestError("QUOTA_EXCEEDED", "over", 413) : uploadUrl,
    });
    await renderAt("/upload", { api, uploads: queue });
    pick([testFile("IMG_1.jpg", 900), testFile("IMG_2.jpg", 900)]);

    const banner = await screen.findByText(/Storage full: 2 photos couldn't be uploaded/);
    const alert = banner.closest("[role=alert]") as HTMLElement;
    expect(alert.textContent).toContain("2.0 GB of 2.0 GB used.");
    expect(
      within(alert)
        .getByRole("link", { name: "Free up space in the Gallery" })
        .getAttribute("href"),
    ).toBe("/gallery");
    // The rows only say why in short.
    expect(screen.getAllByText(/Not enough storage/)).toHaveLength(2);

    full = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry all" }));
    await waitFor(() => expect(screen.queryByText(/Storage full/)).toBeNull());
    expect(screen.queryAllByText(/Not enough storage/)).toHaveLength(0);
  });

  it("warns when the picked files need more space than is left, but still queues them", async () => {
    const { api, queue } = setup({ "GET /me": usage(2 * GiB - 1500) });
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);

    pick([testFile("IMG_1.jpg", 1000), testFile("IMG_2.jpg", 1000)]);
    const warning = await screen.findByText(/These photos need/);
    expect(warning.textContent).toBe(
      "These photos need 2.0 KB, but only 1.5 KB is left. Some won't upload until you free up space.",
    );
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(2));
  });

  it("doesn't warn when the files fit", async () => {
    const { api, queue } = setup({ "GET /me": usage(GiB) });
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);
    pick([testFile("IMG_1.jpg", 1000)]);
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(1));
    expect(screen.queryByText(/These photos need/)).toBeNull();
  });

  it("retries every failed upload from the list", async () => {
    let refused = true;
    const { api, queue } = setup({
      "POST /photos/upload-url": () =>
        refused ? new ApiRequestError("VALIDATION_ERROR", "bad", 400) : uploadUrl,
    });
    await renderAt("/upload", { api, uploads: queue });
    pick([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);
    await waitFor(() =>
      expect(queue.getSnapshot().map((e) => e.status)).toEqual(["failed", "failed"]),
    );
    refused = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry all failed" }));
    await waitFor(() =>
      expect(queue.getSnapshot().map((e) => e.status)).toEqual(["uploading", "uploading"]),
    );
  });

  it("labels refused uploads in the gallery as storage full", async () => {
    const { api, queue } = setup({
      "POST /photos/upload-url": new ApiRequestError("QUOTA_EXCEEDED", "over", 413),
    });
    await renderAt("/gallery", { api, uploads: queue });
    await queue.add([testFile("NEW_1.jpg")]);
    const tile = await screen.findByRole("link", { name: "NEW_1.jpg, storage full" });
    expect(tile.textContent).toContain("Storage full");
  });
});

describe("photos shared from Android's share sheet (9.6, FR-PWA-4)", () => {
  function inboxWith(...files: File[]) {
    const shareInbox = new MemoryShareInbox();
    shareInbox.files = files;
    return shareInbox;
  }

  it("shows the shared photos and adds them only when the user confirms", async () => {
    const { api, queue, store } = setup();
    const shareInbox = inboxWith(testFile("IMG_1.jpg"), testFile("notes.txt", 10, "text/plain"));
    const { router } = await renderAt("/upload?shared=received", {
      api,
      uploads: queue,
      shareInbox,
    });

    const card = await screen.findByRole("region", { name: "2 photos shared to this app" });
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    // Nothing queued without the user's go-ahead: any website can POST to the share target.
    expect(store.items.size).toBe(0);

    fireEvent.click(within(card).getByRole("button", { name: "Upload" }));
    expect(await screen.findByText("IMG_1.jpg")).toBeTruthy();
    // Not a photo: explained like a picked file.
    expect(await screen.findByText(/1 file wasn't added/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: /shared to this app/ })).toBeNull();
    expect(shareInbox.files).toEqual([]);
    expect([...store.items.values()].map((item) => item.fileName)).toEqual(["IMG_1.jpg"]);
  });

  it("discards the shared photos", async () => {
    const { api, queue, store } = setup();
    const shareInbox = inboxWith(testFile("IMG_1.jpg"));
    await renderAt("/upload", { api, uploads: queue, shareInbox });

    const card = await screen.findByRole("region", { name: "1 photo shared to this app" });
    fireEvent.click(within(card).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /shared/ })).toBeNull());
    expect(shareInbox.files).toEqual([]);
    expect(store.items.size).toBe(0);
  });

  it("keeps the shared photos through a login (signed out when sharing)", async () => {
    const { api, queue } = setup();
    const shareInbox = inboxWith(testFile("IMG_1.jpg"));
    const auth = fakeAuth({ signedIn: false });
    const { router } = await renderAt("/upload?shared=received", {
      api,
      auth,
      uploads: queue,
      shareInbox,
    });
    expect(router.state.location.pathname).toBe("/login");
    expect(shareInbox.files).toHaveLength(1);
    expect(router.state.location.search).toMatchObject({
      redirect: "/upload?shared=received",
    });
  });

  it("uploads only the photos shown; a share arriving meanwhile is offered on its own (9.8)", async () => {
    const { api, queue, store } = setup();
    const shareInbox = inboxWith(testFile("shown.jpg"));
    await renderAt("/upload", { api, uploads: queue, shareInbox });

    const card = await screen.findByRole("region", { name: "1 photo shared to this app" });
    expect(within(card).getByTitle("shown.jpg")).toBeTruthy();
    // Another POST to the share target while the card is up (e.g. from a hostile page).
    shareInbox.files = [testFile("later-1.jpg"), testFile("later-2.jpg")];
    fireEvent.click(within(card).getByRole("button", { name: "Upload" }));

    // The shown photo was replaced, so nothing is uploaded; the newer share waits for a decision.
    expect(await screen.findByRole("region", { name: "2 photos shared to this app" })).toBeTruthy();
    expect(store.items.size).toBe(0);
    expect(shareInbox.files.map((file) => file.name)).toEqual(["later-1.jpg", "later-2.jpg"]);
  });

  it("says how many shared files the service worker left out (9.8)", async () => {
    const { api, queue } = setup();
    await renderAt("/upload?shared=received&skipped=2", { api, uploads: queue });
    expect(await screen.findByText(/2 shared files were left out/)).toBeTruthy();
  });

  it("says so when the service worker couldn't receive them", async () => {
    const { api, queue } = setup();
    await renderAt("/upload?shared=failed", { api, uploads: queue });
    expect(await screen.findByText(/shared photos couldn't be received/)).toBeTruthy();
  });
});

describe("big batches on screen (13.1-0)", () => {
  it('shows at most 20 upload tiles in the gallery, then "+N more"', async () => {
    const { api, queue } = setup();
    await renderAt("/gallery", { api, uploads: queue });
    await queue.add(Array.from({ length: 25 }, (_, i) => testFile(`NEW_${i}.jpg`, 10)));

    const uploads = await screen.findByRole("region", { name: "Uploads" });
    await waitFor(() => expect(within(uploads).getAllByRole("link")).toHaveLength(21));
    const more = within(uploads).getByRole("link", { name: "5 more uploads" });
    expect(more.textContent).toBe("+5 more");
    expect(more.getAttribute("href")).toBe("/upload");
  });

  it("keeps only the rows near the viewport of a long upload list in the page", async () => {
    // jsdom has no layout: rows measure 73 px (the virtualizer reads offsetHeight); the window
    // is 768 px high.
    const height = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === "LI" ? 73 : 0;
      });
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });
    await queue.add(Array.from({ length: 300 }, (_, i) => testFile(`IMG_${i}.jpg`, 10)));

    const heading = await screen.findByRole("heading", { name: "0 of 300 uploaded" });
    const list = heading.closest("section")!;
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(40);
    expect(within(list).getByText("IMG_0.jpg")).toBeTruthy();
    expect(within(list).queryByText("IMG_299.jpg")).toBeNull();
    height.mockRestore();
  });

  it("asks to keep the tab open while a large batch uploads (13.1c)", async () => {
    const { api } = setup();
    const { queue } = testUploadQueue(api, {
      post: () => new Promise(() => {}),
      largeBatchBytes: 1500,
    });
    await renderAt("/upload", { api, uploads: queue });
    pick([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);

    const note = await screen.findByText(/Large upload: keep this tab open/);
    expect(note.textContent).toContain("stops the remaining 2 photos");
    // The browser asks before the tab is closed or reloaded.
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("uploads a picked folder as a large batch (13.1a)", async () => {
    const { api, queue, store } = setup();
    await renderAt("/upload", { api, uploads: queue });
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeTruthy();
    expect(screen.getByTestId("upload-folder").hasAttribute("webkitdirectory")).toBe(true);
    const inFolder = (path: string) => {
      const file = testFile(path.split("/").at(-1)!);
      Object.defineProperty(file, "webkitRelativePath", { value: path });
      return file;
    };
    pick([inFolder("Trip/IMG_1.jpg"), inFolder("Trip/.DS_Store")], "upload-folder");

    expect(await screen.findByText(/Large upload: keep this tab open/)).toBeTruthy();
    expect(queue.getSnapshot().map((entry) => [entry.fileName, entry.memoryOnly])).toEqual([
      ["IMG_1.jpg", true],
    ]);
    expect(store.items.size).toBe(0);
  });

  it("walks a dropped folder (13.1a)", async () => {
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });
    const photo = testFile("IMG_1.jpg");
    const folder = {
      name: "Trip",
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let done = false;
        return {
          readEntries: (resolve: (entries: unknown[]) => void) => {
            const batch = done
              ? []
              : [
                  {
                    name: photo.name,
                    isFile: true,
                    isDirectory: false,
                    file: (r: (f: File) => void) => r(photo),
                  },
                ];
            done = true;
            resolve(batch);
          },
        };
      },
    };
    const zone = screen
      .getByText(/Drag photos or a folder here/)
      .closest("[class*='border-dashed']")!;
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [],
        types: ["Files"],
        items: [{ kind: "file", webkitGetAsEntry: () => folder }],
      },
    });

    await waitFor(() =>
      expect(queue.getSnapshot().map((entry) => entry.fileName)).toEqual(["IMG_1.jpg"]),
    );
    expect(queue.getSnapshot()[0]!.memoryOnly).toBe(true);
  });
});
