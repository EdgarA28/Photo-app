import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/configContext";
import { startGoogleConsent } from "./googleConsent";

/**
 * Google strips the location from photos leaving Google Photos through the Picker (checked in dev
 * 2026-11-22: camera and date kept, no GPS tags), so imported photos get no place (FR-SRCH-1).
 */
export const LOCATION_HINT =
  "Google removes the location from imported photos. To keep it, upload the photos from your phone's gallery instead.";

/** "Import from Google Photos" (13.5g, FR-IMP-1): off to Google's consent for this one import. */
export function ImportStartButton({
  loginHint,
  children = "Import from Google Photos",
  variant = "outline",
}: {
  loginHint?: string;
  children?: string;
  variant?: "outline" | "default";
}) {
  const { googleImport, origin } = useConfig();
  const [busy, setBusy] = useState(false);
  if (!googleImport) return null;
  return (
    <Button
      variant={variant}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void startGoogleConsent({
          clientId: googleImport.clientId,
          origin,
          ...(loginHint && { loginHint }),
        }).catch(() => setBusy(false));
      }}
    >
      {busy ? "Opening Google…" : children}
    </Button>
  );
}

/**
 * The import offer under the upload picker (user's choice 2026-11-22: on the Upload page, not in
 * Settings). Nothing when the build has no Google client ID.
 */
export function GoogleImportOption({ loginHint }: { loginHint?: string }) {
  const { googleImport } = useConfig();
  if (!googleImport) return null;
  return (
    <section
      aria-labelledby="google-import-title"
      className="flex flex-wrap items-center gap-3 rounded-xl border p-4"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="google-import-title" className="font-semibold">
          Import from Google Photos
        </h2>
        <p className="text-sm text-muted-foreground">
          Choose photos in Google Photos and copy them here, up to 500 at a time. Videos are
          skipped.
        </p>
        <p className="text-sm text-muted-foreground">{LOCATION_HINT}</p>
      </div>
      <ImportStartButton {...(loginHint && { loginHint })}>
        Choose in Google Photos
      </ImportStartButton>
    </section>
  );
}
