#!/usr/bin/env bash
# Backs up the tutor schema (pg_dump, custom format) and all transcript originals.
# Usage: ./deploy/backup.sh [label]      Cron (daily 02:30):
#   30 2 * * * cd /opt/course-tutor && ./deploy/backup.sh nightly >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="${1:-manual}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-${LABEL}"
DEST="backups/${STAMP}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB_URL="$(grep -E '^BACKUP_DATABASE_URL=' server/.env.production | cut -d= -f2-)"
[ -n "$DB_URL" ] || { echo "BACKUP_DATABASE_URL is not set in server/.env.production"; exit 1; }

mkdir -p "$DEST"
chown 1000:1000 backups "$DEST" 2>/dev/null || true

echo "==> Dumping schema 'tutor'"
# postgres:17 client works with Supabase Postgres 15 and 17.
docker run --rm -v "$PWD/$DEST:/out" postgres:17 \
  pg_dump --format=custom --no-owner --no-privileges --schema=tutor --file=/out/database.dump "$DB_URL"

echo "==> Copying transcript originals"
if docker compose ps -q app >/dev/null 2>&1 && [ -n "$(docker compose ps -q app)" ]; then
  docker compose exec -T app node dist/cli/backupTranscripts.js "/backups/${STAMP}/transcripts"
else
  echo "(app not running; skipped transcript files)"
fi

tar -czf "backups/${STAMP}.tar.gz" -C backups "$STAMP" && rm -rf "$DEST"
find backups -maxdepth 1 -name '*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "==> Backup written: backups/${STAMP}.tar.gz"
echo "    Copy backups off the server regularly (e.g. rclone/scp to another provider)."
