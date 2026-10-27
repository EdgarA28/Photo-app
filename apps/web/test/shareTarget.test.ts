// @vitest-environment node
// Node's Request/FormData/Blob: real multipart parsing, and Blobs that survive fake-indexeddb.
import { MAX_UPLOAD_BYTES } from "@photo-app/shared";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SHARED_FILES,
  receiveShare,
  SHARE_FILES_FIELD,
  SHARE_TARGET_PATH,
} from "../src/pwa/shareTarget";
import { createIdbShareInbox, type ShareInbox } from "../src/upload/shareInbox";

const ORIGIN = "https://photos.example";

function share(files: File[]) {
  const form = new FormData();
  for (const file of files) form.append(SHARE_FILES_FIELD, file);
  form.append("title", "ignored text field");
  return new Request(ORIGIN + SHARE_TARGET_PATH, { method: "POST", body: form });
}

const jpeg = (name: string, bytes = 1) =>
  new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });

/** Everything waiting, taken by the ids the page would have shown. */
async function takeAll(inbox: ShareInbox) {
  return inbox.take((await inbox.list()).map((photo) => photo.id));
}

afterEach(() => vi.restoreAllMocks());

describe("share target (9.6, FR-PWA-4)", () => {
  it("stores the shared files and continues on /upload with GET", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    const photo = new File(["jpeg bytes"], "IMG_1.jpg", { type: "image/jpeg" });
    const response = await receiveShare(share([photo, new File(["x"], "b.png")]), inbox);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/upload?shared=received`);
    expect(await inbox.list()).toHaveLength(2);
    const files = await takeAll(inbox);
    // Multipart carries no file dates; an untyped file arrives as octet-stream (the queue then
    // goes by its extension).
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["IMG_1.jpg", "image/jpeg"],
      ["b.png", "application/octet-stream"],
    ]);
    expect(await files[0]!.text()).toBe("jpeg bytes");
    // Listing leaves them for the user's decision; taking empties the inbox.
    expect(await inbox.list()).toHaveLength(0);
    expect(await takeAll(inbox)).toEqual([]);
  });

  it("keeps at most MAX_SHARED_FILES from one share and counts the rest (9.8)", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    const many = Array.from(
      { length: MAX_SHARED_FILES + 5 },
      (_, i) => new File(["x"], `${i}.jpg`),
    );
    const response = await receiveShare(share(many), inbox);
    expect(await inbox.list()).toHaveLength(MAX_SHARED_FILES);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/upload?shared=received&skipped=5`);
  });

  it("leaves out what the queue wouldn't take, without reading it (9.8)", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    const read = vi.spyOn(Blob.prototype, "arrayBuffer");
    const response = await receiveShare(
      share([
        jpeg("ok.jpg"),
        new File(["%PDF"], "doc.pdf", { type: "application/pdf" }),
        jpeg("empty.jpg", 0),
        jpeg("huge.jpg", MAX_UPLOAD_BYTES + 1),
      ]),
      inbox,
    );
    expect((await inbox.list()).map((photo) => photo.file.name)).toEqual(["ok.jpg"]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/upload?shared=received&skipped=3`);
  });

  it("caps the bytes kept from one share (9.8)", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    await receiveShare(share([jpeg("a.jpg", 600), jpeg("b.jpg", 600), jpeg("c.jpg", 300)]), inbox, {
      files: MAX_SHARED_FILES,
      bytes: 1000,
    });
    // b would go over; c still fits.
    expect((await inbox.list()).map((photo) => photo.file.name)).toEqual(["a.jpg", "c.jpg"]);
  });

  it("replaces what was waiting, so planted files can't ride along (9.8)", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    await receiveShare(share([jpeg("planted.jpg")]), inbox);
    await receiveShare(share([jpeg("mine.jpg")]), inbox);
    expect((await takeAll(inbox)).map((file) => file.name)).toEqual(["mine.jpg"]);
  });

  it("takes only the photos shown, not a share that arrived after (9.8)", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    await receiveShare(share([jpeg("shown.jpg")]), inbox);
    const shown = (await inbox.list()).map((photo) => photo.id);
    await receiveShare(share([jpeg("later.jpg")]), inbox);

    expect(await inbox.take(shown)).toEqual([]);
    expect((await inbox.list()).map((photo) => photo.file.name)).toEqual(["later.jpg"]);
  });

  it("reports a share it couldn't store", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    vi.spyOn(inbox, "replace").mockRejectedValueOnce(new Error("QuotaExceededError"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await receiveShare(share([new File(["x"], "a.jpg")]), inbox);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/upload?shared=failed`);
  });

  it("clears the inbox (logout)", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    await receiveShare(share([new File(["x"], "a.jpg")]), inbox);
    await inbox.clear();
    expect(await takeAll(inbox)).toEqual([]);
  });
});
