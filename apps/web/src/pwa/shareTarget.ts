import type { ShareInbox, SharedFile } from "@/upload/shareInbox";
import { checkFile } from "@/upload/validate";

/** Manifest `share_target.action` (vite.config.ts): where Android POSTs the shared photos. */
export const SHARE_TARGET_PATH = "/share-target";
/** Manifest `share_target.params.files[].name`. */
export const SHARE_FILES_FIELD = "photos";

/**
 * Limits for one share, checked before any bytes are read: any website can POST here, and what
 * is kept sits on the device until the user decides (9.8).
 */
export const MAX_SHARED_FILES = 100;
export const MAX_SHARED_BYTES = 1024 * 1024 * 1024;

/** `?shared=` on /upload after a share: what the service worker did with it. */
export type ShareOutcome = "received" | "failed";

/**
 * Receives a share from Android's share sheet (9.6, FR-PWA-4) in the service worker: the browser
 * opens the app with a POST of the files (multipart), which no server could take (the site is
 * static). The files are copied into the share inbox (their own bytes, read now: Android's
 * references can lapse, cf. 8.10's InvalidBlob) and the app continues on /upload, which adds them
 * to the queue once the user confirms (any website can POST here, so nothing is uploaded unasked).
 * Only files the queue would take (type, size: `checkFile`) and within the limits above are kept;
 * the rest are counted in `?skipped=`. The share replaces whatever was waiting (9.8).
 * 303, so the page is loaded with GET and a reload doesn't share again.
 */
export async function receiveShare(
  request: Request,
  inbox: ShareInbox,
  limits = { files: MAX_SHARED_FILES, bytes: MAX_SHARED_BYTES },
): Promise<Response> {
  let outcome: ShareOutcome = "received";
  let skipped = 0;
  try {
    const form = await request.formData();
    const files: SharedFile[] = [];
    let bytes = 0;
    for (const value of form.getAll(SHARE_FILES_FIELD)) {
      if (typeof value === "string") continue;
      if (
        !checkFile(value).ok ||
        files.length === limits.files ||
        bytes + value.size > limits.bytes
      ) {
        skipped++;
        continue;
      }
      bytes += value.size;
      files.push({
        name: value.name,
        type: value.type,
        lastModified: value.lastModified,
        blob: new Blob([await value.arrayBuffer()], { type: value.type }),
      });
    }
    await inbox.replace(files);
  } catch (error) {
    console.warn("Receiving shared photos failed", error);
    outcome = "failed";
  }
  const search = new URLSearchParams({ shared: outcome });
  if (skipped > 0) search.set("skipped", String(skipped));
  return Response.redirect(new URL(`/upload?${search}`, request.url).href, 303);
}
