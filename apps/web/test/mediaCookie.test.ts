/** Media cookie timing (7.3, §9): when the app asks the API for CloudFront cookies. */
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { createMediaCookies } from "../src/auth/mediaCookie";
import { fakeApi } from "./fakes";

const EXPIRES = { expiresAt: "2026-10-25T20:00:00.000Z" };

function setup(responses: Record<string, unknown> = {}) {
  let token: string | null = "access-1";
  const auth = { getAccessToken: vi.fn(async () => token) };
  const { api, request } = fakeApi({
    "POST /session/media-cookie": EXPIRES,
    "DELETE /session/media-cookie": undefined,
    ...responses,
  });
  const media = createMediaCookies({ auth, api });
  const posts = () =>
    request.mock.calls.filter(([m, p]) => m === "POST" && p === "/session/media-cookie");
  return { media, request, posts, setToken: (t: string | null) => (token = t) };
}

describe("createMediaCookies", () => {
  it("asks once per access token", async () => {
    const { media, posts, setToken } = setup();
    await media.ensure();
    await media.ensure();
    expect(posts()).toHaveLength(1);

    // A refreshed token: renew, so the cookies never run out during a session.
    setToken("access-2");
    await media.ensure();
    expect(posts()).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { media, posts } = setup();
    await Promise.all([media.ensure(), media.ensure(), media.ensure()]);
    expect(posts()).toHaveLength(1);
  });

  it("does nothing without a session", async () => {
    const { media, posts, setToken } = setup();
    setToken(null);
    await media.ensure();
    expect(posts()).toHaveLength(0);
  });

  it("never throws, and tries again after a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { media, request, posts } = setup();
    request.mockRejectedValueOnce(new ApiRequestError("INTERNAL_ERROR", "boom", 500));

    await expect(media.ensure()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    await media.ensure();
    expect(posts()).toHaveLength(2);
    warn.mockRestore();
  });

  it("clear() expires the cookies and forgets them, so the next session asks again", async () => {
    const { media, request, posts } = setup();
    await media.ensure();
    await media.clear();
    expect(request).toHaveBeenLastCalledWith("DELETE", "/session/media-cookie");

    await media.ensure();
    expect(posts()).toHaveLength(2);
  });
});
