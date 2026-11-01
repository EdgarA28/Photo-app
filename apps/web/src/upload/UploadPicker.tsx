import { MAX_UPLOAD_BYTES } from "@photo-app/shared";
import { Camera, FolderUp, ImagePlus, LoaderCircle } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { folderLabel } from "./batches";
import { filesFromDrop, filesFromFolderInput } from "./folders";
import type { AddOptions } from "./queue";
import { ACCEPT } from "./validate";

/**
 * The ways to pick photos (FR-UP-1): drop zone (files or folders), file picker (many at once),
 * on computers a folder picker (13.1a), and on phones the camera. Hands the files over and resets
 * the inputs, so picking the same file again works. A folder, with its subfolders, is passed on as
 * a large batch (13.1c).
 */
export function UploadPicker({
  onFiles,
}: {
  onFiles: (files: File[], options?: AddOptions) => void;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  /** Walking a dropped folder can take a moment with thousands of files. */
  const [reading, setReading] = useState(false);

  function take(input: HTMLInputElement) {
    if (input.files?.length) onFiles([...input.files]);
    input.value = "";
  }

  function takeFolder(input: HTMLInputElement) {
    if (input.files?.length) {
      onFiles(filesFromFolderInput(input.files), {
        folder: true,
        label: folderLabel([...input.files]),
      });
    }
    input.value = "";
  }

  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  return (
    <div
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Only when leaving the zone, not when moving over its children.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        // Entries are taken now, during the event; the folder walk continues afterwards.
        const dropped = filesFromDrop(event.dataTransfer);
        setReading(true);
        dropped
          .then(({ files, folder, label }) => {
            if (files.length) onFiles(files, folder ? { folder, label: label ?? null } : undefined);
          })
          .catch((error: unknown) => console.warn("Reading the dropped folder failed", error))
          .finally(() => setReading(false));
      }}
      data-dragging={dragging || undefined}
      className={cn(
        "flex flex-col items-center gap-4 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      {reading ? (
        <LoaderCircle
          aria-hidden
          className="size-8 text-muted-foreground motion-safe:animate-spin"
        />
      ) : (
        <ImagePlus aria-hidden className="size-8 text-muted-foreground" />
      )}
      {reading && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading the folder…
        </p>
      )}
      <div className="space-y-1">
        <p className="font-medium">
          <span className="hidden md:inline">Drag photos or a folder here, or choose them</span>
          <span className="md:hidden">Add photos</span>
        </p>
        <p className="text-sm text-muted-foreground">
          JPEG, PNG, WebP or HEIC · up to {formatBytes(MAX_UPLOAD_BYTES)} each
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => pickerRef.current?.click()}>
          <ImagePlus aria-hidden />
          Choose photos
        </Button>
        {/* Folders on computers only: phones have no folder picker, and copy every pick (13.1c). */}
        <Button
          variant="outline"
          className="hidden md:inline-flex"
          onClick={() => folderRef.current?.click()}
        >
          <FolderUp aria-hidden />
          Choose folder
        </Button>
        {/* `capture` opens the camera on phones; desktops would show a second file picker. */}
        <Button variant="outline" className="md:hidden" onClick={() => cameraRef.current?.click()}>
          <Camera aria-hidden />
          Take photo
        </Button>
      </div>
      <input
        ref={pickerRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        data-testid="upload-picker"
        onChange={(event) => take(event.currentTarget)}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        // Not in React's types; every current desktop browser supports it.
        {...{ webkitdirectory: "" }}
        data-testid="upload-folder"
        onChange={(event) => takeFolder(event.currentTarget)}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="upload-camera"
        onChange={(event) => take(event.currentTarget)}
      />
    </div>
  );
}
