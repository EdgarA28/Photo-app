import { useCallback, useEffect, useMemo, useState } from "react";
import type { GridSelection } from "./PhotoGrid";

/**
 * Select mode for a photo grid (8.11): which photos are picked, toggling, and Escape to leave.
 * `forced` keeps it on (picking photos to add to an album).
 */
export function useSelection({ forced = false }: { forced?: boolean } = {}) {
  const [on, setOn] = useState(forced);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const active = forced || on;

  const onToggle = useCallback((photoId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(photoId)) next.add(photoId);
      return next;
    });
  }, []);

  /** Unpicks photos, e.g. the ones just deleted. */
  const drop = useCallback((photoIds: readonly string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const photoId of photoIds) next.delete(photoId);
      return next;
    });
  }, []);

  const stop = useCallback(() => {
    setOn(false);
    setSelected(new Set());
  }, []);

  useEffect(() => {
    if (!active || forced) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, forced, stop]);

  const grid: GridSelection | undefined = useMemo(
    () => (active ? { selected, onToggle } : undefined),
    [active, selected, onToggle],
  );

  return {
    active,
    selected,
    /** In the order the photos were picked. */
    ids: useMemo(() => [...selected], [selected]),
    grid,
    start: useCallback(() => setOn(true), []),
    drop,
    stop,
  };
}
