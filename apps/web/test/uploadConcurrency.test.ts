import { describe, expect, it } from "vitest";
import {
  createConcurrency,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  START_CONCURRENCY,
} from "../src/upload/concurrency";

/** `n` uploads started and finished one after the other. */
const succeed = (c: ReturnType<typeof createConcurrency>, n: number) => {
  for (let i = 0; i < n; i++) c.succeeded(c.started());
};

describe("adaptive upload concurrency (13.1i)", () => {
  it("starts at 3 and stays between 1 and 6", () => {
    expect([START_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY]).toEqual([3, 1, 6]);
    expect(createConcurrency().limit).toBe(3);
    expect(createConcurrency({ start: 10 }).limit).toBe(6);
    expect(createConcurrency({ start: 0 }).limit).toBe(1);
  });

  it("climbs one step per round of successes: 3 → 4 after 3, → 5 after 4 more, → 6 after 5 more", () => {
    const c = createConcurrency();
    succeed(c, 2);
    expect(c.limit).toBe(3);
    succeed(c, 1);
    expect(c.limit).toBe(4);
    succeed(c, 4);
    expect(c.limit).toBe(5);
    succeed(c, 5);
    expect(c.limit).toBe(6);
    succeed(c, 100);
    expect(c.limit).toBe(6);
  });

  it("halves on a temporary failure, down to 1", () => {
    const c = createConcurrency({ start: 6 });
    c.failed(c.started());
    expect(c.limit).toBe(3);
    c.failed(c.started());
    expect(c.limit).toBe(1);
    c.failed(c.started());
    expect(c.limit).toBe(1);
  });

  it("cuts once for failures of uploads that were already running", () => {
    const c = createConcurrency({ start: 6 });
    const running = Array.from({ length: 6 }, () => c.started());
    for (const token of running) c.failed(token);
    expect(c.limit).toBe(3);
    // An upload started after the cut that fails too: the link is still bad.
    c.failed(c.started());
    expect(c.limit).toBe(1);
  });

  it("a failure restarts the success count", () => {
    const c = createConcurrency();
    succeed(c, 2);
    c.failed(c.started());
    expect(c.limit).toBe(1);
    succeed(c, 1);
    expect(c.limit).toBe(2);
    succeed(c, 1);
    expect(c.limit).toBe(2);
    succeed(c, 1);
    expect(c.limit).toBe(3);
  });

  it("reset goes back to the start value and ignores the older uploads' failures", () => {
    const c = createConcurrency();
    const before = c.started();
    succeed(c, 3);
    expect(c.limit).toBe(4);
    c.reset();
    expect(c.limit).toBe(3);
    c.failed(before);
    expect(c.limit).toBe(3);
  });
});
