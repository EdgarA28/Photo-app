import { PHOTO_LINK_TTL_SECONDS, type Photo, type PhotoLink } from "@photo-app/shared";
import { useMutation } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Check, Copy, Link2, LoaderCircle, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
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

/**
 * "Share link" in the viewer (FR-SHR-8): makes a public link to this photo that anyone can open
 * for 15 minutes, to see it and download the original. Each press makes a new link. Own, processed
 * photos only (the caller decides); the API refuses the rest.
 */
export function ShareLinkButton({
  photo,
  className,
  setOverlay,
}: {
  photo: Photo;
  className?: string;
  /** While the dialog is open the viewer ignores its keys. */
  setOverlay: (open: boolean) => void;
}) {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const [open, setOpen] = useState(false);
  const create = useMutation({ mutationFn: () => api.photos.createLink(photo.photoId) });
  useEffect(() => setOverlay(open), [open, setOverlay]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon-lg"
        aria-label="Share link"
        title={`Link anyone can open for ${minutes} minutes`}
        disabled={create.isPending}
        onClick={() => {
          setOpen(true);
          create.mutate();
        }}
        className={className}
      >
        {create.isPending ? (
          <LoaderCircle className="size-5 motion-safe:animate-spin" />
        ) : (
          <Link2 className="size-5" />
        )}
      </Button>
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
              Anyone with this link can see the photo and download the original for {minutes}{" "}
              minutes, without an account.
            </DialogDescription>
          </DialogHeader>
          {create.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(create.error)}
            </p>
          ) : create.data ? (
            <LinkReady link={create.data} />
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

function LinkReady({ link }: { link: PhotoLink }) {
  const url = `${window.location.origin}${link.path}`;
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const canShare = typeof navigator.share === "function";

  return (
    <div className="space-y-3">
      <Input
        readOnly
        value={url}
        aria-label="Link"
        onFocus={(event) => event.currentTarget.select()}
      />
      <p className="text-sm text-muted-foreground">
        Works until {timeFormat.format(new Date(link.expiresAt))}.
      </p>
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
