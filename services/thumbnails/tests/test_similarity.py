"""Similar photos (task 8.37a; FR-GAL-10/11/12, spec §10): difference hash + sharpness.

The fixtures run through the real pipeline (`process_image`), since the values are computed from
its thumb and preview. Thresholds checked here are the spec's starting points (§9 duplicates
≤ 3 bits, §12.3 stacks ≤ 10 bits); 8.37d tunes them on real bursts.
"""

import io
import random

import pytest
from conftest import encode
from PIL import Image, ImageDraw, ImageFilter

from thumbnails.imaging import process_image
from thumbnails.similarity import (
    HASH_HEX_LENGTH,
    difference_hash,
    hamming_distance,
    laplacian_variance,
    similarity,
)

DUPLICATE_BITS = 3
STACK_BITS = 10


def scene(seed: int, size: tuple[int, int] = (3200, 2200)) -> Image.Image:
    """A photo-like test picture: a gradient sky, random shapes with edges, and a little noise."""
    rng = random.Random(seed)
    w, h = size
    img = Image.linear_gradient("L").resize(size).convert("RGB")
    draw = ImageDraw.Draw(img)
    for _ in range(40):
        x, y = rng.randrange(w), rng.randrange(h)
        rw, rh = rng.randrange(w // 20, w // 4), rng.randrange(h // 20, h // 4)
        colour = tuple(rng.randrange(256) for _ in range(3))
        shape = draw.ellipse if rng.random() < 0.5 else draw.rectangle
        shape((x, y, x + rw, y + rh), fill=colour)
    noise = Image.effect_noise(size, 12).convert("RGB")
    return Image.blend(img, noise, 0.08)


def shot(img: Image.Image, dx: int = 0, dy: int = 0, size: tuple[int, int] = (3000, 2000)) -> bytes:
    """The camera's frame: a crop of the scene (moved by dx/dy, like a hand between burst shots),
    encoded as a phone JPEG."""
    left, top = 100 + dx, 100 + dy
    return encode(img.crop((left, top, left + size[0], top + size[1])), "JPEG", quality=92)


def values(data: bytes) -> tuple[str, float]:
    image = process_image(data)
    result = similarity(image.thumb, image.preview)
    return result.hash, result.sharpness


@pytest.fixture(scope="module")
def first() -> Image.Image:
    return scene(1)


def test_hash_is_16_hex_characters(first: Image.Image) -> None:
    hash_hex, sharpness = values(shot(first))
    assert len(hash_hex) == HASH_HEX_LENGTH
    int(hash_hex, 16)
    assert hash_hex == hash_hex.lower()
    assert sharpness > 0


def test_same_bytes_give_the_same_values(first: Image.Image) -> None:
    data = shot(first)
    assert values(data) == values(data)


def test_burst_shots_are_within_the_stack_threshold(first: Image.Image) -> None:
    base, _ = values(shot(first))
    for dx, dy in ((15, 0), (0, 20), (-25, 10), (30, -30)):
        other, _ = values(shot(first, dx, dy))
        assert hamming_distance(base, other) <= STACK_BITS, (dx, dy)


def test_different_scenes_are_far_apart(first: Image.Image) -> None:
    base, _ = values(shot(first))
    for seed in (2, 3, 4, 5):
        other, _ = values(shot(scene(seed)))
        assert hamming_distance(base, other) > STACK_BITS, seed


def test_resized_copy_is_a_duplicate(first: Image.Image) -> None:
    """E.g. the same photo uploaded and imported from Google Photos at a lower resolution."""
    data = shot(first)
    small = Image.open(io.BytesIO(data)).resize((1200, 800), Image.Resampling.LANCZOS)
    assert hamming_distance(values(data)[0], values(encode(small, "JPEG"))[0]) <= DUPLICATE_BITS


def test_re_encoded_copy_is_a_duplicate(first: Image.Image) -> None:
    data = shot(first)
    original = Image.open(io.BytesIO(data))
    for copy in (encode(original, "JPEG", quality=60), encode(original, "WEBP", quality=70)):
        assert hamming_distance(values(data)[0], values(copy)[0]) <= DUPLICATE_BITS


def test_blurred_shot_is_less_sharp(first: Image.Image) -> None:
    """FR-GAL-11: the sharpest photo of a stack becomes its top pick."""
    sharp = shot(first)
    blurred = encode(
        Image.open(io.BytesIO(sharp)).filter(ImageFilter.GaussianBlur(4)), "JPEG", quality=92
    )
    sharp_hash, sharp_score = values(sharp)
    blurred_hash, blurred_score = values(blurred)
    assert blurred_score < sharp_score / 2
    # Still the same shot: a blurred try of a burst stays in its stack.
    assert hamming_distance(sharp_hash, blurred_hash) <= STACK_BITS


def test_sharpness_compares_across_original_sizes(first: Image.Image) -> None:
    """Measured on the preview (1600 px), so a 12 MP and a 48 MP shot of the same frame score
    alike."""
    big = Image.open(io.BytesIO(shot(first)))
    bigger = big.resize((6000, 4000), Image.Resampling.LANCZOS)
    _, score = values(encode(big, "JPEG", quality=92))
    _, bigger_score = values(encode(bigger, "JPEG", quality=92))
    assert bigger_score == pytest.approx(score, rel=0.25)


def test_flat_image_has_zero_sharpness() -> None:
    assert laplacian_variance(Image.new("RGB", (100, 80), (90, 120, 200))) == pytest.approx(0)


def test_tiny_images() -> None:
    assert laplacian_variance(Image.new("L", (2, 2))) == 0.0
    assert difference_hash(Image.new("L", (1, 1))) == "0" * HASH_HEX_LENGTH


def test_difference_hash_bits() -> None:
    """Brightness falling to the right sets every bit, rising clears them, MSB = top-left pair."""
    falling = Image.linear_gradient("L").rotate(-90).resize((90, 80))
    assert difference_hash(falling) == "f" * HASH_HEX_LENGTH
    assert difference_hash(falling.transpose(Image.Transpose.FLIP_LEFT_RIGHT)) == "0" * 16
    only_first = Image.new("L", (9, 8), 0)
    only_first.putpixel((0, 0), 255)
    assert difference_hash(only_first) == "8" + "0" * 15


def test_laplacian_variance_matches_a_direct_computation() -> None:
    rng = random.Random(7)
    img = Image.new("L", (40, 30))
    img.putdata([rng.randrange(256) for _ in range(40 * 30)])
    px = img.load()
    assert px is not None
    lap = [
        float(px[x, y - 1] + px[x, y + 1] + px[x - 1, y] + px[x + 1, y] - 4 * px[x, y])
        for y in range(1, 29)
        for x in range(1, 39)
    ]
    mean = sum(lap) / len(lap)
    expected = sum((v - mean) ** 2 for v in lap) / len(lap)
    assert laplacian_variance(img) == pytest.approx(expected, rel=1e-4)


def test_hamming_distance() -> None:
    assert hamming_distance("0" * 16, "0" * 16) == 0
    assert hamming_distance("0" * 16, "f" * 16) == 64
    assert hamming_distance("8" + "0" * 15, "0" * 15 + "1") == 2
