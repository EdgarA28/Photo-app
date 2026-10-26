import type { ShareInbox } from "@/upload/shareInbox";

/** Manifest `share_target.action` (vite.config.ts): where Android POSTs the shared photos. */
export const SHARE_TARGET_PATH = "/share-target";
/** Manifest `share_target.params.files[].name`. */
export const SHARE_FILES_FIELD = "photos";

/** At most this many files are kept from one share (a hostile page could POST thousands). */
export const MAX_SHARED_FILES = 100;

/** `?shared=` on /upload after a share: what the service worker did with it. */
export type ShareOutcome = "received" | "failed";

/**
 * Receives a share from Android's share sheet (9.6, FR-PWA-4) in the service worker: the browser
 * opens the app with a POST of the files (multipart), which no server could take (the site is
 * static). The files are copied into the share inbox (their own bytes, read now: Android's
 * references can lapse, cf. 8.10's InvalidBlob) and the app continues on /upload, which adds them
 * to the queue once the user confirms (any website can POST here, so nothing is uploaded unasked).
 * 303, so the page is loaded with GET and a reload doesn't share again.
 */
export async function receiveShare(request: Request, inbox: ShareInbox): Promise<Response> {
  let outcome: ShareOutcome = "received";
  try {
    const form = await request.formData();
    const files = [];
    for (const value of form.getAll(SHARE_FILES_FIELD)) {
      if (typeof value === "string") continue;
      if (files.length === MAX_SHARED_FILES) break;
      files.push({
        name: value.name,
        type: value.type,
        lastModified: value.lastModified,
        blob: new Blob([await value.arrayBuffer()], { type: value.type }),
      });
    }
    await inbox.put(files);
  } catch (error) {
    console.warn("Receiving shared photos failed", error);
    outcome = "failed";
  }
  return Response.redirect(new URL(`/upload?shared=${outcome}`, request.url).href, 303);
}
