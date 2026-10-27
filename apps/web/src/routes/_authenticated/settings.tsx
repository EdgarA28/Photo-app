import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState, type ReactNode } from "react";
import { errorMessage } from "@/api/errors";
import { logout } from "@/auth/logout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { meQuery } from "@/queries/me";
import { QuotaBar } from "@/settings/QuotaBar";
import { UsernameSection } from "@/settings/UsernameSection";
import { isActive, useUploads } from "@/upload/useUploads";
import { APP_VERSION } from "@/version";

// Account, storage, username and logout (FR-ACC-1, FR-ACC-3, FR-AUTH-5, 8.13).
export const Route = createFileRoute("/_authenticated/settings")({
  loader: ({ context }) =>
    context.queryClient.query({ ...meQuery(context.api), staleTime: "static" }),
  component: Settings,
  errorComponent: SettingsError,
});

function Settings() {
  const { api } = Route.useRouteContext();
  const { data: me } = useSuspenseQuery(meQuery(api));

  return (
    <main className="mx-auto max-w-2xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Section title="Account">
        {me.name && <p className="font-medium">{me.name}</p>}
        <p className="text-muted-foreground">{me.email}</p>
      </Section>

      <Section title="Storage">
        <QuotaBar usage={me.usage} />
      </Section>

      <Section
        title="Username"
        description="People can share albums with you by your username instead of your email."
      >
        <UsernameSection username={me.username} />
      </Section>

      <Section
        title="Log out"
        description="Removes your session and the app's data from this device."
      >
        <LogoutButton />
      </Section>

      <p className="text-xs text-muted-foreground">Version {APP_VERSION}</p>
      {/* CC BY 4.0 attribution for the place names (13.2b). */}
      <p className="text-xs text-muted-foreground">
        Place names from{" "}
        <a href="https://www.geonames.org" className="underline underline-offset-2">
          GeoNames
        </a>
        , licensed under{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          className="underline underline-offset-2"
        >
          CC BY 4.0
        </a>
        .
      </p>
    </main>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = `settings-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="space-y-3 border-t pt-6 first-of-type:border-t-0">
      <div className="space-y-1">
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Logout (FR-AUTH-5) clears the upload queue, the Query cache and the session. Unfinished uploads
 * would be lost, so they are confirmed first; otherwise it logs out at once.
 */
function LogoutButton() {
  const { auth, queryClient, uploads, media, persistedCache, shareInbox } = Route.useRouteContext();
  const pending = useUploads().filter(isActive).length;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // auth.logout ends with a redirect; if even that fails, let the user try again.
  const run = () => {
    setBusy(true);
    setFailed(false);
    logout({ auth, queryClient, uploads, media, persistedCache, shareInbox }).catch(() => {
      setBusy(false);
      setFailed(true);
      setConfirming(false);
    });
  };

  return (
    <>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => (pending > 0 ? setConfirming(true) : run())}
      >
        <LogOut aria-hidden />
        {busy ? "Logging out…" : "Log out"}
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Logging out didn't finish. Check your connection and try again.
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel unfinished uploads?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending === 1 ? "1 upload hasn't" : `${pending} uploads haven't`} finished. Logging
              out removes {pending === 1 ? "it" : "them"} from this device.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep uploading</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                run();
              }}
            >
              Log out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// e.g. GET /me failed (no network).
function SettingsError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="text-muted-foreground">{errorMessage(error)}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        Try again
      </Button>
    </main>
  );
}
