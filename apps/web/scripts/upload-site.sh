#!/usr/bin/env bash
# Uploads the web build (apps/web/dist) to an environment's site bucket and invalidates the
# CloudFront paths that aren't content-hashed (10.2, spec §14.2). Used by deploy.yml; by hand,
# build with the environment's VITE_* config first (it is baked in at build time):
#   set -a; source apps/web/.env.development.local; set +a
#   pnpm --filter @photo-app/web build
#   AWS_PROFILE=dev apps/web/scripts/upload-site.sh <site-bucket> <distribution-id>
#
# It doesn't build. It refuses a build without the app client ID in VITE_COGNITO_CLIENT_ID: a
# plain `pnpm build` has no config, and the app would stop at startup (dev, 2026-11-05).
#
# Order matters for clients mid-load: hashed assets first (immutable, old ones kept so open tabs
# can still lazy-load them), then the other root files, then the manifest and service worker,
# and index.html last, so nothing references a file that isn't there yet.
set -euo pipefail

BUCKET="$1"
DISTRIBUTION="$2"
DIST="$(dirname "$0")/../dist"
NO_CACHE="no-cache"

if [[ -z "${VITE_COGNITO_CLIENT_ID:-}" ]] || ! grep -qF "$VITE_COGNITO_CLIENT_ID" "$DIST"/assets/*.js; then
  echo "apps/web/dist wasn't built with this environment's VITE_* config (see the header)" >&2
  exit 1
fi

aws s3 cp "$DIST/assets" "s3://$BUCKET/assets" --recursive --only-show-errors \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp "$DIST" "s3://$BUCKET" --recursive --only-show-errors --cache-control "$NO_CACHE" \
  --exclude "assets/*" --exclude index.html --exclude sw.js --exclude manifest.webmanifest

# The CLI doesn't know the .webmanifest type.
aws s3 cp "$DIST/manifest.webmanifest" "s3://$BUCKET/manifest.webmanifest" --only-show-errors \
  --cache-control "$NO_CACHE" --content-type application/manifest+json
aws s3 cp "$DIST/sw.js" "s3://$BUCKET/sw.js" --only-show-errors --cache-control "$NO_CACHE"
aws s3 cp "$DIST/index.html" "s3://$BUCKET/index.html" --only-show-errors \
  --cache-control "$NO_CACHE"

id="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths / /index.html /sw.js /manifest.webmanifest --query Invalidation.Id --output text)"
echo "invalidation $id"
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION" --id "$id"
