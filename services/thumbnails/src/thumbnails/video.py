"""Video pipeline (spec §10.2, 14.3): probe a video and make its poster frame, with PyAV.

PyAV binds FFmpeg's libraries (its wheels bundle them), so no ffmpeg/ffprobe executables are
packaged and the source can be any seekable file object: the video Lambda passes a file over
ranged S3 GETs (`s3_range.py`), so only the index and the frames around the poster are read.

What comes out (FR-VID-4, FR-VID-5):
- duration, the codec of the video stream and whether every browser plays it (H.264);
- the displayed size: the stored size turned by the stream's rotation (phones record portrait
  videos as landscape frames plus a display matrix);
- the recording date from the container metadata, the GPS position from the QuickTime / Android
  location tag (ISO 6709);
- a poster frame: the frame at 1 s (half the length for shorter clips), turned upright, as RGB.

Untrusted input is limited inside FFmpeg (`_open_options`: only the MP4/QuickTime demuxer, and
while probing only the decoders of `ALLOWED_CODECS`, so audio and other tracks aren't decoded),
with FFmpeg's own `max_pixels` per frame), then checked before decoding: an allowed codec and
at most `MAX_PIXELS` per frame
(a file can declare any frame size). Anything raised as PermanentVideoError can never be
processed; other exceptions (e.g. S3 errors from the file object) are transient and propagate
unchanged.
"""

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import BinaryIO

import av
from PIL import Image

# FR-VID-1: MP4 and MOV share FFmpeg's "mov,mp4,…" demuxer; nothing else is probed.
DEMUXER = "mov"

# Video codecs decoded for the poster (canonical names); others (e.g. MJPEG in a QuickTime) fail.
ALLOWED_CODECS = frozenset({"h264", "hevc", "av1", "vp9", "mpeg4", "prores"})
# FFmpeg's decoder names for them (AV1 decodes with dav1d in PyAV's FFmpeg).
DECODERS = ("h264", "hevc", "libdav1d", "vp9", "libvpx-vp9", "mpeg4", "prores")
# Decompression-bomb guard, like photos' 100 MP (imaging.py): 8K UHD is 33 MP; one RGB frame of
# 40 MP is ~120 MB. Enforced by FFmpeg's decoders themselves (`max_pixels`), also for the frames
# probing decodes before any Python check, and checked again on the declared and decoded size.
MAX_PIXELS = 40_000_000
# What every browser plays (FR-VID-5); HEVC plays in Safari only.
PLAYABLE_CODECS = frozenset({"h264"})

POSTER_AT_SECONDS = 1.0
# Frames decoded after the seek at most (from the keyframe before 1 s to 1 s); then the last one.
MAX_POSTER_FRAMES = 240
# Size of FFmpeg's read buffer = the size of each ranged GET (`s3_range.py`).
READ_BUFFER_BYTES = 1024 * 1024

# Container tags with the position, by preference: iPhone, then Android / FFmpeg.
LOCATION_TAGS = ("com.apple.quicktime.location.ISO6709", "location", "location-eng")
# Recording date: iPhone's local time with its offset, then the UTC creation time.
DATE_TAGS = ("com.apple.quicktime.creationdate", "creation_time")
# Decimal-degree ISO 6709 as phones write it: "+52.5200+013.4050+035.000/".
_ISO6709 = re.compile(r"([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)")
# Unset QuickTime dates come out as 1904-01-01 or 1970-01-01.
_EARLIEST_DATE = datetime(1971, 1, 1, tzinfo=UTC)

_ROTATIONS = {
    90: Image.Transpose.ROTATE_90,
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_270,
}


class PermanentVideoError(Exception):
    """The video cannot be processed; mark it `failed` (FR-GAL-5)."""


@dataclass(frozen=True)
class ProcessedVideo:
    width: int
    """Displayed width (after the rotation)."""
    height: int
    duration_ms: int | None
    codec: str
    """FFmpeg's name of the video codec, e.g. `h264`, `hevc`."""
    playable: bool
    taken_at: datetime | None
    gps: tuple[float, float] | None
    poster: Image.Image
    """RGB, upright, full size."""


def process_video(source: BinaryIO) -> ProcessedVideo:
    try:
        with av.open(
            source,
            mode="r",
            format=DEMUXER,
            options=_open_options(),
            buffer_size=READ_BUFFER_BYTES,
        ) as container:
            return _process(container)
    except av.FFmpegError as e:
        raise PermanentVideoError(f"{type(e).__name__}: {e}") from e


def _process(container: av.container.InputContainer) -> ProcessedVideo:
    if not container.streams.video:
        raise PermanentVideoError("no video stream")
    stream = container.streams.video[0]
    # Before anything is decoded. The canonical name, e.g. `av1` (decoder `libdav1d`).
    codec = stream.codec_context.codec.canonical_name
    if codec not in ALLOWED_CODECS:
        raise PermanentVideoError(f"unsupported video codec {codec}")
    _check_pixels(stream.codec_context.width, stream.codec_context.height)
    # The decoder opened for the poster gets the same limit (frames may change size mid-stream).
    stream.codec_context.options = {"max_pixels": str(MAX_PIXELS)}
    duration_ms = _duration_ms(container, stream)
    frame = _poster_frame(container, stream, duration_ms)

    # Frames may differ from the stream's declared size.
    _check_pixels(frame.width, frame.height)
    rotation = frame.rotation % 360
    poster = _to_rgb(frame)
    if rotation in _ROTATIONS:
        # FFmpeg's rotation is counterclockwise, like PIL's ROTATE_* (the ffmpeg CLI's autorotate).
        poster = poster.transpose(_ROTATIONS[rotation])
    metadata = {**stream.metadata, **container.metadata}
    return ProcessedVideo(
        width=poster.width,
        height=poster.height,
        duration_ms=duration_ms,
        codec=codec,
        playable=codec in PLAYABLE_CODECS,
        taken_at=_taken_at(metadata),
        gps=_gps(metadata),
        poster=poster,
    )


def _open_options() -> dict[str, str]:
    """For the container and every decoder opened while probing (avformat_find_stream_info):
    the MP4/QuickTime demuxer only, the allowed decoders only, at most MAX_PIXELS per frame."""
    return {
        "format_whitelist": "mov,mp4,m4a,3gp,3g2,mj2",
        "codec_whitelist": ",".join(DECODERS),
        "max_pixels": str(MAX_PIXELS),
    }


def _check_pixels(width: int, height: int) -> None:
    if width * height > MAX_PIXELS:
        raise PermanentVideoError(f"{width}x{height} exceeds {MAX_PIXELS} px")


def _duration_ms(container: av.container.InputContainer, stream: av.VideoStream) -> int | None:
    if container.duration is not None and container.duration > 0:
        return round(container.duration * 1000 / av.time_base)
    if stream.duration is not None and stream.time_base is not None and stream.duration > 0:
        return round(float(stream.duration * stream.time_base) * 1000)
    return None


def _poster_frame(
    container: av.container.InputContainer, stream: av.VideoStream, duration_ms: int | None
) -> av.VideoFrame:
    target = POSTER_AT_SECONDS
    if duration_ms is not None:
        target = min(target, duration_ms / 2000)
    if target > 0 and stream.time_base is not None:
        # To the keyframe at or before the target, then decode forward to it.
        container.seek(round(target / stream.time_base), stream=stream)
        frame = _decode_until(container, stream, target)
        if frame is not None:
            return frame
        container.seek(0, stream=stream)
    frame = _decode_until(container, stream, 0)
    if frame is None:
        raise PermanentVideoError("no decodable video frame")
    return frame


def _decode_until(
    container: av.container.InputContainer, stream: av.VideoStream, target: float
) -> av.VideoFrame | None:
    last = None
    for count, frame in enumerate(container.decode(stream), start=1):
        last = frame
        if frame.time is None or frame.time >= target or count >= MAX_POSTER_FRAMES:
            break
    return last


def _to_rgb(frame: av.VideoFrame) -> Image.Image:
    # The frame's own colour space and range (phones tag BT.709), so colours aren't shifted.
    # HDR (HLG / PQ, e.g. iPhone's default) is not tone-mapped: such posters look flatter.
    rgb = frame.reformat(
        format="rgb24", src_colorspace=frame.colorspace, src_color_range=frame.color_range
    )
    return rgb.to_image()


def _taken_at(metadata: dict[str, str]) -> datetime | None:
    for tag in DATE_TAGS:
        parsed = _parse_date(metadata.get(tag))
        if parsed is not None:
            return parsed
    return None


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        # Some muxers join several values with ";" (FFmpeg's own tag next to an mdta one).
        parsed = datetime.fromisoformat(value.split(";")[0].strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    parsed = parsed.astimezone(UTC)
    if parsed < _EARLIEST_DATE or parsed > datetime.now(UTC) + timedelta(days=1):
        return None  # Unset, or the camera clock clearly wrong (same rule as photos).
    return parsed


def _gps(metadata: dict[str, str]) -> tuple[float, float] | None:
    """Missing, malformed, out of range and 0/0 give None (like photos, 13.2a)."""
    for tag in LOCATION_TAGS:
        match = _ISO6709.match(metadata.get(tag, "").strip())
        if match is None:
            continue
        lat, lon = float(match.group(1)), float(match.group(2))
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
            return None
        return lat, lon
    return None
