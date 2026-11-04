// Can this browser play a video (FR-VID-5, 14.6)? Used by VideoPlayer.

/**
 * MIME type with a codec for `canPlayType` (FR-VID-5), from the codec name ffprobe gives
 * (`videoCodec`). The container doesn't decide it: Chrome answers "" for `video/quicktime` yet plays
 * an H.264 MOV, and an HEVC MP4 plays only where HEVC decodes (Safari, some Chrome/Edge with
 * hardware support). Unknown codecs give null: the browser just tries.
 */
export function codecProbe(videoCodec: string | null): string | null {
  switch (videoCodec) {
    case "h264":
      return 'video/mp4; codecs="avc1.640028"';
    case "hevc":
      return 'video/mp4; codecs="hvc1.1.6.L93.B0"';
    case "vp9":
      return 'video/mp4; codecs="vp09.00.10.08"';
    case "av1":
      return 'video/mp4; codecs="av01.0.05M.08"';
    default:
      return null;
  }
}

/** Whether this browser can't decode the codec at all (then the player isn't even tried). */
export function cannotPlay(videoCodec: string | null): boolean {
  const probe = codecProbe(videoCodec);
  if (!probe || typeof document === "undefined") return false;
  return document.createElement("video").canPlayType(probe) === "";
}
