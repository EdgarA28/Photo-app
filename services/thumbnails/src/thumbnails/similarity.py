"""Similar photos (spec §10, task 8.37a; FR-GAL-10/11/12): a difference hash and a sharpness score
per ready photo. The web app groups bursts into stacks with them (§12.3) and the API finds
duplicates (§9); neither is stored anywhere else.

Both values come from the **encoded** thumb and preview, the same bytes the backfill (8.37c) reads
back from S3, so a photo gets the same values whether it was processed live or backfilled.
Pillow only (no numpy), so the photo package stays as it is.
"""

import io
from dataclasses import dataclass
from typing import Any

from PIL import Image, ImageMath

# dHash grid: 9 columns compared pairwise give 8 bits per row, 8 rows → 64 bits.
HASH_WIDTH = 9
HASH_HEIGHT = 8
HASH_HEX_LENGTH = 16


@dataclass(frozen=True)
class Similarity:
    hash: str
    """64-bit difference hash, 16 lowercase hex characters (§8.2 `similarityHash`)."""
    sharpness: float
    """Variance of the Laplacian of the grayscale preview; higher = sharper (§8.2 `sharpness`)."""


SET_CLAUSE = "similarityHash = :simHash, sharpness = :sharpness"
"""The item attributes, for the `ready` update and the backfill (8.37c) alike."""


def item_values(result: Similarity) -> dict[str, Any]:
    """DynamoDB values for `SET_CLAUSE` (sharpness with 2 decimals)."""
    return {
        ":simHash": {"S": result.hash},
        ":sharpness": {"N": f"{result.sharpness:.2f}"},
    }


def similarity(thumb: bytes, preview: bytes) -> Similarity:
    """Hash from the thumb (enough detail for a 9 x 8 grid, quick to decode), sharpness from the
    preview (1600 px long edge, so scores compare across photos of any original size)."""
    with Image.open(io.BytesIO(thumb)) as img:
        hash_hex = difference_hash(img)
    with Image.open(io.BytesIO(preview)) as img:
        score = laplacian_variance(img)
    return Similarity(hash=hash_hex, sharpness=score)


def difference_hash(img: Image.Image) -> str:
    """dHash: grayscale, shrink to 9 x 8 (area average), one bit per pixel that is brighter than
    its right neighbour, row by row, most significant bit first. Resizing, re-encoding and small
    brightness changes keep most bits; a different scene flips about half of them."""
    small = img.convert("L").resize((HASH_WIDTH, HASH_HEIGHT), Image.Resampling.BOX)
    pixels = list(small.get_flattened_data())
    value = 0
    for row in range(HASH_HEIGHT):
        for col in range(HASH_WIDTH - 1):
            left = pixels[row * HASH_WIDTH + col]
            right = pixels[row * HASH_WIDTH + col + 1]
            value = (value << 1) | (1 if left > right else 0)
    return f"{value:0{HASH_HEX_LENGTH}x}"


def laplacian_variance(img: Image.Image) -> float:
    """Variance of the 4-neighbour Laplacian over the inner pixels, in float (Pillow's 3 x 3 kernel
    filter only works on 8-bit images and would clip the negative half). A blurred or shaken
    shot has weaker edges, so a lower variance. 0 for images under 3 x 3."""
    gray = img.convert("F")
    w, h = gray.size
    if w < 3 or h < 3:
        return 0.0
    lap = ImageMath.lambda_eval(
        lambda a: a["up"] + a["down"] + a["left"] + a["right"] - a["centre"] * 4,
        centre=gray.crop((1, 1, w - 1, h - 1)),
        up=gray.crop((1, 0, w - 1, h - 2)),
        down=gray.crop((1, 2, w - 1, h)),
        left=gray.crop((0, 1, w - 2, h - 1)),
        right=gray.crop((2, 1, w, h - 1)),
    )
    squared = ImageMath.lambda_eval(lambda a: a["x"] * a["x"], x=lap)
    mean = _mean(lap)
    return max(0.0, _mean(squared) - mean * mean)


def hamming_distance(a: str, b: str) -> int:
    """Bits that differ between two hashes (tests and scripts; the web app and API have their
    own)."""
    return (int(a, 16) ^ int(b, 16)).bit_count()


def _mean(img: Image.Image) -> float:
    # A box resize to one pixel averages in float for mode F (ImageStat clips F to 0-255).
    value = img.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    assert isinstance(value, float)
    return value
