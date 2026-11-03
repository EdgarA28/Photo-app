"""Derived images (spec §10, §10.2): resize to preview and thumb, encode as stripped JPEG.

Shared by photos (`imaging.py`) and videos' poster frames (`video.py`). Pillow only: no format
plugins (pillow-heif) or FFmpeg, so either Lambda package can import it.
"""

import io
from datetime import UTC, datetime

from PIL import Image

# Mirrors THUMB_MAX_EDGE / PREVIEW_MAX_EDGE in packages/shared/src/constants.ts.
THUMB_MAX_EDGE = 400
PREVIEW_MAX_EDGE = 1600
THUMB_QUALITY = 75
PREVIEW_QUALITY = 82


def derive_jpegs(rgb: Image.Image) -> tuple[bytes, bytes]:
    """(thumb, preview) of an RGB image already in display orientation and sRGB."""
    preview = rgb.copy()
    preview.thumbnail((PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE), Image.Resampling.LANCZOS)
    thumb = preview.copy()  # Downscaling from the preview is faster and visually identical.
    thumb.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
    return encode_jpeg(thumb, THUMB_QUALITY), encode_jpeg(preview, PREVIEW_QUALITY)


def encode_jpeg(img: Image.Image, quality: int) -> bytes:
    """NFR-SEC-5: write pixels only, so no EXIF (incl. GPS), XMP, ICC or comments."""
    img.info.clear()
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)
    return out.getvalue()


def to_iso(dt: datetime) -> str:
    """Same format as JS `Date.toISOString()` (millisecond precision, `Z`), so `takenAt` values
    written here and by the API sort correctly as strings in GSI1SK."""
    utc = dt.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"
