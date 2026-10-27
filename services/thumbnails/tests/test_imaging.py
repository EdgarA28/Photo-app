"""Image pipeline: orientation, metadata, sizes, alpha, formats, errors (§10, tasks 6.1-6.3)."""

import io
from datetime import UTC, datetime

import pytest
from conftest import BLUE, RED, encode, make_exif, two_tone
from PIL import ExifTags, Image

from thumbnails.imaging import (
    PREVIEW_MAX_EDGE,
    THUMB_MAX_EDGE,
    PermanentImageError,
    process_image,
    to_iso,
)


def open_jpeg(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    assert img.format == "JPEG"
    return img


def assert_close(pixel: tuple[int, ...], expected: tuple[int, int, int], tol: int = 40) -> None:
    assert all(abs(a - b) <= tol for a, b in zip(pixel, expected, strict=False)), pixel


def test_rotated_jpeg_is_oriented_and_sized(jpeg_rotated: bytes) -> None:
    result = process_image(jpeg_rotated)
    # FR-GAL-6: stored 3000x2000 with orientation 6 → displayed 2000x3000.
    assert (result.width, result.height) == (2000, 3000)

    preview = open_jpeg(result.preview)
    thumb = open_jpeg(result.thumb)
    assert preview.size == (1067, PREVIEW_MAX_EDGE)
    assert thumb.size == (267, THUMB_MAX_EDGE)
    # Rotating 90° clockwise puts the stored left (red) half on top.
    assert_close(preview.getpixel((preview.width // 2, 10)), RED)
    assert_close(preview.getpixel((preview.width // 2, preview.height - 10)), BLUE)


def assert_no_metadata(img: Image.Image) -> None:
    # NFR-SEC-5: no EXIF (incl. GPS), ICC or XMP in derived images.
    assert len(img.getexif()) == 0
    assert "exif" not in img.info
    assert "icc_profile" not in img.info
    assert "xmp" not in img.info
    assert not any(marker.startswith("APP") and marker != "APP0" for marker, _ in img.applist)


@pytest.mark.parametrize("which", ["thumb", "preview"])
def test_metadata_is_stripped(jpeg_rotated: bytes, which: str) -> None:
    assert_no_metadata(open_jpeg(getattr(process_image(jpeg_rotated), which)))


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP", "HEIF"])
def test_gps_is_stripped_for_every_format(fmt: str) -> None:
    exif = make_exif(taken="2024:01:01 00:00:00", gps=True)
    result = process_image(encode(two_tone((100, 100)), fmt, exif=exif))
    assert_no_metadata(open_jpeg(result.thumb))
    assert_no_metadata(open_jpeg(result.preview))


def test_taken_at_uses_offset_and_subseconds(jpeg_rotated: bytes) -> None:
    taken = process_image(jpeg_rotated).taken_at
    assert taken == datetime(2024, 5, 1, 12, 30, 15, 123000, tzinfo=UTC)
    assert to_iso(taken) == "2024-05-01T12:30:15.123Z"


def test_taken_at_without_offset_is_treated_as_utc(heic: bytes) -> None:
    assert process_image(heic).taken_at == datetime(2023, 12, 24, 18, 0, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    "taken",
    ["0000:00:00 00:00:00", "    :  :     :  :  ", "2024-05-01 14:30:15", "2999:01:01 00:00:00"],
)
def test_invalid_taken_at_is_ignored(taken: str) -> None:
    data = encode(two_tone((100, 100)), "JPEG", exif=make_exif(taken=taken))
    assert process_image(data).taken_at is None


def test_missing_exif(jpeg_plain: bytes) -> None:
    result = process_image(jpeg_plain)
    assert result.taken_at is None
    assert (result.width, result.height) == (320, 240)


def test_small_images_are_not_upscaled(jpeg_plain: bytes) -> None:
    result = process_image(jpeg_plain)
    assert open_jpeg(result.preview).size == (320, 240)
    assert open_jpeg(result.thumb).size == (320, 240)


def test_png_alpha_is_flattened_onto_white(png_alpha: bytes) -> None:
    result = process_image(png_alpha)
    thumb = open_jpeg(result.thumb)
    assert thumb.mode == "RGB"
    assert thumb.size == (400, 300)
    assert_close(thumb.getpixel((50, 150)), (255, 255, 255), tol=5)
    assert_close(thumb.getpixel((350, 150)), BLUE)


def test_palette_transparency_is_flattened() -> None:
    img = Image.new("P", (100, 100), 1)
    img.putpalette([0, 0, 0, 0, 0, 255])
    img.info["transparency"] = 0
    img.paste(0, (0, 0, 50, 100))
    thumb = open_jpeg(process_image(encode(img, "PNG", transparency=0)).thumb)
    assert_close(thumb.getpixel((10, 50)), (255, 255, 255), tol=5)


def test_heic(heic: bytes) -> None:
    result = process_image(heic)
    assert (result.width, result.height) == (1200, 900)
    assert open_jpeg(result.thumb).size == (400, 300)


def test_webp(webp: bytes) -> None:
    result = process_image(webp)
    assert open_jpeg(result.preview).size == (1600, 800)
    assert open_jpeg(result.thumb).size == (400, 200)


@pytest.mark.parametrize("mode", ["L", "CMYK", "LA"])
def test_other_modes_become_rgb(mode: str) -> None:
    fmt = "PNG" if mode == "LA" else "JPEG"
    result = process_image(encode(Image.new(mode, (50, 40)), fmt))
    assert open_jpeg(result.thumb).mode == "RGB"


def test_corrupt_is_permanent(corrupt: bytes) -> None:
    with pytest.raises(PermanentImageError):
        process_image(corrupt)


def test_truncated_is_permanent(truncated_jpeg: bytes) -> None:
    with pytest.raises(PermanentImageError):
        process_image(truncated_jpeg)


def test_unsupported_format_is_permanent() -> None:
    with pytest.raises(PermanentImageError):
        process_image(encode(two_tone((10, 10)), "GIF"))


def test_too_many_pixels_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("thumbnails.imaging.MAX_PIXELS", 99)
    with pytest.raises(PermanentImageError):
        process_image(encode(two_tone((10, 10)), "PNG"))


def test_too_large_source_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("thumbnails.imaging.MAX_SOURCE_BYTES", 10)
    with pytest.raises(PermanentImageError):
        process_image(encode(two_tone((10, 10)), "PNG"))


def test_to_iso_matches_js_to_iso_string() -> None:
    assert to_iso(datetime(2026, 1, 2, 3, 4, 5, 6000, tzinfo=UTC)) == "2026-01-02T03:04:05.006Z"


# 13.2a: GPS is read for the place lookup (derived images stay stripped, see above).


def test_gps_is_read(jpeg_rotated: bytes) -> None:
    # 52°31'12" N, 13°24'36" E
    assert process_image(jpeg_rotated).gps == pytest.approx((52.52, 13.41))


@pytest.mark.parametrize(
    ("lat_ref", "lon_ref", "expected"),
    [("S", "W", (-52.52, -13.41)), ("N", "W", (52.52, -13.41)), ("s", "e", (-52.52, 13.41))],
)
def test_gps_hemispheres(lat_ref: str, lon_ref: str, expected: tuple[float, float]) -> None:
    exif = make_exif(gps=True)
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps[ExifTags.GPS.GPSLatitudeRef] = lat_ref
    gps[ExifTags.GPS.GPSLongitudeRef] = lon_ref
    data = encode(two_tone((100, 100)), "JPEG", exif=exif)
    assert process_image(data).gps == pytest.approx(expected)


@pytest.mark.parametrize(
    "change",
    [
        {ExifTags.GPS.GPSLatitude: (0.0, 0.0, 0.0), ExifTags.GPS.GPSLongitude: (0.0, 0.0, 0.0)},
        {ExifTags.GPS.GPSLatitude: (95.0, 0.0, 0.0)},
        {ExifTags.GPS.GPSLatitudeRef: "X"},
        {ExifTags.GPS.GPSLongitude: (13.0, 24.0)},
    ],
    ids=["zero-zero", "out-of-range", "bad-ref", "two-parts"],
)
def test_invalid_gps_is_ignored(change: dict[int, object]) -> None:
    exif = make_exif(gps=True)
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    for tag, value in change.items():
        gps[tag] = value
    assert process_image(encode(two_tone((100, 100)), "JPEG", exif=exif)).gps is None


def test_no_gps(jpeg_plain: bytes) -> None:
    assert process_image(jpeg_plain).gps is None
