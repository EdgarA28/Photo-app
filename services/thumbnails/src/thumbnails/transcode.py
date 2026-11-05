"""Playback copy of a video (spec §10.2, B-7 V2, task 14.9), with PyAV.

The original stays as uploaded (download, "save to my gallery"); the app plays this copy, which
every browser decodes and which starts at once (FR-VID-5):

- H.264 (libx264, High profile, 8-bit 4:2:0) + AAC stereo in MP4, the index (`moov`) at the start
  (`+faststart`), so the player needs no read at the end of the file;
- at most 720p (`MAX_LONG_SIDE` x `MAX_SHORT_SIDE`, portrait too), never upscaled;
- turned upright (the phone's display matrix is applied to the pixels, so no player has to
  honour one), at most `MAX_FPS` frames per second;
- quality-based (CRF) with a bitrate cap: about 2.5 Mbit/s, ~19 MB per minute.

The source is any seekable file object (the Lambda passes `S3RangeFile`, read front to back),
the output a local path (faststart rewrites the finished file). Untrusted input gets the same
limits as the poster (`video.py`: MP4/QuickTime demuxer, allowed decoders, `MAX_PIXELS`).

Not handled (copy still made): HDR (HLG / PQ) is converted to 8-bit without tone mapping, so it
looks flatter than on the phone; audio in a codec outside `ALLOWED_AUDIO_CODECS` is left out.

Errors: `PermanentVideoError` for anything FFmpeg can't read or encode, `OutOfTime` when the
deadline would be missed; both mean "no copy" (the original keeps playing). Exceptions from the
file object (S3) propagate unchanged: transient.
"""

import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from fractions import Fraction
from typing import BinaryIO

import av
import av.filter

from .video import (
    ALLOWED_CODECS,
    DECODERS,
    DEMUXER,
    MAX_PIXELS,
    PermanentVideoError,
    _check_pixels,
)

logger = logging.getLogger(__name__)

# 720p: 1280x720 landscape, 720x1280 portrait.
MAX_LONG_SIDE = 1280
MAX_SHORT_SIDE = 720
# 60 fps phone videos are halved: twice the frames cost twice the encoding for little gain here.
MAX_FPS = 30
# libx264: CRF 23 (its default quality) capped at 3 Mbit/s; `veryfast` keeps encoding well ahead
# of real time on Lambda's cores at a few % more bytes than `medium`.
VIDEO_OPTIONS = {
    "preset": "veryfast",
    "crf": "23",
    "maxrate": "3000k",
    "bufsize": "6000k",
    "profile": "high",
    # Every browser and phone decodes High@4.0 (1080p30); 720p30 is well inside it.
    "level": "4.0",
}
# A keyframe at least every 2 s, so seeking lands close to where the user tapped.
KEYFRAME_SECONDS = 2
AUDIO_BIT_RATE = 128_000
AUDIO_RATE = 48_000

# Audio decoders allowed for the copy (canonical names: what phones and cameras record).
ALLOWED_AUDIO_CODECS = frozenset(
    {"aac", "alac", "mp3", "opus", "ac3", "eac3", "pcm_s16le", "pcm_s16be", "pcm_s24le"}
)
AUDIO_DECODERS = (
    "aac",
    "aac_fixed",
    "alac",
    "mp3float",
    "mp3",
    "opus",
    "libopus",
    "ac3",
    "eac3",
    "pcm_s16le",
    "pcm_s16be",
    "pcm_s24le",
)
# Reads of the source per transcode = buffer size (`S3RangeFile`: one ranged GET each).
READ_BUFFER_BYTES = 8 * 1024 * 1024
# Decoded audio held back until the first video frame, by bytes (a crafted file can make single
# frames huge: many channels, big PCM packets): 40 s of 48 kHz stereo float is ~15 MB.
MAX_EARLY_AUDIO_BYTES = 32 * 1024 * 1024
# ...and by count (each held frame has its own overhead; tiny frames would slip under the byte
# cap): 4000 AAC frames of 1024 samples are ~85 s at 48 kHz.
MAX_EARLY_AUDIO_FRAMES = 4000
# How often (frames) the deadline is checked.
DEADLINE_CHECK_FRAMES = 30

# FFmpeg's rotation (counterclockwise, as `frame.rotation`) → filters that turn the frame upright.
_ROTATION_FILTERS = {
    90: [("transpose", "cclock")],
    180: [("hflip", None), ("vflip", None)],
    270: [("transpose", "clock")],
}


class OutOfTime(Exception):
    """The copy can't be finished before the deadline (too long for the Lambda)."""


@dataclass(frozen=True)
class PlaybackCopy:
    width: int
    height: int
    frames: int
    has_audio: bool


def target_size(width: int, height: int) -> tuple[int, int]:
    """Upright size scaled down to fit 720p (never up), both sides even (4:2:0)."""
    long_side, short_side = max(width, height), min(width, height)
    scale = min(1.0, MAX_LONG_SIDE / long_side, MAX_SHORT_SIDE / short_side)
    return _even(width * scale), _even(height * scale)


def _even(value: float) -> int:
    # Down to even (never over the limit); the epsilon absorbs float error (1279.9999…).
    return max(2, int(value + 1e-6) // 2 * 2)


def transcode(
    source: BinaryIO,
    out_path: str,
    time_left_ms: Callable[[], int] | None = None,
    min_time_left_ms: int = 0,
) -> PlaybackCopy:
    """Writes the playback copy of `source` to `out_path`. Raises `OutOfTime` once
    `time_left_ms()` drops under `min_time_left_ms` (checked while encoding)."""
    try:
        with av.open(
            source,
            mode="r",
            format=DEMUXER,
            options=_open_options(),
            buffer_size=READ_BUFFER_BYTES,
        ) as container:
            return _transcode(container, out_path, time_left_ms, min_time_left_ms)
    except av.FFmpegError as e:
        raise PermanentVideoError(f"{type(e).__name__}: {e}") from e


def _open_options() -> dict[str, str]:
    return {
        "format_whitelist": "mov,mp4,m4a,3gp,3g2,mj2",
        "codec_whitelist": ",".join(DECODERS + AUDIO_DECODERS),
        "max_pixels": str(MAX_PIXELS),
    }


def _transcode(
    container: av.container.InputContainer,
    out_path: str,
    time_left_ms: Callable[[], int] | None,
    min_time_left_ms: int,
) -> PlaybackCopy:
    if not container.streams.video:
        raise PermanentVideoError("no video stream")
    in_video = container.streams.video[0]
    codec = in_video.codec_context.codec.canonical_name
    if codec not in ALLOWED_CODECS:
        raise PermanentVideoError(f"unsupported video codec {codec}")
    _check_pixels(in_video.codec_context.width, in_video.codec_context.height)
    in_video.codec_context.options = {"max_pixels": str(MAX_PIXELS)}
    in_video.thread_type = "AUTO"

    in_audio = _audio_stream(container)
    streams = [in_video] + ([in_audio] if in_audio is not None else [])

    with av.open(out_path, mode="w", format="mp4", options={"movflags": "+faststart"}) as out:
        video = _VideoPipeline(in_video, out)
        audio = _AudioPipeline(in_audio, out) if in_audio is not None else None
        # The video stream is added to the output with the first video frame (its size and
        # rotation decide the output size). Audio that comes first waits: the muxer writes the
        # header with the first packet, and a stream added after that crashes FFmpeg (SIGFPE,
        # an iPhone HEVC video on dev 2026-11-05).
        early_audio: list[av.AudioFrame] = []
        early_bytes = 0
        audio_frames = 0
        for packet in container.demux(streams):
            if packet.stream is in_video:
                for frame in _decode(packet):
                    video.add(frame)
                    if early_audio and audio is not None:
                        for waiting in early_audio:
                            audio.add(waiting)
                        early_audio.clear()
                    if video.frames % DEADLINE_CHECK_FRAMES == 0:
                        _check_deadline(time_left_ms, min_time_left_ms)
            elif audio is not None:
                for frame in _decode(packet):
                    audio_frames += 1
                    if audio_frames % DEADLINE_CHECK_FRAMES == 0:
                        _check_deadline(time_left_ms, min_time_left_ms)
                    if video.started:
                        audio.add(frame)
                        continue
                    early_bytes += sum(plane.buffer_size for plane in frame.planes)
                    if (
                        early_bytes > MAX_EARLY_AUDIO_BYTES
                        or len(early_audio) >= MAX_EARLY_AUDIO_FRAMES
                    ):
                        raise PermanentVideoError("no video frame near the start")
                    early_audio.append(frame)
        if not video.started:
            raise PermanentVideoError("no decodable video frame")
        video.flush()
        if audio is not None:
            audio.flush()
        if video.frames == 0:
            raise PermanentVideoError("no decodable video frame")
        return PlaybackCopy(
            width=video.width,
            height=video.height,
            frames=video.frames,
            has_audio=audio is not None and audio.samples > 0,
        )


def _audio_stream(container: av.container.InputContainer) -> av.AudioStream | None:
    if not container.streams.audio:
        return None
    stream = container.streams.audio[0]
    name = stream.codec_context.codec.canonical_name
    if name not in ALLOWED_AUDIO_CODECS:
        logger.warning("Audio left out of the playback copy", extra={"audioCodec": name})
        return None
    return stream


def _decode(packet: av.Packet) -> Iterator[av.AudioFrame | av.VideoFrame]:
    """Decodes one packet (a flush packet at the end of the stream yields the buffered frames)."""
    yield from packet.decode()


def _check_deadline(time_left_ms: Callable[[], int] | None, min_time_left_ms: int) -> None:
    if time_left_ms is not None and time_left_ms() < min_time_left_ms:
        raise OutOfTime("the playback copy would not finish in time")


class _VideoPipeline:
    """Decoded frames → upright, scaled, ≤ MAX_FPS → libx264. The filter graph is built from the
    first frame (its size and rotation are what counts, not the stream's declared ones)."""

    def __init__(self, in_stream: av.VideoStream, out: av.container.OutputContainer) -> None:
        self._in = in_stream
        self._out = out
        self._graph: av.filter.Graph | None = None
        self._stream: av.VideoStream | None = None
        self.frames = 0
        self.width = 0
        self.height = 0

    @property
    def started(self) -> bool:
        """Whether the output has its video stream (set up from the first frame)."""
        return self._graph is not None

    def add(self, frame: av.VideoFrame) -> None:
        if self._graph is None:
            self._setup(frame)
        assert self._graph is not None
        _check_pixels(frame.width, frame.height)
        self._graph.vpush(frame)
        self._drain()

    def flush(self) -> None:
        if self._graph is None:
            return
        self._graph.vpush(None)
        self._drain()
        assert self._stream is not None
        for packet in self._stream.encode(None):
            self._out.mux(packet)

    def _drain(self) -> None:
        assert self._graph is not None and self._stream is not None
        while True:
            try:
                frame = self._graph.vpull()
            except (av.BlockingIOError, av.EOFError):
                return
            frame.pict_type = av.video.frame.PictureType.NONE
            for packet in self._stream.encode(frame):
                self._out.mux(packet)
            self.frames += 1

    def _setup(self, first: av.VideoFrame) -> None:
        rotation = first.rotation % 360
        rotation = rotation if rotation in _ROTATION_FILTERS else 0
        upright = (
            (first.height, first.width) if rotation in (90, 270) else (first.width, first.height)
        )
        self.width, self.height = target_size(*upright)

        rate = self._in.average_rate or self._in.guessed_rate
        if rate is not None:
            # Phones report averages like 55620000/1913201 (≈ 29.07 fps): only the encoder's
            # nominal rate, so a simple fraction; timestamps keep the source's time base.
            rate = Fraction(rate).limit_denominator(1001)
        capped = rate is not None and rate > MAX_FPS + 1
        time_base = Fraction(1, MAX_FPS) if capped else self._in.time_base
        if time_base is None:
            raise PermanentVideoError("video stream without a time base")

        graph = av.filter.Graph()
        nodes = [graph.add_buffer(template=self._in)]
        for name, args in _ROTATION_FILTERS.get(rotation, []):
            nodes.append(graph.add(name, args))
        # Lanczos for the downscale; `flags` on scale (in_range from the frame keeps colours).
        nodes.append(graph.add("scale", f"{self.width}:{self.height}:flags=lanczos"))
        if capped:
            nodes.append(graph.add("fps", str(MAX_FPS)))
        nodes.append(graph.add("format", "yuv420p"))
        nodes.append(graph.add("buffersink"))
        graph.link_nodes(*nodes).configure()
        self._graph = graph

        stream = self._out.add_stream("libx264", rate=MAX_FPS if capped else rate)
        stream.width = self.width
        stream.height = self.height
        stream.pix_fmt = "yuv420p"
        stream.time_base = time_base
        stream.codec_context.time_base = time_base
        fps = float(MAX_FPS if capped else (rate or MAX_FPS))
        stream.codec_context.gop_size = max(1, round(fps * KEYFRAME_SECONDS))
        stream.codec_context.options = dict(VIDEO_OPTIONS)
        # Phones tag BT.709; the copy says so too, so players don't guess (SD defaults to 601).
        stream.codec_context.color_primaries = 1
        stream.codec_context.color_trc = 1
        stream.codec_context.colorspace = 1
        self._stream = stream


class _AudioPipeline:
    """Decoded audio → 48 kHz stereo float planar in 1024-sample frames → AAC."""

    def __init__(self, in_stream: av.AudioStream, out: av.container.OutputContainer) -> None:
        self._stream = out.add_stream("aac", rate=AUDIO_RATE, layout="stereo")
        self._stream.bit_rate = AUDIO_BIT_RATE
        self._stream.time_base = Fraction(1, AUDIO_RATE)
        self._resampler = av.AudioResampler(
            format="fltp", layout="stereo", rate=AUDIO_RATE, frame_size=1024
        )
        self._out = out
        self._next_pts: int | None = None
        self.samples = 0

    def add(self, frame: av.AudioFrame) -> None:
        self._encode(self._resampler.resample(frame))

    def flush(self) -> None:
        self._encode(self._resampler.resample(None))
        for packet in self._stream.encode(None):
            self._out.mux(packet)

    def _encode(self, frames: list[av.AudioFrame]) -> None:
        for frame in frames:
            # Continuous timestamps in samples from the first frame's (keeps a delayed audio start
            # in sync); the source's may jump or be missing later.
            if self._next_pts is None:
                self._next_pts = frame.pts if frame.pts is not None and frame.pts > 0 else 0
            frame.pts = self._next_pts
            frame.time_base = Fraction(1, AUDIO_RATE)
            self._next_pts += frame.samples
            self.samples += frame.samples
            for packet in self._stream.encode(frame):
                self._out.mux(packet)
