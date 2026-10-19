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
