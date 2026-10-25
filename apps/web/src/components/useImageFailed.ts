import { useState } from "react";

/**
 * Whether `url` failed to load, remembered per URL: a refetch with a new (e.g. re-signed, 7.4)
 * URL gets a fresh try instead of keeping the placeholder.
 */
export function useImageFailed(url: string | null): [failed: boolean, onError: () => void] {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return [url !== null && failedUrl === url, () => setFailedUrl(url)];
}
