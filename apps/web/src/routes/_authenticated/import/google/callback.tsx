import { createFileRoute, Link, redirect, type ErrorComponentProps } from "@tanstack/react-router";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { importRedirectUri, takeGoogleConsent } from "@/import/googleConsent";
import { ImportStartButton } from "@/import/ImportStart";
import { savePickerUri } from "@/import/pickerStore";

/**
 * Back from Google's consent (13.5g; FR-IMP-1, §11.5): checks `state`, hands the code and PKCE
 * verifier to the API (which keeps Google's token), then continues on the import's page. Runs once:
 * the stored consent is deleted when read, so a reload or a replayed URL ends on the error page.
 */
export const Route = createFileRoute("/_authenticated/import/google/callback")({
  loader: async ({ context, location }) => {
    const consent = takeGoogleConsent(new URLSearchParams(location.searchStr));
    if (consent.kind === "cancelled") throw new ConsentError("cancelled");
    if (consent.kind === "invalid") throw new ConsentError("invalid", consent.reason);
    const started = await context.api.imports.startGoogle({
      code: consent.code,
      codeVerifier: consent.codeVerifier,
      redirectUri: importRedirectUri(window.location.origin),
    });
    savePickerUri(started.importId, started.pickerUri);
    throw redirect({
      to: "/import/$importId",
      params: { importId: started.importId },
      replace: true,
    });
  },
  pendingComponent: () => <main className="p-4">Connecting to Google Photos…</main>,
  errorComponent: CallbackError,
});

class ConsentError extends Error {
  constructor(
    readonly kind: "cancelled" | "invalid",
    reason = "",
  ) {
    super(reason);
    this.name = "ConsentError";
  }
}

function CallbackError({ error }: ErrorComponentProps) {
  const cancelled = error instanceof ConsentError && error.kind === "cancelled";
  return (
    <main className="mx-auto max-w-md space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">
        {cancelled ? "Import cancelled" : "The import didn't start"}
      </h1>
      <p className="text-muted-foreground">
        {cancelled
          ? "You didn't allow access to Google Photos, so nothing was imported."
          : error instanceof ConsentError
            ? `${error.message}. Start the import again.`
            : errorMessage(error)}
      </p>
      <div className="flex flex-wrap gap-2">
        <ImportStartButton variant="default">Try again</ImportStartButton>
        <Button variant="outline" asChild>
          <Link to="/settings">Back to settings</Link>
        </Button>
      </div>
    </main>
  );
}
