import { useState, useSyncExternalStore } from "react";
import { mediaCookieIssues } from "@/auth/mediaCookie";

/**
 * Whether `url` failed to load, remembered per URL: a refetch with a new (e.g. re-signed, 7.4)
 * URL gets a fresh try instead of keeping the placeholder. Also per media cookie issue: the app
 * opens without waiting for cookies that have run out (8.35b), so an own image that failed with
 * them gets another try once new ones arrive.
 */
export function useImageFailed(url: string | null): [failed: boolean, onError: () => void] {
  const issue = useSyncExternalStore(mediaCookieIssues.subscribe, mediaCookieIssues.current);
  const [failed, setFailed] = useState<{ url: string; issue: number } | null>(null);
  return [
    url !== null && failed?.url === url && failed.issue === issue,
    () => {
      if (url !== null) setFailed({ url, issue });
    },
  ];
}
