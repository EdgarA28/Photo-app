import { MapPinOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/configContext";
import { GooglePhotosIcon } from "./GooglePhotosIcon";
import { startGoogleConsent } from "./googleConsent";

/**
 * Google strips the location from photos leaving Google Photos through the Picker (checked in dev
 * 2026-11-22: camera and date kept, no GPS tags), so imported photos get no place (FR-SRCH-1).
 */
export const LOCATION_HINT =
  "Google removes photo locations; upload from your phone's gallery to keep them.";

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

const IMPORT_DETAILS = "Up to 500 photos at a time. Videos are skipped.";

/**
 * The import offer under the upload picker (user's choice 2026-11-22: on the Upload page, not in
 * Settings). On a computer the details sit in the box; on a phone (user 2026-11-22) the box keeps
 * only the title and the button, and the details go under it like the upload page's other hints.
 * Nothing when the build has no Google client ID.
 */
export function GoogleImportOption({ loginHint }: { loginHint?: string }) {
  const { googleImport } = useConfig();
  if (!googleImport) return null;
  return (
    <div className="space-y-2">
      <section
        aria-labelledby="google-import-title"
        aria-describedby="google-import-details"
        className="flex flex-wrap items-center gap-3 rounded-xl border p-4"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id="google-import-title" className="flex items-center gap-2 font-semibold">
            <GooglePhotosIcon className="size-5 shrink-0" />
            Import from Google Photos
          </h2>
          <ImportDetails className="hidden md:block" />
        </div>
        <ImportStartButton {...(loginHint && { loginHint })}>
          Choose in Google Photos
        </ImportStartButton>
      </section>
      <p
        id="google-import-details"
        className="flex items-start gap-2 text-sm text-muted-foreground md:sr-only"
      >
        <MapPinOff aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          {IMPORT_DETAILS} {LOCATION_HINT}
        </span>
      </p>
    </div>
  );
}

function ImportDetails({ className }: { className?: string }) {
  return (
    <p aria-hidden className={`text-sm text-muted-foreground ${className ?? ""}`}>
      {IMPORT_DETAILS}
      <br />
      {LOCATION_HINT}
    </p>
  );
}
