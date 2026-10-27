export interface MonthSection<T> {
  /** `YYYY-MM`, stable across renders (React/virtualizer keys). */
  key: string;
  /** "October 2026" in the user's locale. */
  label: string;
  items: T[];
}

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/**
 * Month sections of a list already ordered by date taken (§12.3): consecutive items of the same
 * month form one section, so it works for newest-first and oldest-first alike. Months are local
 * time, like the dates the viewer shows.
 */
export function monthSections<T>(
  items: readonly T[],
  dateOf: (item: T) => string,
): MonthSection<T>[] {
  const sections: MonthSection<T>[] = [];
  for (const item of items) {
    const date = new Date(dateOf(item));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const last = sections.at(-1);
    if (last?.key === key) last.items.push(item);
    else sections.push({ key, label: monthFormat.format(date), items: [item] });
  }
  return sections;
}
