/**
 * Starts a download from a URL served with `Content-Disposition: attachment` (FR-DL-2): the
 * browser saves the file instead of leaving the app.
 */
export function startDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}
