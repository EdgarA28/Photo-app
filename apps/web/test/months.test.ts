import { describe, expect, it } from "vitest";
import { monthSections } from "../src/gallery/months";

const label = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(iso));
// Mid-month noon UTC: the same local month in every time zone the tests might run in.
const at = (month: string) => ({ takenAt: `${month}-15T12:00:00.000Z` });
const sections = (items: { takenAt: string }[]) =>
  monthSections(items, (item) => item.takenAt).map(({ key, label, items }) => ({
    key,
    label,
    count: items.length,
  }));

describe("monthSections (§12.3)", () => {
  it("groups consecutive photos of the same month, newest first", () => {
    expect(sections([at("2026-10"), at("2026-10"), at("2026-09"), at("2025-10")])).toEqual([
      { key: "2026-10", label: label("2026-10-15T12:00:00.000Z"), count: 2 },
      { key: "2026-09", label: label("2026-09-15T12:00:00.000Z"), count: 1 },
      { key: "2025-10", label: label("2025-10-15T12:00:00.000Z"), count: 1 },
    ]);
  });

  it("works oldest first too", () => {
    expect(sections([at("2024-01"), at("2024-02"), at("2024-02")]).map((s) => s.key)).toEqual([
      "2024-01",
      "2024-02",
    ]);
  });

  it("uses local time, like the viewer's dates", () => {
    const date = new Date(2026, 0, 31, 23, 30); // 31 Jan, 23:30 local
    const [section] = monthSections([{ takenAt: date.toISOString() }], (item) => item.takenAt);
    expect(section!.key).toBe("2026-01");
  });

  it("returns nothing for no photos", () => {
    expect(sections([])).toEqual([]);
  });
});
