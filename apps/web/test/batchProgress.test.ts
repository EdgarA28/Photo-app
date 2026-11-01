import { describe, expect, it } from "vitest";
import {
  batchProgress,
  createRateMeter,
  formatTimeLeft,
  RATE_MIN_MS,
} from "../src/upload/batchProgress";
import type { QueueEntry } from "../src/upload/queue";

// 13.1d: the /upload header's numbers.

const entry = (overrides: Partial<QueueEntry>): QueueEntry =>
  ({
    id: "x",
    userId: "u",
    file: null,
    fileName: "a.jpg",
    contentType: "image/jpeg",
    sizeBytes: 1000,
    photoId: null,
    status: "queued",
    attempts: 0,
    retryAt: 0,
    error: null,
    errorCode: null,
    addedAt: 0,
    progress: 0,
    ...overrides,
  }) as QueueEntry;

describe("batch progress (13.1d)", () => {
  it("counts files and bytes, the running uploads' sent part included", () => {
    expect(
      batchProgress([
        entry({ status: "done" }),
        entry({ status: "uploading", progress: 0.5 }),
        entry({ status: "queued" }),
        entry({ status: "queued", paused: true }),
        entry({ status: "failed" }),
      ]),
    ).toEqual({ done: 1, total: 5, bytesDone: 1500, bytesTotal: 5000, active: 2, paused: 1 });
  });

  it("estimates the time left from the recent speed, once there is enough to go by", () => {
    const meter = createRateMeter();
    // 1,000 bytes a second for 10 s, 20,000 bytes in all.
    expect(meter.sample(0, 0, 20_000, true)).toBeNull();
    for (let t = 2000; t < RATE_MIN_MS; t += 2000) {
      expect(meter.sample(t, t, 20_000 - t, true)).toBeNull();
    }
    expect(meter.sample(RATE_MIN_MS, RATE_MIN_MS, 10_000, true)).toBe(10_000);
  });

  it("uses only the last 30 s, so a speed change shows", () => {
    const meter = createRateMeter();
    let done = 0;
    for (let t = 0; t <= 60_000; t += 2000) {
      done += t < 30_000 ? 4000 : 1000; // 2,000 B/s, then 500 B/s
      meter.sample(t, done, 100_000, true);
    }
    // About 500 B/s over the window: 10,000 bytes take ~20 s.
    expect(meter.sample(62_000, done + 1000, 10_000, true)).toBeCloseTo(20_000, -3);
  });

  it("has no estimate while paused, and starts over after the total went down", () => {
    const meter = createRateMeter();
    for (let t = 0; t <= RATE_MIN_MS; t += 2000) meter.sample(t, t, 1000, true);
    expect(meter.sample(12_000, 12_000, 1000, true)).not.toBeNull();
    expect(meter.sample(14_000, 12_000, 1000, false)).toBeNull();
    expect(meter.sample(16_000, 12_000, 1000, true)).toBeNull();
    // Files removed: the total went down, measuring starts over.
    const other = createRateMeter();
    for (let t = 0; t <= RATE_MIN_MS; t += 2000) other.sample(t, t, 1000, true);
    expect(other.sample(12_000, 5000, 1000, true)).toBeNull();
  });

  it("says the time left in words", () => {
    expect(formatTimeLeft(20_000)).toBe("less than a minute");
    expect(formatTimeLeft(45 * 60_000)).toBe("about 45 min");
    expect(formatTimeLeft(130 * 60_000)).toBe("about 2 h 10 min");
    expect(formatTimeLeft(120 * 60_000)).toBe("about 2 h");
  });
});
