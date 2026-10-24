import { describe, expect, it } from "vitest";
import { justifyRows } from "../src/gallery/justify";

const options = { containerWidth: 1000, targetHeight: 200, gap: 4 };
const byAspect = (aspect: number) => aspect;
const rowWidth = (row: { tiles: { width: number }[] }) =>
  row.tiles.reduce((sum, tile) => sum + tile.width, 0) + options.gap * (row.tiles.length - 1);

describe("justifyRows (§12.3)", () => {
  it("fills every full row to the container width, keeping aspect ratios", () => {
    const aspects = [1.5, 0.75, 1, 1.33, 1.5, 1.5, 0.75, 2, 1, 1.33];
    const rows = justifyRows(aspects, byAspect, options);
    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row)).toBeCloseTo(1000, 6);
      for (const tile of row.tiles) expect(tile.width / row.height).toBeCloseTo(tile.item, 6);
    }
    expect(rows.flatMap((row) => row.tiles.map((tile) => tile.item))).toEqual(aspects);
  });

  it("closes a row as soon as it reaches the width, so rows stay close to the target height", () => {
    // 5 squares at 200 px = 1016 px with gaps: over 1000, so the row shrinks slightly.
    const [first] = justifyRows([1, 1, 1, 1, 1, 1], byAspect, options);
    expect(first!.tiles).toHaveLength(5);
    expect(first!.height).toBeCloseTo((1000 - 16) / 5, 6);
  });

  it("leaves the last, unfilled row at the target height instead of stretching it", () => {
    const rows = justifyRows([1, 1, 1, 1, 1, 1, 1.5], byAspect, options);
    const last = rows.at(-1)!;
    expect(last.height).toBe(200);
    expect(last.tiles.map((tile) => tile.width)).toEqual([200, 300]);
    expect(rowWidth(last)).toBeLessThan(1000);
  });

  it("clamps panoramas and very tall photos", () => {
    const [panorama] = justifyRows([10], byAspect, { ...options, containerWidth: 2000 });
    expect(panorama!.tiles[0]!.width / panorama!.height).toBe(3);
    const [tall] = justifyRows([0.1], byAspect, options);
    expect(tall!.tiles[0]!.width / tall!.height).toBe(0.5);
  });

  it("lays out nothing for no photos", () => {
    expect(justifyRows([], byAspect, options)).toEqual([]);
  });
});
