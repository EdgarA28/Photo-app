import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { daysLeft } from "../src/queries/trash";
import { fakeApi, testId, testPhoto } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A photo deleted `daysAgo` days ago, as GET /trash returns it (FR-DEL-3). */
function trashed(n: number, daysAgo: number) {
  const trashedAt = Date.now() - daysAgo * DAY_MS;
  return testPhoto(n, {
    trashedAt: new Date(trashedAt).toISOString(),
    purgeAt: new Date(trashedAt + 15 * DAY_MS).toISOString(),
  });
}

/** A trash whose contents follow the restores and deletes. */
function setup(photos = [trashed(0, 1), trashed(1, 14.5), trashed(2, 3)]) {
  let items = photos;
  const drop = (id: string) => void (items = items.filter((p) => p.photoId !== id));
  const responses: Record<string, unknown> = {
    ...defaultResponses,
    "GET /trash": () => ({ items }),
    "DELETE /trash": () => void (items = []),
  };
  for (const photo of photos) {
    responses[`POST /trash/${photo.photoId}/restore`] = () => {
      drop(photo.photoId);
      return { ...photo, trashedAt: null, purgeAt: null };
    };
    responses[`DELETE /trash/${photo.photoId}`] = () => drop(photo.photoId);
  }
  return fakeApi(responses as Parameters<typeof fakeApi>[0]);
}

const calls = (request: ReturnType<typeof fakeApi>["request"], method: string) =>
  request.mock.calls
    .filter(([m, path]) => m === method && path.startsWith("/trash"))
    .map(([, path]) => path);

describe("trash page (FR-DEL-3)", () => {
  it("lists trashed photos with the days left", async () => {
    await renderAt("/trash", { api: setup().api });
    expect(await screen.findByRole("button", { name: "IMG_0.jpg, 14 days left" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "IMG_1.jpg, 1 day left" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "IMG_2.jpg, 12 days left" })).toBeTruthy();
  });

  it("says when the trash is empty", async () => {
    await renderAt("/trash", { api: setup([]).api });
    expect(await screen.findByText("The trash is empty.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Empty trash" })).toBeNull();
  });

  it("restores the picked photos without asking", async () => {
    const { api, request } = setup();
    await renderAt("/trash", { api });
    fireEvent.click(await screen.findByRole("button", { name: /^IMG_0\.jpg/ }));
    fireEvent.click(screen.getByRole("button", { name: /^IMG_2\.jpg/ }));
    expect(screen.getByRole("toolbar").textContent).toContain("2 selected");

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect((await screen.findByRole("status")).textContent).toBe("Restored 2 photos.");
    expect(calls(request, "POST")).toEqual([
      `/trash/${testId(0)}/restore`,
      `/trash/${testId(2)}/restore`,
    ]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^IMG_0/ })).toBeNull());
    expect(screen.getByRole("button", { name: /^IMG_1/ })).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("deletes picked photos forever after a confirmation", async () => {
    const { api, request } = setup();
    await renderAt("/trash", { api });
    fireEvent.click(await screen.findByRole("button", { name: /^IMG_1\.jpg/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this photo forever?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls(request, "DELETE")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const again = await screen.findByRole("alertdialog", { name: "Delete this photo forever?" });
    fireEvent.click(within(again).getByRole("button", { name: "Delete forever" }));

    expect((await screen.findByRole("status")).textContent).toBe("Deleted 1 photo forever.");
    expect(calls(request, "DELETE")).toEqual([`/trash/${testId(1)}`]);
  });

  it("keeps a photo that failed to restore picked, with the reason", async () => {
    const { api } = fakeApi({
      ...defaultResponses,
      "GET /trash": { items: [trashed(0, 1)] },
      [`POST /trash/${testId(0)}/restore`]: new ApiRequestError("INTERNAL_ERROR", "boom", 500),
    });
    await renderAt("/trash", { api });
    fireEvent.click(await screen.findByRole("button", { name: /^IMG_0\.jpg/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect((await screen.findByRole("status")).textContent).toMatch(
      /^1 photo couldn't be restored/,
    );
    expect(screen.getByRole("toolbar").textContent).toContain("1 selected");
  });

  it("empties the trash after a confirmation", async () => {
    const { api, request } = setup();
    await renderAt("/trash", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Empty the trash?" });
    expect(dialog.textContent).toContain("All 3 photos in the trash");
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty trash" }));

    expect(
      await screen.findByText("The trash is empty.", { selector: "p:not([role])" }),
    ).toBeTruthy();
    expect(calls(request, "DELETE")).toEqual(["/trash"]);
  });
});

describe("daysLeft", () => {
  it("counts whole days up, and at least 1 while the photo is still there", () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    const at = (iso: string) => testPhoto(0, { purgeAt: iso }) as Parameters<typeof daysLeft>[0];
    expect(daysLeft(at("2026-11-12T12:00:00.000Z"), now)).toBe(15);
    expect(daysLeft(at("2026-10-29T11:00:00.000Z"), now)).toBe(1);
    expect(daysLeft(at("2026-10-28T11:00:00.000Z"), now)).toBe(1);
  });
});
