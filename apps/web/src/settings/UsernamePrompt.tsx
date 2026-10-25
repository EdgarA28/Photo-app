import { useQuery } from "@tanstack/react-query";
import { useMatch, useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { meQuery } from "@/queries/me";
import { UsernameForm } from "./UsernameForm";
import { isPromptSkipped, skipPrompt } from "./usernamePromptStore";

/**
 * "Choose a username" once after login (FR-ACC-3, 8.15): while `GET /me` has no username and the
 * user hasn't said "Later" on this device. Any way of closing it counts as Later. Never on
 * /settings (which has the field), and the viewer has no shell, so not there either. If `GET /me`
 * fails there is simply no prompt.
 */
export function UsernamePrompt({ userId }: { userId: string }) {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const { data: me } = useQuery(meQuery(api));
  const onSettings = !!useMatch({ from: "/_authenticated/settings", shouldThrow: false });
  const [skipped, setSkipped] = useState(() => isPromptSkipped(userId));
  // Set after saving: the dialog stays open to confirm, then closes for good.
  const [saved, setSaved] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  const open = !closed && (saved !== null || (me?.username === null && !skipped && !onSettings));

  function close() {
    if (saved === null) {
      skipPrompt(userId);
      setSkipped(true);
    }
    setClosed(true);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{saved ? `You're @${saved}` : "Choose a username"}</DialogTitle>
          <DialogDescription>
            {saved
              ? "Friends can now share albums with you by this name."
              : "Friends can share albums with you by @username instead of your email. You can change it any time in Settings."}
          </DialogDescription>
        </DialogHeader>
        {saved ? (
          <Button className="justify-self-end" onClick={close}>
            Done
          </Button>
        ) : (
          <UsernameForm
            current={null}
            onSaved={setSaved}
            secondary={
              <Button type="button" variant="ghost" onClick={close}>
                Later
              </Button>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
