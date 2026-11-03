import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { refreshAfterUpload } from "../src/queries/photos";
import { fileKey } from "../src/upload/batches";
import type { UploadQueue } from "../src/upload/queue";
import {
  controlledPost,
  fakeApi,
  fakeAuth,
  MemoryBatchStore,
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
  it("queues picked files and shows one progress bar for all of them, no file list", async () => {
    const { api, queue, calls } = setup();
    await renderAt("/upload", { api, uploads: queue });

    pick([testFile("IMG_1.jpg", 1000), testFile("IMG_2.jpg", 1000)]);
    await waitFor(() => expect(calls).toHaveLength(2));
    calls[0]!.progress(0.4);

    expect(await screen.findByRole("heading", { name: "0 of 2 uploaded" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("progressbar", { name: "All uploads" })).toHaveProperty(
        "ariaValueNow",
        "20",
      ),
    );
    // Only the overall bar (user request 2026-11-03): no rows, names or per-file bars.
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.queryByText("IMG_1.jpg")).toBeNull();
    expect(screen.queryByText("IMG_2.jpg")).toBeNull();

    calls[0]!.resolve();
    expect(await screen.findByRole("heading", { name: "1 of 2 uploaded" })).toBeTruthy();
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

  it("sums up skipped files by reason, with their names on request (13.1b)", async () => {
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });

    pick([
      testFile("notes.pdf", 10, "application/pdf"),
      // AVI isn't one of the video formats taken (FR-VID-1: MP4, MOV).
      testFile("clip.avi", 10, "video/x-msvideo"),
      testFile("empty.jpg", 0),
      testFile("IMG_1.jpg"),
      testFile("IMG_2.jpg"),
    ]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("2 added · 3 files skipped");
    const groups = within(alert)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(groups).toEqual([
      "2 aren't photos or videos the app takes (only JPEG, PNG, WebP, HEIC, MP4, MOV)",
      "1 is empty",
    ]);
    expect(alert.textContent).not.toContain("notes.pdf");

    fireEvent.click(within(alert).getByRole("button", { name: "Show the files" }));
    expect(alert.textContent).toContain("notes.pdf: Not a supported type");
    expect(alert.textContent).toContain("empty.jpg: The file is empty");
    fireEvent.click(within(alert).getByRole("button", { name: "Hide the files" }));
    expect(alert.textContent).not.toContain("notes.pdf");

    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists at most 200 skipped file names", async () => {
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });
    pick(Array.from({ length: 250 }, (_, i) => testFile(`clip_${i}.avi`, 10, "video/x-msvideo")));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("250 files skipped");
    expect(alert.textContent).not.toContain("added");
    fireEvent.click(within(alert).getByRole("button", { name: "Show the files" }));
    expect(alert.textContent).toContain("clip_199.avi");
    expect(alert.textContent).not.toContain("clip_200.avi");
    expect(alert.textContent).toContain("and 50 more");
  });

  it("shows permanent failures with their reason, and retries all of them on request", async () => {
    let refused = true;
    const { api, queue } = setup({
      "POST /photos/upload-url": () =>
        refused ? new ApiRequestError("UNSUPPORTED_MEDIA_TYPE", "no", 415) : uploadUrl,
    });
    await renderAt("/upload", { api, uploads: queue });

    pick([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);
    const alert = await screen.findByRole("alert");
    await waitFor(() =>
      expect(alert.textContent).toContain("Something went wrong: 2 photos couldn't be uploaded."),
    );
    expect(alert.textContent).toContain("This file type isn't supported");

    refused = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Something went wrong/)).toBeNull());
    await waitFor(() =>
      expect(queue.getSnapshot().map((e) => e.status)).toEqual(["uploading", "uploading"]),
    );
  });

  it("groups failures by reason and removes them on request", async () => {
    const { api, queue } = setup({
      "POST /photos/upload-url": () => new ApiRequestError("UNSUPPORTED_MEDIA_TYPE", "no", 415),
    });
    await renderAt("/upload", { api, uploads: queue });
    pick([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);

    const alert = await screen.findByText(/2 photos couldn't be uploaded/);
    const box = alert.closest("[role=alert]") as HTMLElement;
    expect(
      within(box)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringMatching(/^2 × This file type isn't supported/)]);
    fireEvent.click(within(box).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(0));
    await waitFor(() => expect(screen.queryByText(/Something went wrong/)).toBeNull());
  });

  it("says when uploads wait to retry after a connection problem", async () => {
    const { api, queue } = setup({
      "POST /photos/upload-url": () => new ApiRequestError("INTERNAL_ERROR", "x", 500),
    });
    await renderAt("/upload", { api, uploads: queue });
    pick([testFile("IMG_1.jpg")]);
    expect(
      await screen.findByText("Connection problem: 1 photo will be retried shortly."),
    ).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
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

  it("refreshes the gallery when an upload finishes, so the photo appears once ready", async () => {
    // Processed right away here; a photo still processing isn't shown (gallery tests).
    const processed = {
      items: [
        {
          photoId: testId(1),
          status: "ready",
          fileName: "NEW_1.jpg",
          contentType: "image/jpeg",
          sizeBytes: 1000,
          width: 400,
          height: 300,
          takenAt: new Date().toISOString(),
          uploadedAt: new Date().toISOString(),
          thumbUrl: "https://d.example/users/u/thumbs/1.jpg",
          previewUrl: "https://d.example/users/u/previews/1.jpg",
        },
      ],
      nextCursor: null,
    };
    let uploaded = false;
    const { api } = fakeApi({
      ...defaultResponses,
      "POST /photos/upload-url": uploadUrl,
      "GET /photos": () => (uploaded ? processed : { items: [], nextCursor: null }),
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
    expect(await screen.findByRole("link", { name: "NEW_1.jpg" })).toBeTruthy();
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
    // Explained by the banner only, not again as "something went wrong".
    expect(screen.queryByText(/Something went wrong/)).toBeNull();

    full = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry all" }));
    await waitFor(() => expect(screen.queryByText(/Storage full/)).toBeNull());
  });

  it("asks before queuing photos that need more space than is left (13.1e)", async () => {
    const { api, queue } = setup({ "GET /me": usage(2 * GiB - 1500) });
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);

    // A file the app doesn't take doesn't count: it would be skipped anyway.
    const files = [
      testFile("IMG_1.jpg", 1000),
      testFile("IMG_2.jpg", 1000),
      testFile("clip.avi", 5000, "video/x-msvideo"),
    ];
    pick(files);
    let dialog = await screen.findByRole("alertdialog", {
      name: "Not enough storage for all of these",
    });
    expect(dialog.textContent).toContain("These photos need 2.0 KB, but only 1.5 KB is left.");
    expect(queue.getSnapshot()).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(queue.getSnapshot()).toHaveLength(0);

    pick(files);
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload anyway" }));
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(2));
    expect(await screen.findByText("2 added · 1 file skipped")).toBeTruthy();
  });

  it("doesn't ask when the photos fit", async () => {
    const { api, queue } = setup({ "GET /me": usage(GiB) });
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);
    pick([testFile("IMG_1.jpg", 1000)]);
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
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
    expect(await screen.findByRole("heading", { name: /of 1 uploaded/ })).toBeTruthy();
    // Not a photo: explained like a picked file.
    expect(await screen.findByText("1 added · 1 file skipped")).toBeTruthy();
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

  it("shows the whole queue's progress, pauses, resumes and cancels it (13.1d)", async () => {
    const { api, queue, calls } = setup();
    await renderAt("/upload", { api, uploads: queue });
    pick([testFile("IMG_1.jpg", 1000), testFile("IMG_2.jpg", 1000), testFile("IMG_3.jpg", 2000)]);
    await waitFor(() => expect(calls).toHaveLength(3));
    calls[0]!.resolve();

    const header = (await screen.findByRole("heading", { name: "1 of 3 uploaded" })).closest(
      "header",
    )!;
    await waitFor(() => expect(header.textContent).toContain("1000 B of 3.9 KB"));
    expect(within(header).getByRole("progressbar", { name: "All uploads" })).toBeTruthy();

    fireEvent.click(within(header).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(header.textContent).toContain("Paused"));
    fireEvent.click(within(header).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(within(header).getByRole("button", { name: "Pause" })).toBeTruthy());

    fireEvent.click(within(header).getByRole("button", { name: "Cancel all" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Cancel 2 uploads?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel uploads" }));
    await waitFor(() => expect(queue.getSnapshot().map((entry) => entry.status)).toEqual(["done"]));
  });

  it("says when another tab is uploading a large batch (13.1d)", async () => {
    const { api, queue } = setup();
    vi.spyOn(queue, "getOtherTabsRemaining").mockReturnValue(1234);
    await renderAt("/upload", { api, uploads: queue });
    expect(await screen.findByText(/Uploading 1,234 photos in\s+another tab/)).toBeTruthy();
  });

  it("offers to continue a large batch whose tab was closed (13.1f)", async () => {
    const { api } = setup();
    const batches = new MemoryBatchStore();
    const inFolder = (name: string) => {
      const file = testFile(name);
      Object.defineProperty(file, "webkitRelativePath", { value: `Trip/${name}` });
      return file;
    };
    const picked = [inFolder("A.jpg"), inFolder("B.jpg"), inFolder("C.jpg")];
    await batches.put({
      batchId: "b1",
      userId: testUser.sub,
      label: "Trip",
      createdAt: 0,
      heartbeatAt: Date.now() - 60_000,
      keys: picked.map(fileKey),
      done: [fileKey(picked[0]!)],
    });
    const { queue } = testUploadQueue(api, { post: () => new Promise(() => {}), batches });
    await renderAt("/upload", { api, uploads: queue });

    const notice = await screen.findByText("2 photos from “Trip” weren't uploaded");
    expect(notice.closest("[role=status]")!.textContent).toContain("Choose the folder again");

    pick(picked, "upload-folder");
    expect(await screen.findByText("1 photo was uploaded before and was skipped.")).toBeTruthy();
    await waitFor(() =>
      expect(queue.getSnapshot().map((entry) => entry.fileName)).toEqual(["B.jpg", "C.jpg"]),
    );
    // Going on: no longer offered.
    await waitFor(() => expect(screen.queryByText(/weren't uploaded/)).toBeNull());
  });

  it("dismisses an interrupted batch for good (13.1f)", async () => {
    const { api } = setup();
    const batches = new MemoryBatchStore();
    await batches.put({
      batchId: "b1",
      userId: testUser.sub,
      label: null,
      createdAt: 0,
      heartbeatAt: Date.now() - 60_000,
      keys: ["a", "b"],
      done: [],
    });
    const { queue } = testUploadQueue(api, { batches });
    await renderAt("/upload", { api, uploads: queue });
    const notice = (await screen.findByText("2 photos of 2 weren't uploaded")).closest(
      "[role=status]",
    ) as HTMLElement;
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/weren't uploaded/)).toBeNull());
    expect(batches.records.size).toBe(0);
  });
});

describe("mobile data (13.1l)", () => {
  const MiB = 1024 ** 2;
  /** Photos that claim `mb` MB each, without allocating them. */
  const bigPhotos = (count: number, mb = 45) =>
    Array.from({ length: count }, (_, n) => {
      const file = testFile(`IMG_${n}.jpg`);
      Object.defineProperty(file, "size", { value: mb * MiB });
      return file;
    });

  function connect(info: { type?: string; saveData?: boolean } | undefined) {
    const connection = info && Object.assign(new EventTarget(), info);
    Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
    return connection;
  }

  afterEach(() => {
    connect(undefined);
    vi.restoreAllMocks();
  });

  it("asks before a big pick on mobile data; Not now queues nothing", async () => {
    connect({ type: "cellular" });
    const { api, queue } = setup();
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);

    pick(bigPhotos(5)); // 225 MB
    let dialog = await screen.findByRole("alertdialog", { name: "Upload over mobile data?" });
    expect(dialog.textContent).toContain("You're on mobile data. These photos are 225 MB");
    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(queue.getSnapshot()).toHaveLength(0);

    pick(bigPhotos(5));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload anyway" }));
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(5));
    expect(await screen.findByText("Uploading over mobile data.")).toBeTruthy();
  });

  it("doesn't ask for small picks or on Wi-Fi, and follows connection changes", async () => {
    const connection = connect({ type: "cellular" })!;
    const { api, queue } = setup();
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);
    pick(bigPhotos(4)); // 180 MB
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(4));
    expect(screen.getByText("Uploading over mobile data.")).toBeTruthy();

    Object.assign(connection, { type: "wifi" });
    act(() => void connection.dispatchEvent(new Event("change")));
    expect(screen.queryByText("Uploading over mobile data.")).toBeNull();
    pick(bigPhotos(5));
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(9));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("doesn't ask when the browser doesn't tell the connection type", async () => {
    const { api, queue } = setup();
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);
    pick(bigPhotos(5));
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(5));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("says so when Data Saver is on", async () => {
    connect({ type: "wifi", saveData: true });
    const { api, queue } = setup();
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);
    pick(bigPhotos(5));
    const dialog = await screen.findByRole("alertdialog", { name: "Upload over mobile data?" });
    expect(dialog.textContent).toContain("Data Saver is on. These photos are 225 MB.");
  });

  it("asks about storage first, then about mobile data", async () => {
    connect({ type: "cellular" });
    const { api, queue } = setup({
      "GET /me": { ...testMe, usage: { bytesUsed: 0, photoCount: 0, quotaBytes: 100 * MiB } },
    });
    const { router } = await renderAt("/upload", { api, uploads: queue });
    await usageLoaded(router);
    pick(bigPhotos(5));
    let dialog = await screen.findByRole("alertdialog", {
      name: "Not enough storage for all of these",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload anyway" }));
    dialog = await screen.findByRole("alertdialog", { name: "Upload over mobile data?" });
    expect(queue.getSnapshot()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload anyway" }));
    await waitFor(() => expect(queue.getSnapshot()).toHaveLength(5));
  });

  it("tells phone users that big imports are a computer's job", async () => {
    const { api, queue } = setup();
    await renderAt("/upload", { api, uploads: queue });
    expect(screen.queryByText(/Moving a whole photo library/)).toBeNull();
    cleanup();

    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile",
    );
    const phone = setup();
    await renderAt("/upload", { api: phone.api, uploads: phone.queue });
    expect(
      await screen.findByText(/Moving a whole photo library\? It's easier on a computer/),
    ).toBeTruthy();
  });
});
