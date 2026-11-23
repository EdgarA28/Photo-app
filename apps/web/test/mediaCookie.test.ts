/** Media cookie timing (7.3, §9): when the app asks the API for CloudFront cookies. */
import { describe, expect, it, vi } from "vitest";
import { MEDIA_COOKIE_TTL_SECONDS } from "@photo-app/shared";
import { ApiRequestError } from "../src/api/errors";
import { createMediaCookies, mediaCookieIssues } from "../src/auth/mediaCookie";
import { fakeApi, MemoryStorage, testUser } from "./fakes";

const EXPIRES = { expiresAt: "2026-10-25T20:00:00.000Z" };

const TTL_MS = MEDIA_COOKIE_TTL_SECONDS * 1000;

function setup(
  responses: Record<string, unknown> = {},
  // One device's localStorage, shared by the "page loads" of a test.
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = new MemoryStorage(),
) {
  let token: string | null = "access-1";
  let time = Date.parse("2026-10-30T08:00:00Z");
  const auth = {
    getAccessToken: vi.fn(async () => token),
    getStoredUser: vi.fn(async () =>
      token ? { sub: testUser.sub, email: undefined, name: undefined } : null,
    ),
  };
  const { api, request } = fakeApi({
    "POST /session/media-cookie": EXPIRES,
    "DELETE /session/media-cookie": undefined,
    ...responses,
  });
  const media = createMediaCookies({ auth, api, storage, now: () => time });
  const posts = () =>
    request.mock.calls.filter(([m, p]) => m === "POST" && p === "/session/media-cookie");
  return {
    media,
    request,
    posts,
    storage,
    setToken: (t: string | null) => (token = t),
    advance: (ms: number) => (time += ms),
  };
}

/** The API call never answers: whoever waits for new cookies hangs. */
const hang = () => new Promise<never>(() => {});

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

// 8.25c: a restart shouldn't wait for the token refresh and the API when the cookies still work.
describe("ready() for the route guard", () => {
  /** A device where cookies for testUser were issued `ago` milliseconds before the new start. */
  async function restartedAfter(ago: number) {
    const first = setup();
    await first.media.ensure();
    const next = setup({}, first.storage);
    next.advance(ago);
    return next;
  }

  it.each([
    ["still valid", TTL_MS / 2],
    // 8.35b: opening the app after 8 h doesn't wait for the refresh and the API either; images
    // that fail meanwhile retry once the new cookies arrive (useImageFailed).
    ["run out", TTL_MS + 1],
  ])("doesn't wait when cookies were issued on this device before (%s)", async (_, ago) => {
    const { media, request, posts } = await restartedAfter(ago);
    request.mockImplementation(hang);
    await media.ready(testUser.sub);
    // Renewed in the background anyway: a new page load means a new token.
    expect(posts()).toHaveLength(1);
  });

  it("waits for new cookies when nothing was issued on this device", async () => {
    const { media, request } = setup();
    request.mockImplementation(hang);
    const ready = vi.fn();
    void media.ready(testUser.sub).then(ready);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ready).not.toHaveBeenCalled();
  });

  it("announces each issue, so failed images can try again", async () => {
    const { media, setToken } = setup();
    const listener = vi.fn();
    const unsubscribe = mediaCookieIssues.subscribe(listener);
    const before = mediaCookieIssues.current();
    await media.ensure();
    setToken("access-2");
    await media.ensure();
    expect(mediaCookieIssues.current()).toBe(before + 2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("waits when the cookies were issued for another account", async () => {
    const { media, request } = await restartedAfter(1000);
    request.mockImplementation(hang);
    const ready = vi.fn();
    void media.ready("04e8b4b8-0000-4000-8000-000000000002").then(ready);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ready).not.toHaveBeenCalled();
  });

  it("counts the lifetime from before the request, on this device's clock", async () => {
    const { media, storage, advance, request } = setup();
    request.mockImplementationOnce(async () => {
      advance(3000); // a slow response
      return EXPIRES;
    });
    await media.ensure();
    const sentAt = Date.parse("2026-10-30T08:00:00Z");
    expect(JSON.parse(storage.getItem("photo-app.media-cookie")!)).toEqual({
      userId: testUser.sub,
      validUntil: sentAt + TTL_MS,
    });
  });

  it("forgets the cookies on logout, even if a request is still running", async () => {
    const { media, request, storage, setToken } = setup();
    await media.ensure();
    expect(storage.getItem("photo-app.media-cookie")).not.toBeNull();

    // A token refresh renews the cookies; the user logs out before the API answers.
    setToken("access-2");
    let answer!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const renewing = media.ensure();
    await vi.waitFor(() => expect(answer).toBeDefined());
    await media.clear();
    answer(EXPIRES);
    await renewing;
    expect(storage.getItem("photo-app.media-cookie")).toBeNull();
  });
});
