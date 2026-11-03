#!/usr/bin/env bash
# Packages the two Lambdas of this service for Python 3.13 on arm64 (tasks 6.8, 14.3; spec §4,
# §10, §10.2). The infra modules zip the folders, so run this before planning.
#
#   dist/        thumbnail Lambda (thumbnails.handler): Pillow + pillow-heif     (extra `photo`)
#   dist-video/  video Lambda (thumbnails.video_handler): Pillow + PyAV/FFmpeg   (extra `video`)
#
# Same source in both; each carries only its own native libraries. Lambda takes a zip of at most
# 50 MB uploaded directly: dist-video is the big one (PyAV ~91 MB unpacked), checked below.
#
# - Runtime dependencies come from uv.lock (hashes checked), as aarch64 wheels only: nothing is
#   compiled here, so the host's architecture doesn't matter. Lambda's python3.13 runs on
#   Amazon Linux 2023 (glibc 2.34), which manylinux_2_28 wheels support.
# - boto3 is not packaged: the Lambda runtime ships it (dev-only dependency).
# - Bytecode is precompiled with hash-based .pyc files, so it stays valid whatever the zip does
#   to file timestamps and saves compiling Pillow on every cold start.
set -euo pipefail

# Overridable only to smoke-test the package on an x86_64 machine; Lambda needs the default.
PLATFORM="${PLATFORM:-aarch64-manylinux_2_28}"
# Lambda limits: 250 MB unpacked (function + layers); 50 MB for a zip uploaded directly.
MAX_UNPACKED_MB=250
MAX_ZIPPED_MB=50

cd "$(dirname "$0")"
mkdir -p build

package() {
  local extra="$1" out="$2"
  rm -rf "$out"
  mkdir -p "$out"
  uv export --frozen --no-dev --no-emit-project --extra "$extra" \
    --output-file "build/requirements-$extra.txt" >/dev/null
  uv pip install \
    --quiet \
    --target "$out" \
    --python-version 3.13 \
    --python-platform "$PLATFORM" \
    --only-binary :all: \
    --no-deps \
    --require-hashes \
    --requirement "build/requirements-$extra.txt"
  cp -r src/thumbnails "$out/"
  find "$out" -name __pycache__ -type d -prune -exec rm -rf {} +
  uv run --frozen python -m compileall -q --invalidation-mode unchecked-hash "$out"

  local unpacked zipped
  unpacked=$(du -sm "$out" | cut -f1)
  rm -f "build/$out.zip"
  (cd "$out" && zip -qr -X "../build/$out.zip" .)
  zipped=$(($(stat -c %s "build/$out.zip") / 1048576))
  rm -f "build/$out.zip"
  echo "$out/ ($PLATFORM): ${unpacked} MB unpacked, ~${zipped} MB zipped"
  if ((unpacked > MAX_UNPACKED_MB || zipped >= MAX_ZIPPED_MB)); then
    echo "$out/ is over Lambda's limits (${MAX_UNPACKED_MB} MB unpacked, ${MAX_ZIPPED_MB} MB zipped)" >&2
    exit 1
  fi
}

package photo dist
package video dist-video
