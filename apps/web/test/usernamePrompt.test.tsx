import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import { isPromptSkipped, skipPrompt } from "../src/settings/usernamePromptStore";
import { fakeApi, fakeAuth, testMe, testPhotoPage, testUser } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const OTHER = "54589468-8071-707e-e65a-20ae6c5231fc";

/** A signed-in user without a username, whose PUT /me/username succeeds unless overridden. */
function setup(responses: Record<string, unknown> = {}) {
  let username: string | null = null;
  return fakeApi({
    ...defaultResponses,
    "GET /photos": testPhotoPage(0, 2),
    "GET /me": () => ({ ...testMe, username }),
    "PUT /me/username": () => {
      username = "ana_r";
      return { username };
    },
    ...responses,
  });
}

const prompt = () => screen.findByRole("dialog", { name: "Choose a username" });

async function expectNoPrompt() {
  // Let GET /me settle first, so "no dialog" isn't just "not loaded yet".
  await screen.findByRole("main");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("dialog")).toBeNull();
}

describe("first-login username prompt (FR-ACC-3, 8.15)", () => {
  it("asks for a username while there is none", async () => {
    const { api } = setup();
    await renderAt("/gallery", { api });
    const dialog = await prompt();
    expect(dialog.textContent).toContain("Friends can share albums with you by @username");
    expect(within(dialog).getByRole("textbox", { name: "Username" })).toBeTruthy();
  });

  it("saves the name (normalised), confirms, and doesn't ask again", async () => {
    const { api, request } = setup();
    await renderAt("/gallery", { api });
    const dialog = await prompt();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Username" }), {
      target: { value: "@Ana_R" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("dialog", { name: "You're @ana_r" })).toBeTruthy();
    expect(request.mock.calls.find(([m]) => m === "PUT")?.[2]?.body).toEqual({
      username: "ana_r",
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog open when the name is taken", async () => {
    const { api } = setup({
      "PUT /me/username": new ApiRequestError("USERNAME_TAKEN", "taken", 409),
    });
    await renderAt("/gallery", { api });
    const dialog = await prompt();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Username" }), {
      target: { value: "ben" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "This username is already taken.",
    );
    expect(screen.getByRole("dialog", { name: "Choose a username" })).toBeTruthy();
  });

  it("remembers Later for this account on this device", async () => {
    const { api, request } = setup();
    await renderAt("/gallery", { api });
    fireEvent.click(within(await prompt()).getByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(isPromptSkipped(testUser.sub)).toBe(true);
    expect(request.mock.calls.some(([m]) => m === "PUT")).toBe(false);

    // Next visit (or next login): no prompt.
    cleanup();
    await renderAt("/gallery", { api });
    await expectNoPrompt();
  });

  it("still asks another account on the same device", async () => {
    skipPrompt(testUser.sub);
    const auth = fakeAuth({ signedIn: true });
    auth.getUser.mockResolvedValue({ ...testUser, sub: OTHER });
    const { api } = setup();
    await renderAt("/gallery", { api, auth });
    expect(await prompt()).toBeTruthy();
  });

  it("treats Escape as Later", async () => {
    const { api } = setup();
    await renderAt("/gallery", { api });
    fireEvent.keyDown(await prompt(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(isPromptSkipped(testUser.sub)).toBe(true);
  });

  it("doesn't ask when a username is set", async () => {
    const { api } = setup({ "GET /me": testMe });
    await renderAt("/gallery", { api });
    await expectNoPrompt();
  });

  it("doesn't ask on the settings page, which has the field", async () => {
    const { api } = setup();
    await renderAt("/settings", { api });
    await screen.findByText(/No username yet/);
    await expectNoPrompt();
  });

  it("doesn't ask in the full-screen viewer", async () => {
    const { api } = setup();
    await renderAt(`/photos/${testPhotoPage(0, 1).items[0]!.photoId}`, { api });
    await screen.findByRole("button", { name: "Download original" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays out of the way when GET /me fails", async () => {
    const { api } = setup({ "GET /me": new ApiRequestError("INTERNAL_ERROR", "x", 500) });
    await renderAt("/gallery", { api });
    await expectNoPrompt();
  });
});

describe("remembering Later", () => {
  it("is per account", () => {
    skipPrompt(testUser.sub);
    expect(isPromptSkipped(testUser.sub)).toBe(true);
    expect(isPromptSkipped(OTHER)).toBe(false);
  });

  it("survives storage that throws (private mode, blocked site data)", () => {
    const broken = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;
    expect(() => skipPrompt(testUser.sub, broken)).not.toThrow();
    expect(isPromptSkipped(testUser.sub, broken)).toBe(false);
  });
});
