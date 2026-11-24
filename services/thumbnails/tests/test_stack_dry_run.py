"""Stack grouping of the dry run (8.37d; FR-GAL-10/11, spec §12.3)."""

import importlib.util
from pathlib import Path
from types import ModuleType


def load_script() -> ModuleType:
    path = Path(__file__).parents[1] / "scripts" / "stack_dry_run.py"
    spec = importlib.util.spec_from_file_location("stack_dry_run", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


script = load_script()
BASE = "0000000000000000"


def flip(bits: int) -> str:
    """BASE with the lowest `bits` bits set."""
    return f"{(1 << bits) - 1:016x}"


def photo(name: str, second: int, hash_hex: str | None = BASE, sharpness: float | None = 1.0,
          top_pick_at: str | None = None):  # fmt: skip
    return script.Photo(
        user_id="u",
        photo_id=name,
        file_name=name,
        taken_at=f"2026-11-01T10:{second // 60:02d}:{second % 60:02d}.000+00:00",
        similarity_hash=hash_hex,
        sharpness=sharpness,
        top_pick_at=top_pick_at,
    )


def names(groups) -> list[list[str]]:
    return [[p.photo_id for p in g] for g in groups]


def test_burst_within_limits_is_one_stack() -> None:
    photos = [photo("c", 20, flip(3)), photo("b", 10, flip(10)), photo("a", 0, BASE)]
    assert names(script.group_stacks(photos, 60, 10)) == [["c", "b", "a"]]


def test_time_gap_ends_the_stack() -> None:
    """60 s between neighbours, not from the first photo: a long burst stays one stack."""
    photos = [photo("d", 180), photo("c", 120), photo("b", 60), photo("a", 0)]
    assert names(script.group_stacks(photos, 60, 10)) == [["d", "c", "b", "a"]]
    photos = [photo("b", 61), photo("a", 0)]
    assert names(script.group_stacks(photos, 60, 10)) == [["b"], ["a"]]


def test_within_two_seconds_up_to_twenty_bits() -> None:
    """A burst where the camera moved a little (dev 2026-11-24: 18 bits, 0.4 s apart)."""
    assert names(script.group_stacks([photo("b", 2, flip(20)), photo("a", 0)], 60, 10)) == [
        ["b", "a"]
    ]
    assert names(script.group_stacks([photo("b", 2, flip(21)), photo("a", 0)], 60, 10)) == [
        ["b"],
        ["a"],
    ]
    assert names(script.group_stacks([photo("b", 3, flip(11)), photo("a", 0)], 60, 10)) == [
        ["b"],
        ["a"],
    ]


def test_hash_close_to_any_member_joins() -> None:
    """c is 11 bits from a but 1 from b: it joins (a slow pan drifts away from the first shot)."""
    a, b, c = BASE, flip(10), flip(11)
    photos = [photo("a", 20, a), photo("b", 10, b), photo("c", 0, c)]
    assert names(script.group_stacks(photos, 60, 10)) == [["a", "b", "c"]]
    assert names(script.group_stacks([photo("a", 5, a), photo("c", 0, c)], 60, 10)) == [
        ["a"],
        ["c"],
    ]


def test_photos_without_a_hash_stay_single() -> None:
    photos = [photo("c", 20), photo("b", 10, None), photo("a", 0)]
    assert names(script.group_stacks(photos, 60, 10)) == [["c"], ["b"], ["a"]]


def test_a_different_photo_in_between_splits_the_burst() -> None:
    """Stacks are runs of the date-sorted list (§12.3), so the grid order never changes."""
    photos = [photo("c", 20), photo("x", 10, "ffffffffffffffff"), photo("a", 0)]
    assert names(script.group_stacks(photos, 60, 10)) == [["c"], ["x"], ["a"]]


def test_top_pick_order() -> None:
    sharp = photo("sharp", 0, sharpness=90)
    blurry = photo("blurry", 1, sharpness=10)
    assert script.top_pick([blurry, sharp]) is sharp
    chosen = photo("chosen", 2, sharpness=5, top_pick_at="2026-11-02T10:00:00.000Z")
    older_choice = photo("older", 3, sharpness=5, top_pick_at="2026-11-01T10:00:00.000Z")
    assert script.top_pick([sharp, older_choice, chosen]) is chosen
    unrated = [photo("x", 0, sharpness=None), photo("y", 1, sharpness=None)]
    assert script.top_pick(unrated) is unrated[0]


def test_near_misses() -> None:
    photos = [photo("c", 71, flip(15)), photo("b", 10, BASE), photo("a", 0, flip(12))]
    assert [
        (n.photo_id, o.photo_id, bits) for n, o, bits in script.near_misses(photos, 60, 10)
    ] == [("b", "a", 12)]
