import type { Album, AlbumShare } from "@photo-app/shared";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { UserRound, X } from "lucide-react";
import { useId, useState } from "react";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sharesQuery, useRevokeShare, useShareAlbum } from "@/queries/shares";
import { parseShareTarget } from "./shareTarget";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** How a recipient is shown: a share made by username never carries the email (FR-SHR-5). */
const nameOf = (share: AlbumShare) =>
  share.username ? `@${share.username}` : (share.email ?? "Someone");

/**
 * Sharing an own album read-only (FR-SHR-1/2/5): one field for an email or a username, the people
 * it's shared with, and revoking. Revoking needs no confirmation: nothing is deleted and sharing
 * again restores it.
 */
export function ShareDialog({
  album,
  open,
  onOpenChange,
}: {
  album: Album;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{album.name}”</DialogTitle>
          <DialogDescription>
            People you share with get an invitation. Once they accept, they can view and download
            the photos, but not change anything.
          </DialogDescription>
        </DialogHeader>
        {/* Remounted per opening: empty field, no old messages. */}
        {open && <ShareForm album={album} />}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm({ album }: { album: Album }) {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const id = useId();
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const share = useShareAlbum(album.albumId);
  const revoke = useRevokeShare(album.albumId);
  const shares = useQuery(sharesQuery(api, album.albumId));

  const target = parseShareTarget(value);
  // Explain a malformed value only once the user tried to send it.
  const invalid = submitted && target && !target.ok ? target.reason : null;
  const error = invalid ?? (share.error ? errorMessage(share.error) : null);

  return (
    <div className="grid gap-5">
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          setStatus(null);
          if (!target?.ok || share.isPending) return;
          share.mutate(target.request, {
            onSuccess: ({ alreadyShared }) => {
              setStatus(
                alreadyShared
                  ? `Already shared with ${target.label}.`
                  : `Invited ${target.label}. They'll see the album once they accept.`,
              );
              setValue("");
              setSubmitted(false);
            },
          });
        }}
      >
        <Label htmlFor={id}>Email or username</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setSubmitted(false);
              share.reset();
            }}
            placeholder="name@example.com or @username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            aria-invalid={error ? true : undefined}
          />
          <Button type="submit" disabled={!target || share.isPending}>
            {share.isPending ? "Sharing…" : "Share"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : status ? (
          <p role="status" className="text-sm text-muted-foreground">
            {status}
          </p>
        ) : target?.ok ? (
          <p className="text-sm text-muted-foreground">Share with {target.label}</p>
        ) : null}
      </form>

      <section aria-labelledby={`${id}-list`} className="grid gap-2">
        <h3 id={`${id}-list`} className="text-sm font-medium">
          Shared with
        </h3>
        {shares.isPending && <p className="text-muted-foreground">Loading…</p>}
        {shares.isError && (
          <p role="alert" className="text-destructive">
            {errorMessage(shares.error)}
          </p>
        )}
        {shares.data?.items.length === 0 && (
          <p className="text-muted-foreground">Only you can see this album.</p>
        )}
        {shares.data && shares.data.items.length > 0 && (
          <ul className="-mx-1 max-h-60 overflow-y-auto">
            {shares.data.items.map((s) => (
              <li key={s.userId} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                <UserRound aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{nameOf(s)}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.username && s.email ? `${s.email} · ` : ""}
                    {/* FR-SHR-6: no access until they accept. */}
                    {s.status === "pending" ? "Invited" : "Shared"}{" "}
                    {dateFormat.format(new Date(s.sharedAt))}
                    {s.status === "pending" && " · not accepted yet"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    s.status === "pending"
                      ? `Withdraw the invitation to ${nameOf(s)}`
                      : `Stop sharing with ${nameOf(s)}`
                  }
                  disabled={revoke.isPending}
                  onClick={() => {
                    setStatus(null);
                    revoke.mutate(s, {
                      onSuccess: () =>
                        setStatus(
                          s.status === "pending"
                            ? `Invitation to ${nameOf(s)} withdrawn.`
                            : `${nameOf(s)} no longer has access.`,
                        ),
                    });
                  }}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {revoke.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(revoke.error)}
          </p>
        )}
      </section>
    </div>
  );
}
