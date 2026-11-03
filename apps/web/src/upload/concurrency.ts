/**
 * Adaptive upload concurrency (13.1i, §12.4): how many files the queue sends at once. Starts at
 * 3, climbs one step after a full round of successes (as many in a row as the current limit),
 * up to 6, and halves on a temporary failure (network, 5xx, stalled upload), down to 1. Add
 * slowly, cut fast, like TCP congestion control: a fast link with small photos ends up at 6, a
 * slow or flaky one at 1–2, where parallel uploads would only slow each other down and time out.
 *
 * Failures of uploads started before the last cut don't cut again: one dropped connection fails
 * every running upload at once, and that is one signal, not five.
 */
export const START_CONCURRENCY = 3;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 6;

export interface Concurrency {
  /** Uploads allowed at once now. */
  readonly limit: number;
  /** Call when an upload starts; pass the token to `succeeded` / `failed`. */
  started(): number;
  succeeded(token: number): void;
  /** A temporary failure (permanent ones, like quota or validation, say nothing about the link). */
  failed(token: number): void;
  /** Back to the start value: a new session, or back online after the failures offline caused. */
  reset(): void;
}

export function createConcurrency({
  start = START_CONCURRENCY,
  min = MIN_CONCURRENCY,
  max = MAX_CONCURRENCY,
}: { start?: number; min?: number; max?: number } = {}): Concurrency {
  let limit = Math.min(Math.max(start, min), max);
  let streak = 0;
  /** Bumped on every cut: uploads started earlier belong to the burst already accounted for. */
  let generation = 0;

  return {
    get limit() {
      return limit;
    },
    started: () => generation,
    succeeded() {
      if (limit >= max) return;
      if (++streak >= limit) {
        limit++;
        streak = 0;
      }
    },
    failed(token) {
      streak = 0;
      if (token < generation) return;
      generation++;
      limit = Math.max(min, Math.floor(limit / 2));
    },
    reset() {
      limit = Math.min(Math.max(start, min), max);
      streak = 0;
      generation++;
    },
  };
}
