"""Image pipeline (spec §10, tasks 6.1-6.3): decode, orient, read metadata, resize, re-encode.

Pure functions on bytes; no AWS access. Anything raised as PermanentImageError means the
original can never be processed (corrupt, unsupported, too large) and must not be retried.
"""

import io
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone

import pillow_heif
from PIL import ExifTags, Image, ImageCms, ImageOps, UnidentifiedImageError

pillow_heif.register_heif_opener()

# Mirrors THUMB_MAX_EDGE / PREVIEW_MAX_EDGE / MAX_UPLOAD_BYTES in packages/shared/src/constants.ts.
THUMB_MAX_EDGE = 400
PREVIEW_MAX_EDGE = 1600
MAX_SOURCE_BYTES = 50 * 1024 * 1024
THUMB_QUALITY = 75
PREVIEW_QUALITY = 82

# Decompression-bomb guard: ~100 MP decodes to ~400 MB RGBA, well inside the 1536 MB Lambda.
MAX_PIXELS = 100_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS

# FR-UP-2: JPEG, PNG, HEIC/HEIF, WebP. Pillow only tries these decoders.
ALLOWED_FORMATS = ("JPEG", "PNG", "HEIF", "WEBP")

# EXIF orientations that rotate by 90°/270°, i.e. swap width and height.
_SWAPPING_ORIENTATIONS = {5, 6, 7, 8}
_EXIF_DATETIME = re.compile(r"(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})")
_EXIF_OFFSET = re.compile(r"([+-])(\d{2}):(\d{2})")
_SRGB = ImageCms.createProfile("sRGB")


class PermanentImageError(Exception):
    """The original cannot be processed; mark the photo `failed` (FR-GAL-5)."""


@dataclass(frozen=True)
class ProcessedImage:
    width: int
    """Displayed (EXIF-oriented) width of the original."""
    height: int
    taken_at: datetime | None
    """EXIF DateTimeOriginal in UTC, or None if absent/invalid (caller falls back, §8.2)."""
    gps: tuple[float, float] | None
    """EXIF GPS (latitude, longitude) in degrees, or None if absent/invalid (13.2a). Read for the
    place lookup only: derived images stay stripped (NFR-SEC-5)."""
    thumb: bytes
    preview: bytes


def process_image(data: bytes) -> ProcessedImage:
    if len(data) > MAX_SOURCE_BYTES:
        raise PermanentImageError(f"source is {len(data)} bytes, limit {MAX_SOURCE_BYTES}")
    try:
        return _process(data)
    except PermanentImageError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError) as e:
        raise PermanentImageError(str(e)) from e
    except (OSError, ValueError, SyntaxError, EOFError) as e:
        # Pillow's errors for truncated/corrupt data and unsupported modes.
        raise PermanentImageError(f"{type(e).__name__}: {e}") from e


def _process(data: bytes) -> ProcessedImage:
    with Image.open(io.BytesIO(data), formats=ALLOWED_FORMATS) as img:
        source_width, source_height = img.size
        if source_width * source_height > MAX_PIXELS:
            raise PermanentImageError(f"{source_width}x{source_height} exceeds {MAX_PIXELS} px")

        exif = img.getexif()
        orientation = exif.get(ExifTags.Base.Orientation, 1)
        taken_at = _taken_at(exif)
        gps = _gps(exif)
        width, height = (
            (source_height, source_width)
            if orientation in _SWAPPING_ORIENTATIONS
            else (source_width, source_height)
        )

        # JPEG only: let libjpeg decode at 1/2, 1/4 or 1/8 scale while staying >= preview size.
        img.draft("RGB", (PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE))
        img.load()

        oriented = ImageOps.exif_transpose(img)  # FR-GAL-6
        rgb = _to_srgb(_flatten(oriented), img.info.get("icc_profile"))

    preview = rgb.copy()
    preview.thumbnail((PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE), Image.Resampling.LANCZOS)
    thumb = preview.copy()  # Downscaling from the preview is faster and visually identical.
    thumb.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.Resampling.LANCZOS)

    return ProcessedImage(
        width=width,
        height=height,
        taken_at=taken_at,
        gps=gps,
        thumb=_encode_jpeg(thumb, THUMB_QUALITY),
        preview=_encode_jpeg(preview, PREVIEW_QUALITY),
    )


def _flatten(img: Image.Image) -> Image.Image:
    """JPEG has no alpha: composite transparent images onto white (§10)."""
    has_alpha = img.mode in ("RGBA", "LA", "PA", "RGBa", "La") or (
        img.mode == "P" and "transparency" in img.info
    )
    if not has_alpha:
        return img.convert("RGB")
    rgba = img.convert("RGBA")
    background = Image.new("RGB", rgba.size, "white")
    background.paste(rgba, mask=rgba.getchannel("A"))
    return background


def _to_srgb(img: Image.Image, icc_profile: bytes | None) -> Image.Image:
    """Bake an embedded colour profile (e.g. Display P3 from phones) into sRGB pixels,
    since the profile itself is stripped from the output."""
    if not icc_profile:
        return img
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
        converted = ImageCms.profileToProfile(img, source, _SRGB, outputMode="RGB")
    except (ImageCms.PyCMSError, OSError):
        return img  # Broken profile: keep the pixels as they are.
    return converted if converted is not None else img


def _encode_jpeg(img: Image.Image, quality: int) -> bytes:
    """NFR-SEC-5: write pixels only, so no EXIF (incl. GPS), XMP, ICC or comments."""
    img.info.clear()
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)
    return out.getvalue()


def _taken_at(exif: Image.Exif) -> datetime | None:
    """EXIF DateTimeOriginal (+ SubSecTimeOriginal, OffsetTimeOriginal) as an aware UTC datetime.

    Without an offset the camera's local time is unknown, so it is stored as if it were UTC
    (keeps the wall-clock time the user expects to see)."""
    exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
    raw = exif_ifd.get(ExifTags.Base.DateTimeOriginal)
    if not isinstance(raw, str):
        return None
    match = _EXIF_DATETIME.fullmatch(raw.strip("\x00 "))
    if match is None:
        return None
    try:
        parsed = datetime(*(int(part) for part in match.groups()), tzinfo=UTC)
    except ValueError:
        return None  # e.g. "0000:00:00 00:00:00"
    if parsed.year < 1900:
        return None

    subsec = exif_ifd.get(ExifTags.Base.SubsecTimeOriginal)
    if isinstance(subsec, str) and subsec.strip("\x00 ").isdigit():
        millis = int(subsec.strip("\x00 ")[:3].ljust(3, "0"))
        parsed = parsed.replace(microsecond=millis * 1000)

    offset = exif_ifd.get(ExifTags.Base.OffsetTimeOriginal)
    if isinstance(offset, str) and (m := _EXIF_OFFSET.fullmatch(offset.strip("\x00 "))):
        sign = -1 if m.group(1) == "-" else 1
        delta = timedelta(hours=int(m.group(2)), minutes=int(m.group(3)))
        parsed = parsed.replace(tzinfo=timezone(sign * delta)).astimezone(UTC)

    if parsed > datetime.now(UTC) + timedelta(days=1):
        return None  # Camera clock clearly wrong.
    return parsed


def _gps(exif: Image.Exif) -> tuple[float, float] | None:
    """EXIF GPSLatitude/GPSLongitude (degrees, minutes, seconds + N/S, E/W refs) as signed degrees.
    Missing, malformed, out-of-range and 0/0 (what some apps write for "no fix") give None."""
    gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
    lat = _degrees(gps_ifd.get(ExifTags.GPS.GPSLatitude), gps_ifd.get(ExifTags.GPS.GPSLatitudeRef))
    lon = _degrees(
        gps_ifd.get(ExifTags.GPS.GPSLongitude), gps_ifd.get(ExifTags.GPS.GPSLongitudeRef)
    )
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lat == 0 and lon == 0:
        return None
    return lat, lon


def _degrees(dms: object, ref: object) -> float | None:
    if not isinstance(dms, tuple) or len(dms) != 3 or not isinstance(ref, str):
        return None
    try:
        degrees, minutes, seconds = (float(part) for part in dms)
    except (TypeError, ValueError, ZeroDivisionError):
        return None  # e.g. a rational with a zero denominator
    if any(math.isnan(v) or v < 0 for v in (degrees, minutes, seconds)):
        return None
    value = degrees + minutes / 60 + seconds / 3600
    ref = ref.strip("\x00 ").upper()
    if ref in ("S", "W"):
        return -value
    return value if ref in ("N", "E") else None


def to_iso(dt: datetime) -> str:
    """Same format as JS `Date.toISOString()` (millisecond precision, `Z`), so `takenAt` values
    written here and by the API sort correctly as strings in GSI1SK."""
    utc = dt.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"
