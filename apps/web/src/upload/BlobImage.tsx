import { useCallback } from "react";

/** Shows a local file (a queued upload) through an object URL, revoked when the image goes away. */
export function BlobImage({ file, className }: { file: Blob; className?: string }) {
  const ref = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return;
      const url = URL.createObjectURL(file);
      img.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file],
  );
  return <img ref={ref} alt="" draggable={false} className={className} />;
}
