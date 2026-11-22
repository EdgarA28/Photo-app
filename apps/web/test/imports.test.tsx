/**
 * Import from Google Photos, web side (13.5g; FR-IMP-1/5, §11.5, NFR-SEC-10): Google's consent
 * with PKCE + state, the callback page, the import's progress page and the Settings entry.
 */
import { GOOGLE_PHOTOS_PICKER_SCOPE } from "@photo-app/shared";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../src/api/errors";
import {
  base64Url,
  importRedirectUri,
  startGoogleConsent,
  takeGoogleConsent,
} from "../src/import/googleConsent";
import { openPicker, pickerUriOf, savePickerUri } from "../src/import/pickerStore";
import { importSummary } from "../src/routes/_authenticated/import/$importId";
import { fakeApi, testConfig, testId } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const IMPORT_ID = testId(7);
const PICKER = "https://photos.google.com/picker/session-1";

/** Runs the consent start and returns the URL Google would be sent to. */
async function consentUrl(loginHint?: string) {
  let url = "";
  await startGoogleConsent(
    { clientId: "client-1", origin: "https://app.example", ...(loginHint && { loginHint }) },
    { navigate: (to) => (url = to) },
  );
  return new URL(url);
}

describe("Google consent (§11.5)", () => {
  it("asks for the Picker scope only, with PKCE S256 and a fresh state", async () => {
    const url = await consentUrl("user@example.com");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("client-1");
    expect(p.get("redirect_uri")).toBe("https://app.example/import/google/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe(GOOGLE_PHOTOS_PICKER_SCOPE);
    expect(p.get("access_type")).toBe("online");
    expect(p.get("include_granted_scopes")).toBe("false");
    expect(p.get("login_hint")).toBe("user@example.com");
    expect(p.get("code_challenge_method")).toBe("S256");

    // The challenge is SHA-256 of the stored verifier; state matches the stored one.
    const stored = JSON.parse(sessionStorage.getItem("photo-app:google-import-consent")!);
    expect(stored.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(p.get("state")).toBe(stored.state);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stored.codeVerifier),
    );
    expect(p.get("code_challenge")).toBe(base64Url(new Uint8Array(digest)));

    const again = await consentUrl();
    expect(again.searchParams.get("state")).not.toBe(p.get("state"));
    expect(again.searchParams.has("login_hint")).toBe(false);
  });

  it("accepts Google's answer once, with the matching state", async () => {
    const state = (await consentUrl()).searchParams.get("state")!;
    const answer = new URLSearchParams({ code: "4/abc", state });
    const result = takeGoogleConsent(answer);
    expect(result).toMatchObject({ kind: "ok", code: "4/abc" });
    // Used once: a replay finds nothing.
    expect(takeGoogleConsent(answer)).toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["another state", { code: "4/abc", state: "forged" }],
    ["no code", { state: "@state" }],
    ["a Google error", { error: "server_error" }],
  ])("refuses %s", async (_, params) => {
    const state = (await consentUrl()).searchParams.get("state")!;
    const search = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === "@state" ? state : v])),
    );
    expect(takeGoogleConsent(search).kind).toBe("invalid");
    expect(sessionStorage.getItem("photo-app:google-import-consent")).toBeNull();
  });

  it("reads a denied consent as cancelled", async () => {
    await consentUrl();
    expect(takeGoogleConsent(new URLSearchParams({ error: "access_denied" }))).toEqual({
      kind: "cancelled",
    });
  });

  it("refuses an answer to a consent that is too old", async () => {
    let url = "";
    await startGoogleConsent(
      { clientId: "c", origin: "https://a" },
      { navigate: (to) => (url = to), now: () => 0 },
    );
    const state = new URL(url).searchParams.get("state")!;
    const result = takeGoogleConsent(new URLSearchParams({ code: "x", state }), {
      now: () => 16 * 60 * 1000,
    });
    expect(result.kind).toBe("invalid");
  });
});

describe("picker link", () => {
  it("is kept per import in this tab, https only, and opened with /autoclose", () => {
    savePickerUri(IMPORT_ID, PICKER);
    expect(pickerUriOf(IMPORT_ID)).toBe(PICKER);
    savePickerUri(testId(8), "javascript:alert(1)");
    expect(pickerUriOf(testId(8))).toBeNull();
    const open = vi.fn();
    openPicker(PICKER, open as unknown as typeof window.open);
    expect(open).toHaveBeenCalledWith(`${PICKER}/autoclose`, "_blank", "noopener");
  });
});

describe("callback page (FR-IMP-1)", () => {
  async function returnFromGoogle(response: unknown, params?: Record<string, string>) {
    const state = (await consentUrl()).searchParams.get("state")!;
    const { api, request } = fakeApi({
      ...defaultResponses,
      "POST /imports/google": response,
      [`GET /imports/${IMPORT_ID}`]: {
        status: "picking",
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        failedReasons: {},
      },
    });
    const search = new URLSearchParams(params ?? { code: "4/abc", state });
    const { router } = await renderAt(`/import/google/callback?${search}`, { api });
    return { router, request };
  }

  it("starts the import with the code and verifier, then shows its page", async () => {
    const { router, request } = await returnFromGoogle({
      importId: IMPORT_ID,
      pickerUri: PICKER,
      expiresAt: "2026-11-22T12:00:00.000Z",
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/import/${IMPORT_ID}`));
    const call = request.mock.calls.find(([m, p]) => m === "POST" && p === "/imports/google")!;
    const body = call[2]!.body as Record<string, string>;
    expect(body.code).toBe("4/abc");
    expect(body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(body.redirectUri).toBe(importRedirectUri(window.location.origin));
    expect(
      await screen.findByRole("button", { name: "Choose photos in Google Photos" }),
    ).toBeTruthy();
  });

  it("says so when Google rejected the code", async () => {
    await returnFromGoogle(new ApiRequestError("GOOGLE_AUTH_FAILED", "rejected", 400));
    expect(await screen.findByText("The import didn't start")).toBeTruthy();
    expect(screen.getByText(/Google didn't accept the sign-in/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("never calls the API with a forged state", async () => {
    const { request } = await returnFromGoogle({}, { code: "4/abc", state: "forged" });
    expect(await screen.findByText("The import didn't start")).toBeTruthy();
    expect(request.mock.calls.some(([, p]) => p === "/imports/google")).toBe(false);
  });

  it("explains a denied consent", async () => {
    await returnFromGoogle({}, { error: "access_denied" });
    expect(await screen.findByText("Import cancelled")).toBeTruthy();
  });
});

describe("import page (FR-IMP-5)", () => {
  const progress = (overrides: Record<string, unknown>) => ({
    status: "copying",
    total: 10,
    done: 4,
    failed: 1,
    skipped: 2,
    failedReasons: { QUOTA_EXCEEDED: 1 },
    ...overrides,
  });

  async function openImport(state: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { api, request } = fakeApi({
      ...defaultResponses,
      [`GET /imports/${IMPORT_ID}`]: progress(state),
      [`DELETE /imports/${IMPORT_ID}`]: undefined,
      ...extra,
    });
    await renderAt(`/import/${IMPORT_ID}`, { api });
    return { request };
  }

  beforeEach(() => savePickerUri(IMPORT_ID, PICKER));

  it("while picking: opens Google's picker from a tap", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await openImport({ status: "picking", total: 0, done: 0, failed: 0, failedReasons: {} });
    fireEvent.click(await screen.findByRole("button", { name: "Choose photos in Google Photos" }));
    expect(open).toHaveBeenCalledWith(`${PICKER}/autoclose`, "_blank", "noopener");
  });

  it("while picking in another tab: no picker button, just the wait", async () => {
    sessionStorage.clear();
    await openImport({ status: "picking", total: 0, done: 0, failed: 0, failedReasons: {} });
    expect(await screen.findByText(/in the tab or app where you started/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Choose photos/ })).toBeNull();
  });

  it("while copying: progress, and the app may close", async () => {
    await openImport({});
    const bar = await screen.findByRole("progressbar", { name: "Import progress" });
    expect(bar.getAttribute("value")).toBe("5");
    expect(bar.getAttribute("max")).toBe("10");
    expect(screen.getByText(/Copying 5 of 10 photos… You can close the app/)).toBeTruthy();
  });

  it("cancels on request", async () => {
    const { request } = await openImport({});
    fireEvent.click(await screen.findByRole("button", { name: "Cancel import" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([m, p]) => m === "DELETE" && p === `/imports/${IMPORT_ID}`),
      ).toBe(true),
    );
  });

  it("when done: the summary and a way to the gallery", async () => {
    await openImport({ status: "done", total: 10, done: 9, failed: 1 });
    expect((await screen.findByRole("status")).textContent).toBe(
      "Imported 9 photos · 2 skipped (videos or other types) · 1 not imported: storage full.",
    );
    expect(screen.getByRole("link", { name: "Go to gallery" })).toBeTruthy();
  });

  it("when picking ran out of time: start again", async () => {
    await openImport({
      status: "expired",
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      failedReasons: {},
    });
    expect((await screen.findByRole("status")).textContent).toContain(
      "time to choose photos ran out",
    );
    expect(screen.getByRole("button", { name: "Import more" })).toBeTruthy();
  });

  it("summaries name every failure reason", () => {
    expect(
      importSummary({
        status: "done",
        total: 4,
        done: 1,
        failed: 3,
        skipped: 0,
        failedReasons: { TOO_LARGE: 1, NOT_FOUND: 1, EXPIRED: 1 },
      }),
    ).toBe(
      "Imported 1 photo · 1 not imported: larger than 50 MB · 1 not imported: no longer in Google Photos · 1 not imported: Google's access ran out",
    );
  });
});

describe("settings entry", () => {
  it("offers the import when it is configured", async () => {
    await renderAt("/settings");
    expect(await screen.findByRole("button", { name: "Import from Google Photos" })).toBeTruthy();
  });

  it("hides it otherwise", async () => {
    await renderAt("/settings", { config: { ...testConfig, googleImport: null } });
    await screen.findByText("Storage");
    expect(screen.queryByRole("button", { name: "Import from Google Photos" })).toBeNull();
  });
});
