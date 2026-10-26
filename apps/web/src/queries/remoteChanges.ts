import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { Api } from "@/api/api";
import { meQuery } from "./me";

/** How often a page on screen checks for changes made on another device. */
export const REMOTE_CHANGES_POLL_MS = 30_000;

/**
 * Notices photos uploaded or deleted on another device while this page stays in front, where
 * returning to the app (`refetchOnWindowFocus`) never fires. Polls the small `GET /me` (paused
 * while the page is hidden) and refreshes the photo lists and albums only when the usage
 * (count, bytes) changed. Changes that leave usage alone, e.g. album edits, wait for the next
 * focus or `staleTime`.
 */
export function useRemoteChanges(api: Api) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ ...meQuery(api), refetchInterval: REMOTE_CHANGES_POLL_MS });
  const usage = data && JSON.stringify(data.usage);
  // Runs only when the usage value changes (identical refetches keep the same data); the first
  // value is just the baseline.
  const seen = useRef(false);
  useEffect(() => {
    if (!usage) return;
    if (seen.current) {
      void queryClient.invalidateQueries({ queryKey: ["photos"] });
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
    }
    seen.current = true;
  }, [usage, queryClient]);
}
