import { PHOTO_LINK_TTL_SECONDS, type PhotoLink } from "@photo-app/shared";
import { useMutation } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Check, Copy, Link2, LoaderCircle, Share2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const minutes = PHOTO_LINK_TTL_SECONDS / 60;
const photosText = (count: number) => (count === 1 ? "1 photo" : `${count} photos`);

/**
 * Public link (FR-SHR-8) to own photos: anyone with it can see them and download the originals for
 * 15 minutes. `trigger` opens the dialog, which makes a new link each time; photos still
 * processing or in the trash are left out by the API, and the dialog says so.
 */
export function ShareLinkDialog({
  photoIds,
  trigger,
  onOpenChange,
}: {
  photoIds: string[];
  trigger: (props: { open: () => void; busy: boolean }) => ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const [open, setOpen] = useState(false);
  const create = useMutation({ mutationFn: (ids: string[]) => api.links.create(ids) });
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  return (
    <>
      {trigger({
        open: () => {
          setOpen(true);
          create.mutate(photoIds);
        },
        busy: create.isPending,
      })}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) create.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share link</DialogTitle>
            <DialogDescription>
              Anyone with this link can see{" "}
              {photoIds.length === 1 ? "the photo" : `these ${photoIds.length} photos`} and download
              the originals for {minutes} minutes, without an account.
            </DialogDescription>
          </DialogHeader>
          {create.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(create.error)}
            </p>
          ) : create.data ? (
            <LinkReady link={create.data} requested={photoIds.length} />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Creating link…
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The viewer's icon button for one photo. */
export function ShareLinkButton({
  photoId,
  className,
  setOverlay,
}: {
  photoId: string;
  className?: string;
  /** While the dialog is open the viewer ignores its keys. */
  setOverlay: (open: boolean) => void;
}) {
  return (
    <ShareLinkDialog
      photoIds={[photoId]}
      onOpenChange={setOverlay}
      trigger={({ open, busy }) => (
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label="Share link"
          title={`Link anyone can open for ${minutes} minutes`}
          disabled={busy}
          onClick={open}
          className={className}
        >
          {busy ? (
            <LoaderCircle className="size-5 motion-safe:animate-spin" />
          ) : (
            <Link2 className="size-5" />
          )}
        </Button>
      )}
    />
  );
}

function LinkReady({ link, requested }: { link: PhotoLink; requested: number }) {
  const url = `${window.location.origin}${link.path}`;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const canShare = typeof navigator.share === "function";
  const left = requested - link.photoCount;

  return (
    <div className="space-y-3">
      <Input
        readOnly
        value={url}
        aria-label="Link"
        onFocus={(event) => event.currentTarget.select()}
      />
      <p className="text-sm text-muted-foreground">
        {requested > 1 && `${photosText(link.photoCount)} · `}Works until{" "}
        {timeFormat.format(new Date(link.expiresAt))}.
      </p>
      {left > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {photosText(left)} still processing or in the trash {left === 1 ? "was" : "were"} left
          out.
        </p>
      )}
      {copyFailed && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't copy. Select the link and copy it yourself.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {canShare && (
          <Button
            variant="outline"
            // Cancelling the share sheet rejects; nothing to report.
            onClick={() => void navigator.share({ url }).catch(() => {})}
          >
            <Share2 aria-hidden />
            Share…
          </Button>
        )}
        <Button
          onClick={() =>
            void navigator.clipboard.writeText(url).then(
              () => {
                setCopyFailed(false);
                setCopied(true);
              },
              () => setCopyFailed(true),
            )
          }
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </div>
  );
}
