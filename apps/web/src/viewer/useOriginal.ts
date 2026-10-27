import type { Photo } from "@photo-app/shared";
import { useEffect, useState } from "react";
import type { Api } from "@/api/api";

export type OriginalState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "unavailable" };

/** Set once a HEIC/HEIF original didn't decode: this browser can't show them (only Safari can). */
let heifUnsupported = false;
const isHeif = (contentType: Photo["contentType"]) =>
  contentType === "image/heic" || contentType === "image/heif";

/**
 * The full-resolution original for deep zoom, loaded only once `wanted` (the preview has run out
 * of detail): the API's 5-min download link (FR-DL-1, works for shared photos with `album`), the
 * bytes fetched from S3 (CORS GET, CSP `connect-src`) and shown from a `blob:` URL. If the browser
 * can't decode it (HEIC outside Safari) or anything fails, the preview simply stays.
 */
export function useOriginal(
  api: Api,
  photo: Photo,
  album: string | undefined,
  wanted: boolean,
): OriginalState {
  const [state, setState] = useState<OriginalState>({ status: "idle" });
  // Sticky: zooming back out doesn't cancel a load that has started (the viewer remounts this
  // per photo, so a new photo starts over).
  const [requested, setRequested] = useState(false);
  const { photoId, contentType } = photo;
  if (wanted && !requested && !(isHeif(contentType) && heifUnsupported)) setRequested(true);

  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    let url: string | undefined;
    void (async () => {
      try {
        const link = await api.photos.downloadUrl(photoId, album);
        const response = await fetch(link.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`S3 answered ${response.status}`);
        url = URL.createObjectURL(await response.blob());
        if (!(await decodes(url))) {
          if (isHeif(contentType)) heifUnsupported = true;
          throw new Error(`can't decode ${contentType}`);
        }
        if (!controller.signal.aborted) setState({ status: "ready", url });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Full-resolution original not shown", error);
        setState({ status: "unavailable" });
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
    // Not `photo`: a refetched list brings a new object for the same photo.
  }, [requested, api, photoId, contentType, album]);

  // Requested and not settled yet = loading.
  return requested && state.status === "idle" ? { status: "loading" } : state;
}

async function decodes(url: string): Promise<boolean> {
  const image = new Image();
  image.src = url;
  // Where decode() is missing (old browsers, tests), let the <img> try.
  if (typeof image.decode !== "function") return true;
  try {
    await image.decode();
    return true;
  } catch {
    return false;
  }
}
