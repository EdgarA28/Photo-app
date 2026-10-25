import {
  USERNAME_HOLD_DAYS,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  usernameSchema,
} from "@photo-app/shared";
import { useId, useState } from "react";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSetUsername } from "@/queries/me";

const RULE = `${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters: a–z, 0–9, "." and "_", starting and ending with a letter or digit.`;

/**
 * Set or change the username (FR-ACC-3). Checked live with the API's `usernameSchema` (which also
 * normalises: case and a leading `@` don't matter); "taken" comes from the API (409). There is no
 * way to remove a username, so once set it can only be changed.
 */
export function UsernameSection({ username }: { username: string | null }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const save = useSetUsername();

  const parsed = value.trim() ? usernameSchema.safeParse(value) : null;
  const invalid = parsed && !parsed.success ? parsed.error.issues[0]!.message : null;
  const normalised = parsed?.success ? parsed.data : null;

  function start() {
    setValue(username ?? "");
    setStatus(null);
    save.reset();
    setEditing(true);
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          {username ? (
            <p className="font-medium">@{username}</p>
          ) : (
            <p className="text-muted-foreground">
              No username yet. Others can share with you by email only.
            </p>
          )}
          {status && (
            <p role="status" className="text-sm text-muted-foreground">
              {status}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={start}>
          {username ? "Change" : "Choose a username"}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!normalised || save.isPending) return;
        save.mutate(normalised, {
          onSuccess: (result) => {
            setEditing(false);
            setStatus(`Your username is now @${result.username}.`);
          },
        });
      }}
    >
      <Label htmlFor={id}>Username</Label>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          >
            @
          </span>
          <Input
            id={id}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              save.reset();
            }}
            maxLength={USERNAME_MAX_LENGTH + 1}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            aria-invalid={invalid || save.error ? true : undefined}
            aria-describedby={`${id}-hint`}
            className="pl-6"
          />
        </div>
        <Button type="submit" disabled={!normalised || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <div id={`${id}-hint`} className="space-y-1 text-sm">
        {save.error ? (
          <p role="alert" className="text-destructive">
            {errorMessage(save.error)}
          </p>
        ) : invalid ? (
          <p role="alert" className="text-destructive">
            {invalid}
          </p>
        ) : normalised && normalised !== value.trim() ? (
          <p className="text-muted-foreground">Saved as @{normalised}</p>
        ) : (
          <p className="text-muted-foreground">{RULE}</p>
        )}
        {username && normalised && normalised !== username && (
          <p className="text-muted-foreground">
            Your old name @{username} stays reserved for you for {USERNAME_HOLD_DAYS} days.
          </p>
        )}
      </div>
    </form>
  );
}
