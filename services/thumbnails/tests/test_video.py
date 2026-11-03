"""Video pipeline (14.3, spec §10.2): probing and poster frames on clips made with PyAV."""

import io
from datetime import UTC, datetime

import pytest
from conftest import BLUE, RED, make_video
from PIL import Image

from thumbnails import video as video_module
from thumbnails.video import PermanentVideoError, process_video


def near(pixel: tuple[int, ...], color: tuple[int, int, int]) -> bool:
    return all(abs(a - b) <= 40 for a, b in zip(pixel, color, strict=False))


def test_h264_mp4(mp4_h264: bytes) -> None:
    v = process_video(io.BytesIO(mp4_h264))
    assert (v.width, v.height) == (320, 240)
    assert v.duration_ms == 2000
    assert (v.codec, v.playable) == ("h264", True)
    assert v.taken_at == datetime(2023, 12, 24, 18, 0, tzinfo=UTC)
    assert v.gps == (52.52, 13.405)
    assert v.poster.mode == "RGB"
    assert v.poster.size == (320, 240)


def test_poster_is_the_frame_at_one_second(mp4_h264: bytes) -> None:
    # Black before 1 s, red | blue from 1 s (conftest.make_video).
    poster = process_video(io.BytesIO(mp4_h264)).poster
    assert near(poster.getpixel((10, 120)), RED)
    assert near(poster.getpixel((310, 120)), BLUE)


def test_iphone_like_hevc_portrait(mov_hevc_portrait: bytes) -> None:
    v = process_video(io.BytesIO(mov_hevc_portrait))
    # Stored 320x240, shown portrait: turned 90° counterclockwise, as the ffmpeg CLI shows it.
    assert (v.width, v.height) == (240, 320)
    assert v.poster.size == (240, 320)
    assert near(v.poster.getpixel((120, 10)), BLUE)
    assert near(v.poster.getpixel((120, 310)), RED)
    assert (v.codec, v.playable) == ("hevc", False)
    # The local date with its offset is preferred over the UTC creation time.
    assert v.taken_at == datetime(2024, 5, 1, 12, 30, 15, tzinfo=UTC)
    assert v.gps == (48.8566, 2.3522)


@pytest.mark.parametrize("rotation", [-90, 180])
def test_other_rotations(rotation: int) -> None:
    v = process_video(io.BytesIO(make_video(rotation=rotation)))
    if rotation == 180:
        assert (v.width, v.height) == (320, 240)
        assert near(v.poster.getpixel((10, 120)), BLUE)  # upside down: blue on the left
    else:
        assert (v.width, v.height) == (240, 320)
        assert near(v.poster.getpixel((120, 10)), RED)  # clockwise: red on top


def test_index_at_the_start(mp4_h264: bytes) -> None:
    # Phones put it at the end (the other fixtures); web-optimised files at the start.
    data = make_video(faststart=True)
    assert data[4:8] == b"ftyp" and data.find(b"moov") < data.find(b"mdat")
    faststart = process_video(io.BytesIO(data))
    assert (faststart.width, faststart.duration_ms) == (320, 2000)


def test_short_clip_takes_a_frame_from_the_middle() -> None:
    v = process_video(io.BytesIO(make_video(seconds=0.5)))
    assert v.duration_ms == 500
    assert v.poster.size == (320, 240)


def test_no_metadata_gives_no_date_or_place() -> None:
    v = process_video(io.BytesIO(make_video()))
    assert v.taken_at is None
    assert v.gps is None


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2024-05-01T14:30:15+0200", datetime(2024, 5, 1, 12, 30, 15, tzinfo=UTC)),
        ("2023-12-24T18:00:00.000000Z", datetime(2023, 12, 24, 18, 0, tzinfo=UTC)),
        # Without a zone: taken as UTC (like photos without an EXIF offset).
        ("2024-02-03T04:05:06", datetime(2024, 2, 3, 4, 5, 6, tzinfo=UTC)),
        ("2024-02-03T04:05:06Z;2024-02-03T04:05:06Z", datetime(2024, 2, 3, 4, 5, 6, tzinfo=UTC)),
        ("1904-01-01T00:00:00.000000Z", None),  # QuickTime "unset"
        ("1970-01-01T00:00:00.000000Z", None),
        ("2999-01-01T00:00:00Z", None),  # clock clearly wrong
        ("not a date", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_date(value: str | None, expected: datetime | None) -> None:
    assert video_module._parse_date(value) == expected


def test_unset_date_in_a_file() -> None:
    video = make_video(metadata={"creation_time": "1970-01-01T00:00:00.000000Z"})
    assert process_video(io.BytesIO(video)).taken_at is None


@pytest.mark.parametrize(
    ("location", "expected"),
    [
        ("-33.8688+151.2093/", (-33.8688, 151.2093)),
        ("+40.7128-074.0060+010.000/", (40.7128, -74.006)),
        ("+00.0000+000.0000/", None),  # "no fix"
        ("+95.0000+010.0000/", None),
        ("nowhere", None),
    ],
)
def test_locations(location: str, expected: tuple[float, float] | None) -> None:
    video = make_video(metadata={"location": location})
    assert process_video(io.BytesIO(video)).gps == expected


def test_corrupt_and_truncated(mp4_h264: bytes) -> None:
    with pytest.raises(PermanentVideoError):
        process_video(io.BytesIO(b"\x00\x00\x00\x18ftypmp42" + b"garbage" * 100))
    with pytest.raises(PermanentVideoError):
        process_video(io.BytesIO(mp4_h264[: len(mp4_h264) // 2]))


def test_not_a_video() -> None:
    jpeg = io.BytesIO()
    Image.new("RGB", (10, 10)).save(jpeg, format="JPEG")
    with pytest.raises(PermanentVideoError):
        process_video(io.BytesIO(jpeg.getvalue()))


def test_audio_only() -> None:
    import av

    out = io.BytesIO()
    with av.open(out, mode="w", format="mp4") as container:
        stream = container.add_stream("aac", rate=44100)
        frame = av.AudioFrame(format="fltp", layout="mono", samples=1024)
        for plane in frame.planes:
            plane.update(bytes(plane.buffer_size))
        frame.sample_rate = 44100
        frame.pts = 0
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    with pytest.raises(PermanentVideoError, match="no video stream"):
        process_video(io.BytesIO(out.getvalue()))


def test_codecs_outside_the_list_are_refused() -> None:
    # MJPEG in a QuickTime: FFmpeg can decode it, but it's not a codec phones record.
    mjpeg = make_video(fmt="mov", codec="mjpeg", pix_fmt="yuvj420p")
    with pytest.raises(PermanentVideoError, match="unsupported video codec mjpeg"):
        process_video(io.BytesIO(mjpeg))


def test_av1_by_its_canonical_name() -> None:
    v = process_video(io.BytesIO(make_video(codec="libsvtav1")))
    assert (v.codec, v.playable) == ("av1", False)


def test_audio_track_is_not_decoded() -> None:
    # Only the allowed video decoders open while probing (_open_options): AAC isn't one.
    v = process_video(io.BytesIO(make_video(audio=True)))
    assert (v.codec, v.duration_ms) == ("h264", 2000)


def test_ffmpeg_itself_enforces_the_frame_size_while_probing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Probing (find_stream_info) may decode frames before any Python check: FFmpeg's decoders
    get `max_pixels` too, so they refuse to allocate a bigger picture."""
    import av

    seen: list[dict[str, str]] = []
    real_open = av.open

    def spy(*args: object, **kwargs: object) -> object:
        seen.append(dict(kwargs["options"]))  # type: ignore[call-overload]
        return real_open(*args, **kwargs)  # type: ignore[arg-type]

    clip = make_video()  # before the spy: make_video opens a container too
    monkeypatch.setattr(video_module.av, "open", spy)
    process_video(io.BytesIO(clip))
    assert seen[0]["max_pixels"] == str(video_module.MAX_PIXELS)
    assert seen[0]["format_whitelist"] == "mov,mp4,m4a,3gp,3g2,mj2"
    assert "aac" not in seen[0]["codec_whitelist"].split(",")


def test_frame_size_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    # 320x240 = 76,800 px: refused before any frame is decoded.
    monkeypatch.setattr(video_module, "MAX_PIXELS", 76_799)
    with pytest.raises(PermanentVideoError, match="320x240 exceeds 76799 px"):
        process_video(io.BytesIO(make_video()))


def test_errors_of_the_source_propagate_unchanged(mp4_h264: bytes) -> None:
    """An S3 error while reading is transient: it must not look like a broken video."""

    class Flaky(io.BytesIO):
        def read(self, size: int | None = -1) -> bytes:
            raise ConnectionError("S3 is down")

    with pytest.raises(ConnectionError):
        process_video(Flaky(mp4_h264))
