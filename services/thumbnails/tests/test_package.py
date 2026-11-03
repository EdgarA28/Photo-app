import subprocess
import sys

import pytest

import thumbnails


def test_package_imports() -> None:
    assert thumbnails.__doc__


@pytest.mark.parametrize(
    ("module", "foreign"),
    [
        # Each Lambda package carries only its own native library (build.sh, 14.3).
        ("thumbnails.handler", "av"),
        ("thumbnails.video_handler", "pillow_heif"),
    ],
)
def test_handlers_import_only_their_own_media_library(module: str, foreign: str) -> None:
    code = f"import sys, {module}; print({foreign!r} in sys.modules)"
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "False"
