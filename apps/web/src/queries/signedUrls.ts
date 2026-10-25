/**
 * Images of albums shared with me come as signed URLs that expire after 15 min (7.4, §9). Lists
 * holding any refetch every 10 min while shown, so tiles that scroll back into view (the grid is
 * virtualized) never get an expired URL. Own image paths are stable (no query string).
 */
export const SIGNED_URL_REFRESH_MS = 10 * 60 * 1000;

const isSigned = (url: string | null) => url?.includes("?") ?? false;

export function signedUrlRefreshInterval(urls: Iterable<string | null>): number | false {
  for (const url of urls) if (isSigned(url)) return SIGNED_URL_REFRESH_MS;
  return false;
}
