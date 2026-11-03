"""Image fixtures (task 6.7), generated in code so no binary files live in git."""

import io

import pillow_heif
import pytest
from PIL import ExifTags, Image, ImageCms

pillow_heif.register_heif_opener()

RED = (255, 0, 0)
BLUE = (0, 0, 255)


def two_tone(size: tuple[int, int], mode: str = "RGB") -> Image.Image:
    """Left half red, right half blue, so orientation is visible in the output."""
    img = Image.new(mode, size, BLUE)
    img.paste(RED, (0, 0, size[0] // 2, size[1]))
    return img


def make_exif(
    orientation: int = 1,
    taken: str | None = None,
    offset: str | None = None,
    subsec: str | None = None,
    gps: bool = False,
) -> Image.Exif:
    exif = Image.Exif()
    exif[ExifTags.Base.Orientation] = orientation
    exif[ExifTags.Base.Make] = "TestCam"
    exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
    if taken is not None:
        exif_ifd[ExifTags.Base.DateTimeOriginal] = taken
    if offset is not None:
        exif_ifd[ExifTags.Base.OffsetTimeOriginal] = offset
    if subsec is not None:
        exif_ifd[ExifTags.Base.SubsecTimeOriginal] = subsec
    if gps:
        gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
        gps_ifd[ExifTags.GPS.GPSLatitudeRef] = "N"
        gps_ifd[ExifTags.GPS.GPSLatitude] = (52.0, 31.0, 12.0)
        gps_ifd[ExifTags.GPS.GPSLongitudeRef] = "E"
        gps_ifd[ExifTags.GPS.GPSLongitude] = (13.0, 24.0, 36.0)
    return exif


def encode(img: Image.Image, fmt: str, **params: object) -> bytes:
    out = io.BytesIO()
    img.save(out, format=fmt, **params)
    return out.getvalue()


@pytest.fixture
def jpeg_rotated() -> bytes:
    """3000x2000 stored sideways (orientation 6), with date, offset, GPS and an ICC profile."""
    exif = make_exif(
        orientation=6, taken="2024:05:01 14:30:15", offset="+02:00", subsec="123", gps=True
    )
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    return encode(two_tone((3000, 2000)), "JPEG", exif=exif, icc_profile=icc, quality=90)


@pytest.fixture
def jpeg_plain() -> bytes:
    """Small JPEG without any EXIF."""
    return encode(two_tone((320, 240)), "JPEG")


@pytest.fixture
def png_alpha() -> bytes:
    """Fully transparent left half: must come out white."""
    img = Image.new("RGBA", (800, 600), (*BLUE, 255))
    img.paste((0, 0, 0, 0), (0, 0, 400, 600))
    return encode(img, "PNG")


@pytest.fixture
def heic() -> bytes:
    return encode(two_tone((1200, 900)), "HEIF", exif=make_exif(taken="2023:12:24 18:00:00"))


@pytest.fixture
def webp() -> bytes:
    return encode(two_tone((2400, 1200)), "WEBP")


@pytest.fixture
def corrupt() -> bytes:
    return b"\xff\xd8\xff\xe0 definitely not a real jpeg" * 10


@pytest.fixture
def truncated_jpeg(jpeg_rotated: bytes) -> bytes:
    return jpeg_rotated[: len(jpeg_rotated) // 3]


def make_video(
    fmt: str = "mp4",
    codec: str = "libx264",
    seconds: float = 2.0,
    size: tuple[int, int] = (320, 240),
    fps: int = 10,
    rotation: int | None = None,
    metadata: dict[str, str] | None = None,
    faststart: bool = False,
    apple_tags: bool = False,
) -> bytes:
    """A video clip made with PyAV (14.3; no binary fixtures in git): black for the first second,
    then `two_tone` (red left, blue right), so the poster at 1 s shows the orientation.

    `rotation` is a display matrix (counterclockwise degrees, how phones mark portrait videos);
    `faststart` puts the index (`moov`) first, otherwise it comes last like on most phones;
    `apple_tags` writes metadata keys as QuickTime `mdta` items, as iPhones do."""
    import tempfile
    from pathlib import Path

    flags = [f for f, on in (("+faststart", faststart), ("+use_metadata_tags", apple_tags)) if on]
    options = {"movflags": "".join(flags)} if flags else {}
    # faststart rewrites the file in a second pass, which needs a real file.
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"clip.{fmt}"
        _write_video(path, fmt, codec, seconds, size, fps, rotation, metadata, options)
        return path.read_bytes()


def _write_video(
    path: object,
    fmt: str,
    codec: str,
    seconds: float,
    size: tuple[int, int],
    fps: int,
    rotation: int | None,
    metadata: dict[str, str] | None,
    options: dict[str, str],
) -> None:
    import av

    with av.open(str(path), mode="w", format=fmt, options=options) as container:
        for k, v in (metadata or {}).items():
            container.metadata[k] = v
        codec_options = {"x265-params": "log-level=none"} if codec == "libx265" else {}
        stream = container.add_stream(codec, rate=fps, options=codec_options)
        stream.width, stream.height = size
        stream.pix_fmt = "yuv420p"
        if rotation is not None:
            stream.set_display_rotation(rotation)
        black = Image.new("RGB", size, (0, 0, 0))
        tone = two_tone(size)
        for i in range(round(seconds * fps)):
            frame = av.VideoFrame.from_image(tone if i >= fps else black)
            frame.pts = i
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


@pytest.fixture
def mp4_h264() -> bytes:
    """2 s H.264 MP4 with a UTC creation time and an Android-style location tag."""
    return make_video(
        metadata={"creation_time": "2023-12-24T18:00:00.000000Z", "location": "+52.5200+013.4050/"}
    )


@pytest.fixture
def mov_hevc_portrait() -> bytes:
    """iPhone-like: HEVC MOV, landscape frames rotated for portrait, Apple date + location tags."""
    return make_video(
        fmt="mov",
        codec="libx265",
        size=(320, 240),
        rotation=90,
        apple_tags=True,
        metadata={
            "creation_time": "2024-05-01T12:30:15.000000Z",
            "com.apple.quicktime.creationdate": "2024-05-01T14:30:15+0200",
            "com.apple.quicktime.location.ISO6709": "+48.8566+002.3522+035.000/",
        },
    )
