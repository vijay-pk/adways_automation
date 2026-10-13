#!/usr/bin/env bash
# Switch back to a previously built image. Lists releases when called without arguments.
# Usage: ./deploy/rollback.sh <short-sha>
# Database migrations are forward-only and additive; if a release changed the schema in an
# incompatible way, restore its "pre-deploy-<sha>" backup as described in docs/DEPLOYMENT.md.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "Releases (newest last):"; cat deploy/.releases 2>/dev/null || echo "(none recorded)"
  echo; echo "Images available:"; docker images course-tutor --format '{{.Tag}}  {{.CreatedSince}}'
  exit 1
fi

IMAGE="course-tutor:$1"
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "Image ${IMAGE} not found on this server"; exit 1; }
printf 'TUTOR_IMAGE=%s\n' "$IMAGE" > .env
docker compose up -d app
echo "Rolled back to ${IMAGE}. Check: docker compose ps && ./deploy/verify.sh"
