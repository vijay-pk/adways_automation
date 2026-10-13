#!/usr/bin/env bash
# Build and release a version on the VPS with a pre-deploy backup and health-checked rollout.
# Usage (from the repo directory on the VPS):  ./deploy/deploy.sh [git-ref]   (default: origin/main)
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-origin/main}"
DOMAIN="${TUTOR_DOMAIN:-automation.adwaysacademy.com}"

[ -f server/.env.production ] || { echo "server/.env.production is missing (copy server/.env.production.example)"; exit 1; }

git fetch --tags origin
git checkout --detach "$REF"
SHA="$(git rev-parse --short HEAD)"
IMAGE="course-tutor:${SHA}"
PREVIOUS="$(grep -s '^TUTOR_IMAGE=' .env | cut -d= -f2 || true)"

echo "==> Building ${IMAGE}"
TUTOR_IMAGE="$IMAGE" docker compose build app

echo "==> Backing up database before migrating"
./deploy/backup.sh "pre-deploy-${SHA}"

echo "==> Starting ${IMAGE} (runs pending migrations on start)"
printf 'TUTOR_IMAGE=%s\n' "$IMAGE" > .env
docker compose up -d --remove-orphans

echo "==> Waiting for the app to become healthy"
for i in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)" 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 3
done
if [ "$status" != "healthy" ]; then
  echo "!! App did not become healthy. Recent logs:"
  docker compose logs --tail 80 app || true
  if [ -n "$PREVIOUS" ]; then
    echo "!! Rolling back to ${PREVIOUS}"
    printf 'TUTOR_IMAGE=%s\n' "$PREVIOUS" > .env
    docker compose up -d app
  fi
  exit 1
fi

echo "${SHA} $(date -u +%FT%TZ)" >> deploy/.releases
echo "==> Released ${IMAGE}"
./deploy/verify.sh "$DOMAIN" || echo "!! Verification reported problems (see above)"
