#!/usr/bin/env bash
# Packages the thumbnail Lambda into dist/ for Python 3.13 on arm64 (task 6.8, spec §4, §10.2).
# The infra module zips dist/ (like services/auth-triggers), so run this before planning.
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

cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist build

uv export --frozen --no-dev --no-emit-project --output-file build/requirements.txt >/dev/null

uv pip install \
  --quiet \
  --target dist \
  --python-version 3.13 \
  --python-platform "$PLATFORM" \
  --only-binary :all: \
  --no-deps \
  --require-hashes \
  --requirement build/requirements.txt

cp -r src/thumbnails dist/
find dist -name __pycache__ -type d -prune -exec rm -rf {} +

uv run --frozen python -m compileall -q --invalidation-mode unchecked-hash dist

echo "dist/ ($PLATFORM): $(du -sh dist | cut -f1) unpacked"
