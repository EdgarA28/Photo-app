import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { fakeApi, fakeAuth, testFile, testMe, testUploadQueue } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(cleanup);

const GiB = 1024 ** 3;

function setup(responses: Record<string, unknown> = {}) {
  return fakeApi({ ...defaultResponses, ...responses });
}

const meWith = (overrides: Record<string, unknown>) => ({ ...testMe, ...overrides });

describe("settings: account and storage (FR-ACC-1)", () => {
  it("shows the account and the storage used against the quota", async () => {
    const { api } = setup();
    await renderAt("/settings", { api });
    const main = await screen.findByRole("main");
    expect(within(main).getByText("Test User")).toBeTruthy();
    expect(within(main).getByText(testMe.email)).toBeTruthy();
    expect(main.textContent).toContain("1.5 MB of 2.0 GB used");
    expect(main.textContent).toContain("3 photos");
    const meter = screen.getByRole("meter", { name: "Storage used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("0");
    expect(meter.getAttribute("data-level")).toBe("ok");
  });

  it.each([
    [0.5, "50", "ok", false],
    [0.85, "85", "warn", false],
    [0.97, "97", "full", true],
    [1.2, "100", "full", true],
  ])("at %s of the quota: %s%%, %s", async (share, percent, level, hint) => {
    const { api } = setup({
      "GET /me": meWith({
        usage: { bytesUsed: Math.round(share * 2 * GiB), photoCount: 10, quotaBytes: 2 * GiB },
      }),
    });
    await renderAt("/settings", { api });
    const meter = await screen.findByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe(percent);
    expect(meter.getAttribute("data-level")).toBe(level);
    expect(!!screen.queryByText(/Almost full/)).toBe(hint);
  });
});

describe("settings: username (FR-ACC-3)", () => {
  async function openEditor(button: string) {
    fireEvent.click(await screen.findByRole("button", { name: button }));
    return screen.getByRole("textbox", { name: "Username" });
  }

  it("sets a first username, normalised like the API does", async () => {
    let username: string | null = null;
    const { api, request } = setup({
      "GET /me": () => meWith({ username }),
      "PUT /me/username": () => {
        username = "ana_r";
        return { username };
      },
    });
    await renderAt("/settings", { api });
    expect(await screen.findByText(/No username yet/)).toBeTruthy();

    const field = await openEditor("Choose a username");
    fireEvent.change(field, { target: { value: "@Ana_R" } });
    expect(screen.getByText("Saved as @ana_r")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("status")).textContent).toBe("Your username is now @ana_r.");
    expect(screen.getByText("@ana_r")).toBeTruthy();
    expect(request.mock.calls.find(([m]) => m === "PUT")?.[2]?.body).toEqual({
      username: "ana_r",
    });
  });

  it("explains invalid and reserved names live, without sending them", async () => {
    const { api, request } = setup();
    await renderAt("/settings", { api });
    const field = await openEditor("Choose a username");
    const save = screen.getByRole("button", { name: "Save" });

    fireEvent.change(field, { target: { value: "ab" } });
    expect(screen.getByRole("alert").textContent).toMatch(/3-30 characters/);
    expect(save).toHaveProperty("disabled", true);

    fireEvent.change(field, { target: { value: "admin" } });
    expect(screen.getByRole("alert").textContent).toBe("This username is reserved");
    expect(save).toHaveProperty("disabled", true);

    fireEvent.change(field, { target: { value: "a..b" } });
    expect(screen.getByRole("alert").textContent).toBe("No consecutive dots");
    expect(request.mock.calls.some(([m]) => m === "PUT")).toBe(false);
  });

  it("says when the name is taken and keeps the field open", async () => {
    const { api } = setup({
      "PUT /me/username": new ApiRequestError("USERNAME_TAKEN", "taken", 409),
    });
    await renderAt("/settings", { api });
    fireEvent.change(await openEditor("Choose a username"), { target: { value: "ben" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This username is already taken.");
    expect(screen.getByRole("textbox", { name: "Username" })).toBeTruthy();
  });

  it("changes a username, noting the old one stays reserved", async () => {
    const { api } = setup({
      "GET /me": meWith({ username: "ana" }),
      "PUT /me/username": { username: "ana2" },
    });
    await renderAt("/settings", { api });
    expect(await screen.findByText("@ana")).toBeTruthy();
    const field = await openEditor("Change");
    expect(field).toHaveProperty("value", "ana");
    expect(screen.queryByText(/stays reserved/)).toBeNull();

    fireEvent.change(field, { target: { value: "ana2" } });
    expect(screen.getByText("Your old name @ana stays reserved for you for 30 days.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("status")).textContent).toBe("Your username is now @ana2.");
  });

  it("cancels editing without saving", async () => {
    const { api, request } = setup({ "GET /me": meWith({ username: "ana" }) });
    await renderAt("/settings", { api });
    fireEvent.change(await openEditor("Change"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("@ana")).toBeTruthy();
    expect(request.mock.calls.some(([m]) => m === "PUT")).toBe(false);
  });
});

describe("settings: logout (FR-AUTH-5)", () => {
  it("clears the upload queue and the cache, then ends the session", async () => {
    const { api } = setup();
    const auth = fakeAuth({ signedIn: true });
    const { queue, store } = testUploadQueue(api, {
      post: () => new Promise(() => {}),
    });
    const clear = vi.spyOn(queue, "clear");
    const { router } = await renderAt("/settings", { api, auth, uploads: queue });
    await screen.findByRole("meter");
    // Private data another page left in the cache.
    const { queryClient } = router.options.context;
    queryClient.setQueryData(["albums"], { items: [] });

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(auth.logout).toHaveBeenCalledOnce());
    expect(clear).toHaveBeenCalled();
    expect(store.items.size).toBe(0);
    // Cache cleared before the session ends.
    expect(clear.mock.invocationCallOrder[0]!).toBeLessThan(
      auth.logout.mock.invocationCallOrder[0]!,
    );
    expect(queryClient.getQueryData(["albums"])).toBeUndefined();
  });

  it("asks first when uploads haven't finished, and Keep uploading keeps them", async () => {
    const { api } = setup({
      "POST /photos/upload-url": {
        photoId: "01JB2Z3M4N5P6Q7R8S9T000001",
        upload: { url: "https://photos.s3.amazonaws.com/", fields: {} },
      },
    });
    const auth = fakeAuth({ signedIn: true });
    const { queue, store } = testUploadQueue(api, { post: () => new Promise(() => {}) });
    await renderAt("/settings", { api, auth, uploads: queue });
    await screen.findByRole("meter");
    await queue.add([testFile("IMG_1.jpg"), testFile("IMG_2.jpg")]);

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("2 uploads haven't finished.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep uploading" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(auth.logout).not.toHaveBeenCalled();
    expect(store.items.size).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Log out" }),
    );
    await waitFor(() => expect(auth.logout).toHaveBeenCalledOnce());
    expect(store.items.size).toBe(0);
  });
});
