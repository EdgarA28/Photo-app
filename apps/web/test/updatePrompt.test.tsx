import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESUME_CHECK_MIN_MS, UPDATE_CHECK_INTERVAL_MS } from "../src/pwa/UpdatePrompt";
import { renderAt } from "./render";
import { pwa } from "./stubs/pwaRegister";

beforeEach(() => pwa.reset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("update prompt (9.4, FR-PWA-3)", () => {
  it("stays hidden while there's no new version", async () => {
    await renderAt("/gallery");
    expect(screen.queryByText("Update available.")).toBeNull();
  });

  it("offers a new version, also on the login page", async () => {
    pwa.needRefresh = true;
    await renderAt("/login");
    expect((await screen.findByRole("status")).textContent).toContain("Update available.");
  });

  it("Reload activates the new service worker and reloads", async () => {
    pwa.needRefresh = true;
    await renderAt("/gallery");
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(pwa.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("Later hides the prompt without updating", async () => {
    pwa.needRefresh = true;
    await renderAt("/gallery");
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("Update available.")).toBeNull();
    expect(pwa.updateServiceWorker).not.toHaveBeenCalled();
  });

  it("checks for a new version every hour while online", async () => {
    await renderAt("/gallery");
    vi.useFakeTimers();
    const update = vi.fn(async () => {});
    pwa.options!.onRegisteredSW!("/sw.js", { update } as unknown as ServiceWorkerRegistration);

    act(() => void vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS));
    expect(update).toHaveBeenCalledOnce();

    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => void vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS));
    expect(update).toHaveBeenCalledOnce();
  });

  it("also checks when the app comes back on screen, at most once a minute", async () => {
    await renderAt("/gallery");
    vi.useFakeTimers();
    const update = vi.fn(async () => {});
    pwa.options!.onRegisteredSW!("/sw.js", { update } as unknown as ServiceWorkerRegistration);
    const show = () => document.dispatchEvent(new Event("visibilitychange"));

    show(); // right after registering: too soon
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESUME_CHECK_MIN_MS);
    show();
    expect(update).toHaveBeenCalledOnce();
    show(); // again at once: skipped
    expect(update).toHaveBeenCalledOnce();
  });

  it("keeps working when registration fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderAt("/gallery");
    pwa.options!.onRegisterError!(new Error("insecure origin"));
    expect(warn).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Gallery" })).toBeTruthy();
  });
});
