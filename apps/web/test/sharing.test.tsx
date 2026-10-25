import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseShareTarget } from "../src/albums/shareTarget";
import { ApiRequestError } from "../src/api/errors";
import { fakeApi, testId, testPhotoPage } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const MINE = testId(900);
const SHARED = testId(910);
const ANA = "04e8b4b8-0000-4000-8000-0000000000a1";
const BEN = "04e8b4b8-0000-4000-8000-0000000000b2";

const myAlbum = {
  albumId: MINE,
  name: "Holidays",
  createdAt: "2026-10-01T10:00:00.000Z",
  coverPhotoId: null,
  coverThumbUrl: null,
  photoCount: 3,
};

function sharedAlbum(n: number, overrides: Record<string, unknown> = {}) {
  return {
    ...myAlbum,
    albumId: testId(910 + n),
    name: `From Ana ${n}`,
    photoCount: 2,
    ownerId: ANA,
    ownerUsername: "ana",
    sharedAt: "2026-10-20T10:00:00.000Z",
    ...overrides,
  };
}

const share = (userId: string, email: string | null, username: string | null) => ({
  userId,
  email,
  username,
  sharedAt: "2026-10-20T10:00:00.000Z",
});

type Request = ReturnType<typeof fakeApi>["request"];

/** Owner side: a share list that POST/DELETE change, like the API. */
function ownerSetup(responses: Record<string, unknown> = {}) {
  let shares = [share(BEN, "ben@example.com", null)];
  const fake = fakeApi({
    ...defaultResponses,
    "GET /albums": { items: [myAlbum] },
    [`GET /albums/${MINE}/photos`]: testPhotoPage(0, 3),
    [`GET /albums/${MINE}/shares`]: () => ({ items: shares }),
    [`POST /albums/${MINE}/shares`]: () => {
      const body = lastBody(fake.request);
      const created =
        "email" in body
          ? body.email === "ben@example.com"
            ? shares[0]!
            : share(ANA, body.email!, null)
          : share(ANA, null, body.username!);
      shares = [...shares.filter((s) => s.userId !== created.userId), created];
      return created;
    },
    [`DELETE /albums/${MINE}/shares/${BEN}`]: () => {
      shares = shares.filter((s) => s.userId !== BEN);
      return undefined;
    },
    ...responses,
  });
  return fake;
}

const lastBody = (request: Request) =>
  request.mock.calls.at(-1)![2]!.body as Record<string, string>;

const posts = (request: Request) =>
  request.mock.calls.filter(([m]) => m === "POST").map(([, , options]) => options?.body);

async function openShareDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Share" }));
  return screen.findByRole("dialog", { name: "Share “Holidays”" });
}

function shareWith(dialog: HTMLElement, value: string) {
  fireEvent.change(within(dialog).getByLabelText("Email or username"), { target: { value } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Share" }));
}

describe("reading the share field (FR-SHR-1/5)", () => {
  it.each([
    ["ana@example.com", { email: "ana@example.com" }, "ana@example.com"],
    ["  Ana@Example.COM ", { email: "ana@example.com" }, "ana@example.com"],
    ["@Ana_R", { username: "ana_r" }, "@ana_r"],
    ["ana.r", { username: "ana.r" }, "@ana.r"],
  ])("%j → %j", (input, request, label) => {
    expect(parseShareTarget(input)).toEqual({ ok: true, request, label });
  });

  it.each([
    ["ana@", "This isn't a valid email address."],
    ["a@b", "This isn't a valid email address."],
    ["ab", /Not a valid username/],
    ["@admin", /reserved/],
  ])("rejects %j", (input, reason) => {
    const result = parseShareTarget(input);
    expect(result?.ok).toBe(false);
    expect(result && !result.ok && result.reason).toMatch(reason);
  });

  it("is empty for a blank field", () => {
    expect(parseShareTarget("   ")).toBeNull();
  });
});

describe("share dialog (owner, FR-SHR-1/2/5)", () => {
  it("lists who the album is shared with", async () => {
    const { api } = ownerSetup({
      [`GET /albums/${MINE}/shares`]: {
        items: [share(BEN, "ben@example.com", "ben"), share(ANA, null, "ana")],
      },
    });
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    const list = await within(dialog).findByRole("list");
    const rows = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows[0]).toContain("@ben");
    expect(rows[0]).toContain("ben@example.com");
    // Shared by username: the email is never known to the owner.
    expect(rows[1]).toContain("@ana");
    expect(rows[1]).not.toContain("@example.com");
  });

  it("says when the album isn't shared with anyone", async () => {
    const { api } = ownerSetup({ [`GET /albums/${MINE}/shares`]: { items: [] } });
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    expect(await within(dialog).findByText("Only you can see this album.")).toBeTruthy();
  });

  it("shares by email", async () => {
    const { api, request } = ownerSetup();
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    await within(dialog).findByText("ben@example.com");
    shareWith(dialog, "Ana@Example.com");

    expect((await within(dialog).findByRole("status")).textContent).toBe(
      "Shared with ana@example.com.",
    );
    expect(posts(request)).toEqual([{ email: "ana@example.com" }]);
    expect(within(dialog).getByText("ana@example.com")).toBeTruthy();
    expect(within(dialog).getByLabelText("Email or username")).toHaveProperty("value", "");
  });

  it("shares by username, with or without @", async () => {
    const { api, request } = ownerSetup();
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    fireEvent.change(within(dialog).getByLabelText("Email or username"), {
      target: { value: "@Ana" },
    });
    expect(within(dialog).getByText("Share with @ana")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Share" }));

    expect((await within(dialog).findByRole("status")).textContent).toBe("Shared with @ana.");
    expect(posts(request)).toEqual([{ username: "ana" }]);
  });

  it("says when it was already shared with that person", async () => {
    const { api } = ownerSetup();
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    await within(dialog).findByText("ben@example.com");
    shareWith(dialog, "ben@example.com");
    expect((await within(dialog).findByRole("status")).textContent).toBe(
      "Already shared with ben@example.com.",
    );
  });

  it("explains a malformed value without sending it", async () => {
    const { api, request } = ownerSetup();
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    shareWith(dialog, "ana@");
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "This isn't a valid email address.",
    );
    expect(posts(request)).toEqual([]);
  });

  it.each([
    [
      "nobody has that email or username",
      new ApiRequestError("SHARE_TARGET_NOT_FOUND", "No such user", 404),
      "No user with this email or username.",
    ],
    [
      "it's the owner",
      new ApiRequestError("VALIDATION_ERROR", "You can't share an album with yourself", 400),
      "You can't share an album with yourself",
    ],
  ])("shows the API's answer when %s", async (_, error, message) => {
    const { api } = ownerSetup({ [`POST /albums/${MINE}/shares`]: error });
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    shareWith(dialog, "someone@example.com");
    expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
  });

  it("revokes a share at once", async () => {
    const { api, request } = ownerSetup();
    await renderAt(`/albums/${MINE}`, { api });
    const dialog = await openShareDialog();
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Stop sharing with ben@example.com" }),
    );

    expect((await within(dialog).findByRole("status")).textContent).toBe(
      "ben@example.com no longer has access.",
    );
    expect(await within(dialog).findByText("Only you can see this album.")).toBeTruthy();
    expect(
      request.mock.calls.some(([m, p]) => m === "DELETE" && p === `/albums/${MINE}/shares/${BEN}`),
    ).toBe(true);
  });
});

describe("albums shared with me (FR-SHR-3/4)", () => {
  function recipientSetup(responses: Record<string, unknown> = {}) {
    return fakeApi({
      ...defaultResponses,
      "GET /albums": { items: [myAlbum] },
      "GET /shared-albums": {
        items: [sharedAlbum(0), sharedAlbum(1, { ownerUsername: null })],
        nextCursor: null,
      },
      [`GET /albums/${SHARED}/photos`]: testPhotoPage(0, 2),
      [`GET /albums/${MINE}/photos`]: testPhotoPage(0, 3),
      ...responses,
    });
  }

  it("lists them in their own section, naming who shared them", async () => {
    const { api } = recipientSetup();
    await renderAt("/albums", { api });
    const section = await screen.findByRole("region", { name: "Shared with me" });
    const links = within(section).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "From Ana 02 photosShared by @ana",
      // An owner without a username stays unnamed: the API never exposes emails.
      "From Ana 12 photosShared with you",
    ]);
    expect(links[0]!.getAttribute("href")).toBe(`/albums/${SHARED}`);
  });

  it("hides the section when nothing is shared with me", async () => {
    const { api } = recipientSetup({ "GET /shared-albums": { items: [], nextCursor: null } });
    await renderAt("/albums", { api });
    await screen.findByRole("link", { name: /Holidays/ });
    expect(screen.queryByRole("region", { name: "Shared with me" })).toBeNull();
  });

  it("loads more shared albums page by page", async () => {
    const { api } = recipientSetup({
      "GET /shared-albums": (query: { cursor?: string }) =>
        query.cursor === "p2"
          ? { items: [sharedAlbum(5)], nextCursor: null }
          : { items: [sharedAlbum(0)], nextCursor: "p2" },
    });
    await renderAt("/albums", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("link", { name: /From Ana 5/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("opens a shared album read-only", async () => {
    const { api } = recipientSetup();
    await renderAt(`/albums/${SHARED}`, { api });
    expect(await screen.findByRole("heading", { name: "From Ana 0" })).toBeTruthy();
    expect(screen.getByText("Shared by @ana · view only")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "IMG_0.jpg" });
    expect(link.getAttribute("href")).toBe(`/photos/${testId(0)}?album=${SHARED}&sort=taken-desc`);
    for (const name of ["Select", "Add photos", "Share", "Album actions"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("link", { name: /Add photos/ })).toBeNull();
  });

  it("finds a shared album beyond the first page of the list", async () => {
    const { api } = recipientSetup({
      "GET /shared-albums": (query: { cursor?: string }) =>
        query.cursor === "p2"
          ? { items: [sharedAlbum(0)], nextCursor: null }
          : { items: [sharedAlbum(3)], nextCursor: "p2" },
    });
    await renderAt(`/albums/${SHARED}`, { api });
    expect(await screen.findByRole("heading", { name: "From Ana 0" })).toBeTruthy();
  });

  it("shows who shared it in the viewer, with download as the only action", async () => {
    const { api } = recipientSetup();
    await renderAt(`/albums/${SHARED}`, { api });
    fireEvent.click(await screen.findByRole("link", { name: "IMG_1.jpg" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("IMG_1.jpg"),
    );
    expect(await screen.findByText("Shared by @ana")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download original" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Album actions" })).toBeNull();
  });
});
