const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1536 → "1.5 KB" (binary units, as the quota is configured: 5 GiB dev, 25 GiB prod). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/**
 * A video's length for its tile (FR-VID-4): 5_400 → "0:05", 754_000 → "12:34", 3_723_000 →
 * "1:02:03". Rounded to the nearest second, at least "0:01" for a clip of under a second.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "Video, 1:05" for a tile's label (spoken: the badge itself is hidden from screen readers). */
export function videoLabel(durationMs: number | null): string {
  return durationMs === null ? "Video" : `Video, ${formatDuration(durationMs)}`;
}
