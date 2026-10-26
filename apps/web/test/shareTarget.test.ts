// @vitest-environment node
// Node's Request/FormData/Blob: real multipart parsing, and Blobs that survive fake-indexeddb.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SHARED_FILES,
  receiveShare,
  SHARE_FILES_FIELD,
  SHARE_TARGET_PATH,
} from "../src/pwa/shareTarget";
import { createIdbShareInbox } from "../src/upload/shareInbox";

const ORIGIN = "https://photos.example";

function share(files: File[]) {
  const form = new FormData();
  for (const file of files) form.append(SHARE_FILES_FIELD, file);
  form.append("title", "ignored text field");
  return new Request(ORIGIN + SHARE_TARGET_PATH, { method: "POST", body: form });
}

describe("share target (9.6, FR-PWA-4)", () => {
  it("stores the shared files and continues on /upload with GET", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    const photo = new File(["jpeg bytes"], "IMG_1.jpg", { type: "image/jpeg" });
    const response = await receiveShare(share([photo, new File(["x"], "b.png")]), inbox);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/upload?shared=received`);
    expect(await inbox.list()).toHaveLength(2);
    const files = await inbox.take();
    // Multipart carries no file dates; an untyped file arrives as octet-stream (the queue then
    // goes by its extension).
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["IMG_1.jpg", "image/jpeg"],
      ["b.png", "application/octet-stream"],
    ]);
    expect(await files[0]!.text()).toBe("jpeg bytes");
    // Listing leaves them for the user's decision; taking empties the inbox.
    expect(await inbox.list()).toHaveLength(0);
    expect(await inbox.take()).toEqual([]);
  });

  it("keeps at most MAX_SHARED_FILES from one share", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    const many = Array.from(
      { length: MAX_SHARED_FILES + 5 },
      (_, i) => new File(["x"], `${i}.jpg`),
    );
    await receiveShare(share(many), inbox);
    expect(await inbox.list()).toHaveLength(MAX_SHARED_FILES);
  });

  it("reports a share it couldn't store", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    vi.spyOn(inbox, "put").mockRejectedValueOnce(new Error("QuotaExceededError"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await receiveShare(share([new File(["x"], "a.jpg")]), inbox);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/upload?shared=failed`);
  });

  it("clears the inbox (logout)", async () => {
    const inbox = createIdbShareInbox(new IDBFactory());
    await receiveShare(share([new File(["x"], "a.jpg")]), inbox);
    await inbox.clear();
    expect(await inbox.take()).toEqual([]);
  });
});
