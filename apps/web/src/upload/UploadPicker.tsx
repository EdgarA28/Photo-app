import { MAX_UPLOAD_BYTES } from "@photo-app/shared";
import { Camera, ImagePlus } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ACCEPT } from "./validate";

/**
 * The ways to pick photos (FR-UP-1): drop zone, file picker (many at once) and, on phones, the
 * camera. Hands the files over and resets the inputs, so picking the same file again works.
 */
export function UploadPicker({ onFiles }: { onFiles: (files: File[]) => void }) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function take(input: HTMLInputElement) {
    if (input.files?.length) onFiles([...input.files]);
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
        if (event.dataTransfer.files.length) onFiles([...event.dataTransfer.files]);
      }}
      data-dragging={dragging || undefined}
      className={cn(
        "flex flex-col items-center gap-4 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <ImagePlus aria-hidden className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-medium">
          <span className="hidden md:inline">Drag photos here, or choose them</span>
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
