import { Download, LoaderCircle, VideoOff } from "lucide-react";
import { useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { cannotPlay } from "./playback";

/** Height of the native controls bar: a drag there seeks, so it doesn't count as a swipe. */
const CONTROLS_PX = 64;

/**
 * The browser's own player for a video (FR-VID-5, 14.6): its playback copy (14.9) or, without one,
 * the original. Play/pause, seek, full screen and sound; the poster frame shows until it plays.
 * Only metadata is fetched up front (range requests from there on). When the codec can't play
 * here (e.g. an HEVC original outside Safari) or the video fails to load, it says so and offers
 * the download instead; `preparing` (copy still being made) says it will play soon.
 */
export function VideoPlayer({
  src,
  poster,
  videoCodec,
  label,
  onDownload,
  downloading = false,
  downloadError = null,
  preparing = false,
}: {
  src: string;
  poster: string | null;
  videoCodec: string | null;
  label: string;
  onDownload: () => void;
  downloading?: boolean;
  downloadError?: string | null;
  preparing?: boolean;
}) {
  const [failed, setFailed] = useState(() => cannotPlay(videoCodec));

  if (failed) {
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-3 px-6 text-center text-white/70"
      >
        <VideoOff aria-hidden className="size-8" />
        <p className="text-sm">
          {preparing
            ? "This video is being prepared for playback. Try again in a few minutes."
            : "This video can't play in this browser."}
        </p>
        <Button variant="secondary" disabled={downloading} onClick={onDownload}>
          {downloading ? (
            <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
          ) : (
            <Download aria-hidden />
          )}
          Download to watch it
        </Button>
        {downloadError && (
          <p role="alert" className="text-sm text-red-300">
            {downloadError}
          </p>
        )}
      </div>
    );
  }

  // A press on the controls bar (seek) mustn't reach the viewer's swipe.
  const keepFromSwipe = (event: PointerEvent<HTMLVideoElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientY > box.bottom - CONTROLS_PX) event.stopPropagation();
  };

  return (
    <video
      src={src}
      poster={poster ?? undefined}
      aria-label={label}
      controls
      playsInline
      preload="metadata"
      // The original is one tap away (download button); no "Download" in Chrome's menu, which
      // would save the playback copy from an expiring signed URL.
      controlsList="nodownload"
      onError={() => setFailed(true)}
      onPointerDown={keepFromSwipe}
      className="max-h-full max-w-full bg-black"
    />
  );
}
