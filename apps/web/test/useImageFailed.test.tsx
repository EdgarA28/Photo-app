/** useImageFailed (8.35b): a failed own image gets another try after new media cookies. */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createMediaCookies } from "../src/auth/mediaCookie";
import { useImageFailed } from "../src/components/useImageFailed";
import { fakeApi, MemoryStorage, testUser } from "./fakes";

function issueCookies(token: string) {
  const { api } = fakeApi({ "POST /session/media-cookie": { expiresAt: "2026-10-25T20:00:00Z" } });
  const auth = {
    getAccessToken: async () => token,
    getStoredUser: async () => ({ sub: testUser.sub, email: undefined, name: undefined }),
  };
  return createMediaCookies({ auth, api, storage: new MemoryStorage() }).ensure();
}

describe("useImageFailed", () => {
  it("remembers a failure per URL", () => {
    const { result, rerender } = renderHook(({ url }) => useImageFailed(url), {
      initialProps: { url: "/users/a/thumbs/1.jpg" },
    });
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    // A new URL (re-signed) gets a fresh try.
    rerender({ url: "/users/a/thumbs/1.jpg?v=2" });
    expect(result.current[0]).toBe(false);
  });

  it("tries again once new media cookies arrive", async () => {
    const { result } = renderHook(() => useImageFailed("/users/a/thumbs/1.jpg"));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    await act(() => issueCookies("access-x"));
    expect(result.current[0]).toBe(false);
  });
});
