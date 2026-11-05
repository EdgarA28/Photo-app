"""Playback copy (14.9, `transcode.py`): what comes out for phone-like inputs."""

import io
from pathlib import Path

import av
import pytest
from conftest import make_video

from thumbnails.transcode import OutOfTime, target_size, transcode
from thumbnails.video import PermanentVideoError, process_video


@pytest.mark.parametrize(
    ("size", "expected"),
    [
        ((3840, 2160), (1280, 720)),
        ((2160, 3840), (720, 1280)),
        ((1920, 1440), (960, 720)),
        ((1440, 1920), (720, 960)),
        ((1280, 720), (1280, 720)),
        ((320, 240), (320, 240)),  # never upscaled
        ((2560, 1080), (1280, 540)),  # wide: the long side limits
        ((1001, 563), (1000, 562)),  # even sides for 4:2:0
    ],
)
def test_target_size(size: tuple[int, int], expected: tuple[int, int]) -> None:
    assert target_size(*size) == expected


def copy_of(data: bytes, tmp_path: Path) -> tuple[Path, object]:
    out = tmp_path / "copy.mp4"
    return out, transcode(io.BytesIO(data), str(out))


def test_1080p60_becomes_720p30_h264_faststart(tmp_path: Path) -> None:
    out, copy = copy_of(make_video(size=(1920, 1080), fps=60, seconds=2), tmp_path)
    assert (copy.width, copy.height, copy.frames) == (1280, 720, 60)  # type: ignore[attr-defined]
    with av.open(str(out)) as container:
        stream = container.streams.video[0]
        assert stream.codec_context.name == "h264"
        assert stream.codec_context.profile == "High"
        assert stream.codec_context.pix_fmt == "yuv420p"
        assert stream.average_rate == 30
        assert container.duration is not None
        assert abs(container.duration / av.time_base - 2.0) < 0.1
    data = out.read_bytes()
    # The index first: playback starts without a read at the end of the file.
    assert data.find(b"moov") < data.find(b"mdat")


@pytest.mark.parametrize("rotation", [90, 180, 270])
def test_copy_is_upright_like_the_poster(rotation: int, tmp_path: Path) -> None:
    source = make_video(size=(320, 240), rotation=rotation)
    out, _ = copy_of(source, tmp_path)
    expected = process_video(io.BytesIO(source)).poster
    with out.open("rb") as f:
        actual = process_video(f).poster
    assert actual.size == expected.size

    def sides(image: object) -> list[bool]:
        w, h = image.size  # type: ignore[attr-defined]
        points = [(w // 2, 5), (w // 2, h - 6), (5, h // 2), (w - 6, h // 2)]
        return [image.getpixel(p)[0] > 128 for p in points]  # type: ignore[attr-defined]

    assert sides(actual) == sides(expected)
    with av.open(str(out)) as container:
        # Turned in the pixels: no display matrix left for players to (mis)apply.
        frame = next(container.decode(video=0))
        assert frame.rotation == 0


def test_hevc_with_audio_keeps_aac_audio(tmp_path: Path) -> None:
    source = make_video(fmt="mov", codec="libx265", audio=True)
    out, copy = copy_of(source, tmp_path)
    assert copy.has_audio  # type: ignore[attr-defined]
    with av.open(str(out)) as container:
        (audio,) = container.streams.audio
        assert audio.codec_context.name == "aac"
        assert audio.sample_rate == 48000
        assert audio.layout.name == "stereo"


def test_broken_video_is_permanent(tmp_path: Path) -> None:
    data = make_video()
    with pytest.raises(PermanentVideoError):
        copy_of(data[: len(data) // 2], tmp_path)


def test_deadline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("thumbnails.transcode.DEADLINE_CHECK_FRAMES", 1)
    with pytest.raises(OutOfTime):
        transcode(io.BytesIO(make_video()), str(tmp_path / "c.mp4"), lambda: 10_000, 45_000)
