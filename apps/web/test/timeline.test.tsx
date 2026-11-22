/**
 * The gallery's timeline scrubber (8.36, FR-GAL-9): helpers, the strip itself and the jump that
 * restarts the list at a month, then loads newer photos above.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jumpStart, monthAt, monthLabel, monthPositions } from "../src/gallery/timeline";
import { TimelineScrubber } from "../src/gallery/TimelineScrubber";
import { fakeApi, testPhoto } from "./fakes";
import { defaultResponses, renderAt } from "./render";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MONTHS = [
  { month: "2026-10", count: 60 },
  { month: "2026-08", count: 20 },
  { month: "2025-12", count: 10 },
  { month: "2021-03", count: 10 },
];

describe("timeline helpers", () => {
  it("places months by the photos before them", () => {
    expect(monthPositions(MONTHS)).toEqual([0, 0.6, 0.8, 0.9]);
    expect(monthAt(MONTHS, 0)).toBe(0);
    expect(monthAt(MONTHS, 0.65)).toBe(1);
    expect(monthAt(MONTHS, 1)).toBe(3);
  });

  it("starts a jump where the month's photos begin in the list's order", () => {
    // Newest first: everything taken before next month began (local time).
    expect(jumpStart("2025-12", "taken-desc")).toBe(new Date(2026, 0, 1).toISOString());
    // Oldest first: from the month's first day.
    expect(jumpStart("2025-12", "taken-asc")).toBe(new Date(2025, 11, 1).toISOString());
  });

  it("labels months short", () => {
    expect(monthLabel("2026-10")).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(
        new Date(2026, 9, 1),
      ),
    );
  });
});

describe("TimelineScrubber", () => {
  it("is a slider over the months, at the current one", () => {
    render(<TimelineScrubber months={MONTHS} current="2026-08" onScrub={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Timeline" });
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
    expect(slider.getAttribute("aria-valuemax")).toBe("3");
    expect(slider.getAttribute("aria-valuetext")).toBe(monthLabel("2026-08"));
  });

  it("keys move the handle at once and jump once they stop", () => {
    vi.useFakeTimers();
    const onScrub = vi.fn();
    render(<TimelineScrubber months={MONTHS} current="2026-10" onScrub={onScrub} />);
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(slider.getAttribute("aria-valuetext")).toBe(monthLabel("2025-12"));
    expect(onScrub.mock.calls.filter(([, final]) => final)).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(onScrub).toHaveBeenLastCalledWith("2025-12", true);
    fireEvent.keyDown(slider, { key: "End" });
    vi.advanceTimersByTime(400);
    expect(onScrub).toHaveBeenLastCalledWith("2021-03", true);
    fireEvent.keyDown(slider, { key: "Home" });
    vi.advanceTimersByTime(400);
    expect(onScrub).toHaveBeenLastCalledWith("2026-10", true);
  });
});

describe("gallery with the timeline", () => {
  const october = (n: number) => testPhoto(n, { takenAt: "2026-10-05T10:00:00.000Z" });
  const old = (n: number) => testPhoto(n, { takenAt: "2021-03-03T10:00:00.000Z" });

  function setup() {
    return fakeApi({
      ...defaultResponses,
      "GET /photos/timeline": { months: MONTHS },
      "GET /photos": (query: { start?: string; direction?: string; cursor?: string } = {}) => {
        if (query.direction === "backward") {
          return { items: [october(1)], nextCursor: null, prevCursor: null };
        }
        if (query.start) return { items: [old(2)], nextCursor: null, prevCursor: "before-old" };
        return { items: [october(1)], nextCursor: "more", prevCursor: null };
      },
    });
  }

  it("shows the strip with the years of the library", async () => {
    // jsdom lays nothing out: give the strip a phone's height, so the years have room.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
    const { api, request } = setup();
    await renderAt("/gallery", { api });
    const slider = await screen.findByRole("slider", { name: "Timeline" });
    expect(slider.textContent).toContain("2026");
    expect(slider.textContent).toContain("2021");
    // In this device's time zone (the API groups by it).
    const timeline = request.mock.calls.find(([, p]) => p === "/photos/timeline");
    expect(timeline?.[2]?.query).toEqual({ utcOffset: -new Date().getTimezoneOffset() });
  });

  it("a month that isn't loaded restarts the list there, then loads newer photos above", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, request } = setup();
    const { router } = await renderAt("/gallery", { api });
    fireEvent.keyDown(await screen.findByRole("slider"), { key: "End" });
    vi.advanceTimersByTime(400);

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        from: jumpStart("2021-03", "taken-desc"),
      }),
    );
    await waitFor(() => {
      const queries = request.mock.calls
        .filter(([, p]) => p === "/photos")
        .map(([, , o]) => o?.query);
      expect(queries).toContainEqual(
        expect.objectContaining({ start: jumpStart("2021-03", "taken-desc") }),
      );
      expect(queries).toContainEqual({
        sort: "taken-desc",
        cursor: "before-old",
        direction: "backward",
      });
    });
  });

  it("no strip in a place's photos or for a single month", async () => {
    const { api } = fakeApi({
      ...defaultResponses,
      "GET /photos/timeline": { months: [MONTHS[0]] },
      "GET /photos": { items: [october(1)], nextCursor: null, prevCursor: null },
    });
    await renderAt("/gallery", { api });
    await screen.findByRole("link", { name: /^IMG_1/ });
    expect(screen.queryByRole("slider", { name: "Timeline" })).toBeNull();
  });
});
