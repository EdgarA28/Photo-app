import { useEffect, useRef, useState } from "react";
import type { QueueEntry } from "./queue";

/** How the queue is doing as a whole (13.1d): what the /upload header shows. */
export interface BatchProgress {
  done: number;
  total: number;
  /** Uploaded bytes, the running uploads' sent part included. */
  bytesDone: number;
  bytesTotal: number;
  /** Waiting or running, not paused. */
  active: number;
  paused: number;
}

export function batchProgress(entries: readonly QueueEntry[]): BatchProgress {
  const progress: BatchProgress = {
    done: 0,
    total: entries.length,
    bytesDone: 0,
    bytesTotal: 0,
    active: 0,
    paused: 0,
  };
  for (const entry of entries) {
    progress.bytesTotal += entry.sizeBytes;
    if (entry.status === "done") {
      progress.done++;
      progress.bytesDone += entry.sizeBytes;
    } else if (entry.paused) {
      progress.paused++;
    } else if (entry.status === "queued" || entry.status === "uploading") {
      progress.active++;
      if (entry.status === "uploading") progress.bytesDone += entry.sizeBytes * entry.progress;
    }
  }
  return progress;
}

/** Speed is measured over this much recent time… */
export const RATE_WINDOW_MS = 30_000;
/** …and a time left is only given once there is at least this much of it. */
export const RATE_MIN_MS = 10_000;
/** How often the time left is worked out again. */
export const TIME_LEFT_EVERY_MS = 2000;

export interface RateMeter {
  /**
   * The time left (ms) for `bytesLeft` at the speed of the last 30 s, or null while there isn't
   * enough to go by: the first 10 s, a pause, or after the uploaded total went down (files
   * removed), which start the measuring over.
   */
  sample(now: number, bytesDone: number, bytesLeft: number, running: boolean): number | null;
}

export function createRateMeter(): RateMeter {
  const samples: { at: number; bytes: number }[] = [];
  return {
    sample(now, bytesDone, bytesLeft, running) {
      if (!running || (samples.length && bytesDone < samples.at(-1)!.bytes)) samples.length = 0;
      if (!running) return null;
      samples.push({ at: now, bytes: bytesDone });
      while (samples.length > 2 && now - samples[1]!.at > RATE_WINDOW_MS) samples.shift();
      const first = samples[0]!;
      const elapsed = now - first.at;
      const sent = bytesDone - first.bytes;
      if (elapsed < RATE_MIN_MS || sent <= 0) return null;
      return (bytesLeft / sent) * elapsed;
    },
  };
}

/** The time left of the running uploads (13.1d), worked out every 2 s from the latest numbers. */
export function useTimeLeft(bytesDone: number, bytesLeft: number, running: boolean): number | null {
  const latest = useRef({ bytesDone, bytesLeft, running });
  useEffect(() => {
    latest.current = { bytesDone, bytesLeft, running };
  });
  const [meter] = useState(createRateMeter);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const { bytesDone, bytesLeft, running } = latest.current;
      setTimeLeft(meter.sample(Date.now(), bytesDone, bytesLeft, running));
    }, TIME_LEFT_EVERY_MS);
    return () => clearInterval(id);
  }, [meter]);
  return running ? timeLeft : null;
}

/** "less than a minute", "about 45 min", "about 2 h 10 min". */
export function formatTimeLeft(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ""}`;
}
