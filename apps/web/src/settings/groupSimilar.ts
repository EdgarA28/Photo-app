import { useSyncExternalStore } from "react";

/**
 * Settings' "Group similar photos" switch (8.37e, FR-GAL-10): stacks in the Gallery, on by
 * default, per device (localStorage, like the grid's tile size).
 */
const STORAGE_KEY = "photo-app.groupSimilar";

const listeners = new Set<() => void>();

// Private mode or blocked storage: on, and a change applies until the page reloads.
let fallback = true;

export function isGroupingSimilar(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? fallback : stored !== "off";
  } catch {
    return fallback;
  }
}

export function setGroupingSimilar(on: boolean) {
  fallback = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not remembered; it still applies in this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useGroupSimilar(): boolean {
  return useSyncExternalStore(subscribe, isGroupingSimilar, () => true);
}
