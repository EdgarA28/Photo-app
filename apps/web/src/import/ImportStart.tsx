import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/configContext";
import { startGoogleConsent } from "./googleConsent";

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
