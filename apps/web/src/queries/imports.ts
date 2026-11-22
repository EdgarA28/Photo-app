import { isFinalImportStatus, type Import } from "@photo-app/shared";
import { queryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Api } from "@/api/api";

/** How often an import's progress is read before the picker was opened. */
export const IMPORT_POLL_MS = 3000;
/**
 * Once the user went to Google Photos: faster, so Done shows up quickly (the API still asks
 * Google at most once per Google's poll interval).
 */
export const IMPORT_ACTIVE_POLL_MS = 1500;

/** One import's progress (FR-IMP-5), polled until it ends. */
export const importQuery = (api: Api, importId: string, { active = false } = {}) =>
  queryOptions({
    queryKey: ["imports", importId],
    queryFn: ({ signal }) => api.imports.get(importId, { signal }),
    refetchInterval: (query) => {
      const data: Import | undefined = query.state.data;
      if (data && isFinalImportStatus(data.status)) return false;
      return active ? IMPORT_ACTIVE_POLL_MS : IMPORT_POLL_MS;
    },
    // Keeps polling while the user picks in the other window or app.
    refetchIntervalInBackground: true,
  });

/**
 * True once the user is back on this page after opening the picker: the window got the focus
 * again or the page became visible (back from the Google Photos app on Android). A page loaded
 * after the picker was opened counts as returned (the app was reloaded on the way back).
 */
export function useReturnedFromPicker(opened: boolean): boolean {
  // A tap on this page that opens it later waits for the way back (the effect below).
  const [returned, setReturned] = useState(opened);
  useEffect(() => {
    if (!opened || returned) return;
    const back = () => {
      if (document.visibilityState === "visible") setReturned(true);
    };
    // The tap's own focus change comes first; listen only after it.
    const start = window.setTimeout(() => {
      window.addEventListener("focus", back);
      document.addEventListener("visibilitychange", back);
    }, 500);
    return () => {
      window.clearTimeout(start);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [opened, returned]);
  return returned;
}
