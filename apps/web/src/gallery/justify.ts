export interface Tile<T> {
  item: T;
  width: number;
}

export interface Row<T> {
  tiles: Tile<T>[];
  height: number;
}

export interface JustifyOptions {
  containerWidth: number;
  targetHeight: number;
  gap: number;
}

// Panoramas and very tall photos would make a row too thin or a tile a sliver.
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 3;

/**
 * Justified rows (§12.3): photos keep their aspect ratio and each full row is scaled to fill the
 * container exactly; the last, unfilled row stays at the target height. Sizes come from the API's
 * width/height, so every tile's box is known before its image loads (no layout shift).
 */
export function justifyRows<T>(
  items: readonly T[],
  aspectOf: (item: T) => number,
  { containerWidth, targetHeight, gap }: JustifyOptions,
): Row<T>[] {
  const rows: Row<T>[] = [];
  let pending: { item: T; aspect: number }[] = [];
  let aspectSum = 0;

  for (const item of items) {
    const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspectOf(item)));
    pending.push({ item, aspect });
    aspectSum += aspect;
    const available = containerWidth - gap * (pending.length - 1);
    if (aspectSum * targetHeight >= available) {
      const height = available / aspectSum;
      rows.push({
        height,
        tiles: pending.map((t) => ({ item: t.item, width: t.aspect * height })),
      });
      pending = [];
      aspectSum = 0;
    }
  }
  if (pending.length > 0) {
    rows.push({
      height: targetHeight,
      tiles: pending.map((t) => ({ item: t.item, width: t.aspect * targetHeight })),
    });
  }
  return rows;
}
