import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { fakeApi, testId, testPhoto } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

/** IMG_0–2 are copies of one photo, IMG_3–4 of another. */
function groups(gone: ReadonlySet<string> = new Set(), dismissed: ReadonlySet<string> = new Set()) {
  const all = [
    { key: KEY_A, photos: [0, 1, 2].map((n) => testPhoto(n, { sizeBytes: 2_500_000 })) },
    { key: KEY_B, photos: [3, 4].map((n) => testPhoto(n)) },
  ];
  return {
    groups: all
      .filter((g) => !dismissed.has(g.key))
      .map((g) => ({ ...g, photos: g.photos.filter((p) => !gone.has(p.photoId)) }))
      .filter((g) => g.photos.length > 1),
  };
}

function setup(responses: Record<string, unknown> = {}) {
  return fakeApi({ ...defaultResponses, "GET /photos/duplicates": groups(), ...responses });
}

const group = (name: string) => screen.getByRole("region", { name });

describe("Duplicates page (8.37g, FR-GAL-12)", () => {
  it("opens from Settings", async () => {
    const { router } = await renderAt("/settings", { api: setup().api });
    fireEvent.click(await screen.findByRole("link", { name: "Find duplicates" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/duplicates"));
    expect(await screen.findByRole("heading", { name: "Duplicates" })).toBeTruthy();
  });

  it("shows each group side by side with the copies' details", async () => {
    await renderAt("/duplicates", { api: setup().api });
    expect(await screen.findByText("2 groups, 3 extra copies")).toBeTruthy();
    const first = group("3 copies");
    expect(
      within(first)
        .getAllByRole("link")
        .map((l) => l.getAttribute("aria-label")),
    ).toEqual(["View IMG_0.jpg", "View IMG_1.jpg", "View IMG_2.jpg"]);
    expect(within(first).getAllByText("2.4 MB · 4032 × 3024")).toHaveLength(3);
    expect(within(first).getByRole("link", { name: "View IMG_1.jpg" }).getAttribute("href")).toBe(
      `/photos/${testId(1)}`,
    );
    expect(group("2 copies")).toBeTruthy();
  });

  it("Keep moves the other copies to the trash and the group goes", async () => {
    const gone = new Set<string>();
    const del = (n: number) => () => void gone.add(testId(n));
    const { api, request } = setup({
      "GET /photos/duplicates": () => groups(gone),
      [`DELETE /photos/${testId(0)}`]: del(0),
      [`DELETE /photos/${testId(2)}`]: del(2),
    });
    await renderAt("/duplicates", { api });
    fireEvent.click(
      within(await screen.findByRole("region", { name: "3 copies" })).getByRole("button", {
        name: "Keep IMG_1.jpg",
      }),
    );

    expect((await screen.findByRole("status")).textContent).toBe(
      "Kept IMG_1.jpg and moved 2 photos to the trash.",
    );
    expect(
      request.mock.calls.filter(([method]) => method === "DELETE").map(([, path]) => path),
    ).toEqual([`/photos/${testId(0)}`, `/photos/${testId(2)}`]);
    await waitFor(() => expect(screen.queryByRole("region", { name: "3 copies" })).toBeNull());
    expect(screen.getByText("1 group, 1 extra copy")).toBeTruthy();
  });

  it("Not duplicates dismisses the group as shown", async () => {
    const dismissed = new Set<string>();
    const { api, request } = setup({
      "GET /photos/duplicates": () => groups(new Set(), dismissed),
      [`POST /photos/duplicates/${KEY_B}/dismiss`]: () => void dismissed.add(KEY_B),
    });
    await renderAt("/duplicates", { api });
    fireEvent.click(
      within(await screen.findByRole("region", { name: "2 copies" })).getByRole("button", {
        name: "Not duplicates",
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe("Marked as not duplicates.");
    const call = request.mock.calls.find(([method]) => method === "POST");
    expect(call?.[2]?.body).toEqual({ photoIds: [testId(3), testId(4)] });
    await waitFor(() => expect(screen.queryByRole("region", { name: "2 copies" })).toBeNull());
  });

  it("a group that changed meanwhile (409) says so and the list is refreshed", async () => {
    let loads = 0;
    const { api } = setup({
      "GET /photos/duplicates": () => {
        loads++;
        return groups();
      },
      [`POST /photos/duplicates/${KEY_B}/dismiss`]: new ApiRequestError(
        "CONFLICT",
        "This group of duplicates has changed",
        409,
      ),
    });
    await renderAt("/duplicates", { api });
    fireEvent.click(
      within(await screen.findByRole("region", { name: "2 copies" })).getByRole("button", {
        name: "Not duplicates",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed meanwhile/);
    await waitFor(() => expect(loads).toBe(2));
  });

  it("says when there are none", async () => {
    await renderAt("/duplicates", {
      api: setup({ "GET /photos/duplicates": { groups: [] } }).api,
    });
    expect(await screen.findByText("No duplicates found.")).toBeTruthy();
  });
});
