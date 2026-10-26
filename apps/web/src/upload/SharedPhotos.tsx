import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BlobImage } from "./BlobImage";
import { canPreviewType } from "./useUploads";

/** Previews shown; the rest is counted. */
const MAX_PREVIEWS = 8;

/**
 * Photos shared to the app (9.6, FR-PWA-4), waiting for the user's go-ahead: the share target
 * can be reached by any website, so nothing shared is uploaded without this confirmation.
 */
export function SharedPhotos({
  files,
  busy,
  onUpload,
  onDiscard,
}: {
  files: File[];
  busy: boolean;
  onUpload: () => void;
  onDiscard: () => void;
}) {
  const more = files.length - MAX_PREVIEWS;
  return (
    <section
      aria-labelledby="shared-photos"
      className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <h2 id="shared-photos" className="flex items-center gap-2 font-medium">
        <Share2 aria-hidden className="size-4 text-safelight" />
        {files.length === 1
          ? "1 photo shared to this app"
          : `${files.length} photos shared to this app`}
      </h2>
      <ul className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
        {files.slice(0, MAX_PREVIEWS).map((file, i) => (
          <li
            key={i}
            className="aspect-square overflow-hidden rounded-md bg-muted"
            title={file.name}
          >
            {canPreviewType(file.type) && (
              <BlobImage file={file} className="size-full object-cover" />
            )}
          </li>
        ))}
      </ul>
      {more > 0 && <p className="text-sm text-muted-foreground">and {more} more</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
        <Button disabled={busy} onClick={onUpload}>
          Upload
        </Button>
      </div>
    </section>
  );
}
