import type { Photo } from "@photo-app/shared";
import { describe, expect, it } from "vitest";
import {
  gridItems,
  MAX_ZOOM,
  rowHeightFor,
  ZOOM_STEPS,
  type GridItem,
} from "../src/gallery/gridLayout";

const photo = (n: number, width: number, height: number) =>
  ({ photoId: `p${n}`, width, height, takenAt: "2026-10-03T10:00:00.000Z" }) as Photo;
const rows = (items: GridItem[]) => items.flatMap((item) => (item.kind === "row" ? [item] : []));
const PHONE = 412; // The width measured from the user's Google Photos screenshot.

describe("grid sizes on a phone (FR-GAL-8)", () => {
  it("keeps two photos per row at the largest size, whatever their shape, as Google Photos does", () => {
    const portrait = [1, 2, 3, 4].map((n) => photo(n, 3000, 4000));
    const landscape = [5, 6, 7, 8].map((n) => photo(n, 4000, 3000));
    const [tall, , wide] = rows(gridItems([...portrait, ...landscape], PHONE, MAX_ZOOM, false));
    expect(tall!.row.tiles).toHaveLength(2);
    expect(tall!.row.height).toBeCloseTo(274, 0); // 275 px in the screenshot
    expect(wide!.row.tiles).toHaveLength(2);
    expect(wide!.row.height).toBeCloseTo(154, 0); // 155 px in the screenshot
  });

  it("goes 4, 3, 2 photos per row at the larger sizes, in any shape: a layout for each", () => {
    for (const [w, h] of [
      [3000, 4000],
      [4000, 3000],
      [1000, 1000],
    ] as const) {
      const photos = Array.from({ length: 24 }, (_, n) => photo(n, w, h));
      const counts = [MAX_ZOOM - 2, MAX_ZOOM - 1, MAX_ZOOM].map(
        (step) => rows(gridItems(photos, PHONE, step, false))[0]!.row.tiles.length,
      );
      expect(counts).toEqual([4, 3, 2]);
    }
  });

  it("fills the width with hairline gaps, on a small phone too", () => {
    for (const width of [PHONE, 360]) {
      const photos = [1, 2, 3, 4, 5, 6].map((n) => photo(n, 3000, 2000));
      for (const { row, gap } of rows(gridItems(photos, width, MAX_ZOOM, false))) {
        const used = row.tiles.reduce((sum, tile) => sum + tile.width, 0);
        expect(gap).toBe(1.5);
        expect(used + gap * (row.tiles.length - 1)).toBeCloseTo(width, 6);
      }
    }
  });

  it("gives a panorama its own row", () => {
    const items = rows(
      gridItems([photo(1, 3000, 1000), photo(2, 3000, 4000)], PHONE, MAX_ZOOM, false),
    );
    expect(items[0]!.row.tiles).toHaveLength(1);
  });

  it("only grows from step to step", () => {
    for (const width of [320, 360, PHONE, 600, 1000]) {
      const heights = ZOOM_STEPS.map((step) => rowHeightFor(width, step));
      expect(heights).toEqual([...heights].sort((a, b) => a - b));
      expect(new Set(heights).size).toBe(ZOOM_STEPS.length);
    }
  });

  it("leaves wider screens' rows uncapped, with their wider gap", () => {
    const photos = [1, 2, 3, 4, 5, 6].map((n) => photo(n, 3000, 4000));
    const [first] = rows(gridItems(photos, 1000, MAX_ZOOM, false));
    expect(first!.gap).toBe(4);
    expect(first!.row.tiles.length).toBeGreaterThan(2);
  });
});
