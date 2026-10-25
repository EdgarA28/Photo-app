import { useState } from "react";
import { Button } from "@/components/ui/button";
import { UsernameForm } from "./UsernameForm";

/**
 * Set or change the username in Settings (FR-ACC-3). There is no way to remove a username, so once
 * set it can only be changed.
 */
export function UsernameSection({ username }: { username: string | null }) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (editing) {
    return (
      <UsernameForm
        current={username}
        onSaved={(saved) => {
          setEditing(false);
          setStatus(`Your username is now @${saved}.`);
        }}
        secondary={
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        }
      />
    );
  }

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
      <Button
        variant="outline"
        onClick={() => {
          setStatus(null);
          setEditing(true);
        }}
      >
        {username ? "Change" : "Choose a username"}
      </Button>
    </div>
  );
}
