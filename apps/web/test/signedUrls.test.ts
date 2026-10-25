/** Signed image URLs (7.4): lists holding them refresh before the 15-min expiry. */
import type { InfiniteQueryObserverOptions } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useImageFailed } from "../src/components/useImageFailed";
import { PROCESSING_POLL_MS, galleryQuery } from "../src/queries/photos";
import { sharedAlbumsQuery } from "../src/queries/shares";
import { SIGNED_URL_REFRESH_MS, signedUrlRefreshInterval } from "../src/queries/signedUrls";
import { fakeApi, testPhoto } from "./fakes";

const OWN = "/users/u1/thumbs/01JB2Z3M4N5P6Q7R8S9T000001.jpg";
const SIGNED = `${OWN.replace("u1", "owner")}?Expires=1&Signature=s&Key-Pair-Id=K&Hash-Algorithm=SHA256`;

/** The query's refetchInterval for the given loaded pages. */
function intervalFor<T>(options: { refetchInterval?: unknown }, pages: T[]) {
  const interval = options.refetchInterval as InfiniteQueryObserverOptions["refetchInterval"];
  if (typeof interval !== "function") throw new Error("expected a refetchInterval function");
  return interval({ state: { data: { pages, pageParams: [] } } } as never);
}

describe("signedUrlRefreshInterval", () => {
  it("refreshes only lists with signed URLs, well before they expire", () => {
    expect(signedUrlRefreshInterval([OWN, null])).toBe(false);
    expect(signedUrlRefreshInterval([OWN, SIGNED])).toBe(SIGNED_URL_REFRESH_MS);
    expect(SIGNED_URL_REFRESH_MS).toBeLessThan(15 * 60 * 1000);
  });

  const { api } = fakeApi();
  const page = (items: unknown[]) => ({ items, nextCursor: null });

  it("a shared album's photos refetch every 10 min; own albums don't", () => {
    const query = galleryQuery(api, { album: "01JB2Z3M4N5P6Q7R8S9T0V1W2X", sort: "taken-desc" });
    expect(intervalFor(query, [page([testPhoto(1)])])).toBe(false);
    expect(
      intervalFor(query, [page([testPhoto(1, { thumbUrl: SIGNED, previewUrl: SIGNED })])]),
    ).toBe(SIGNED_URL_REFRESH_MS);
    // Processing polls faster and wins.
    expect(
      intervalFor(query, [
        page([
          testPhoto(1, { thumbUrl: SIGNED }),
          testPhoto(2, { status: "pending", uploadedAt: new Date().toISOString() }),
        ]),
      ]),
    ).toBe(PROCESSING_POLL_MS);
  });

  it("shared albums with signed covers refetch every 10 min", () => {
    const album = { albumId: "a", coverThumbUrl: null };
    const query = sharedAlbumsQuery(api);
    expect(intervalFor(query, [page([album])])).toBe(false);
    expect(intervalFor(query, [page([{ ...album, coverThumbUrl: SIGNED }])])).toBe(
      SIGNED_URL_REFRESH_MS,
    );
  });
});

describe("useImageFailed", () => {
  it("a failure is remembered for that URL only: a re-signed URL gets a fresh try", () => {
    const { result, rerender } = renderHook(({ url }) => useImageFailed(url), {
      initialProps: { url: SIGNED as string | null },
    });
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);

    rerender({ url: SIGNED.replace("Expires=1", "Expires=2") });
    expect(result.current[0]).toBe(false);
  });
});
