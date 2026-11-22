#!/usr/bin/env bash
# Back up the database: a compressed pg_dump with a checksum, old dumps pruned,
# and (optionally) a copy sent off the machine.
#
#   DATABASE_URL=postgres://... BACKUP_DIR=/backups npm run backup
#
#   BACKUP_DIR          where dumps go (default ./backups)
#   BACKUP_KEEP_DAYS    delete local dumps older than this (default 14)
#   BACKUP_S3_URI       optional, e.g. s3://my-backups/einvoicing/ (needs the aws CLI;
#                       set AWS_ENDPOINT_URL for R2, Spaces or MinIO)
#
# The dump holds signed documents, customers and *encrypted* certificate keys.
# It is useless without KEY_ENCRYPTION_KEY for the certificates, so keep the
# key somewhere else (a password manager or key service), never next to the dumps.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL}"
dir="${BACKUP_DIR:-./backups}"
keep="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$dir/einvoicing-$stamp.dump"

# Custom format: compressed, and pg_restore can restore single tables.
pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$file.partial" "$DATABASE_URL"
mv "$file.partial" "$file"
( cd "$dir" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )

# A dump that cannot be listed is not a backup.
pg_restore --list "$file" > /dev/null

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$file" "$BACKUP_S3_URI" --only-show-errors
  aws s3 cp "$file.sha256" "$BACKUP_S3_URI" --only-show-errors
fi

find "$dir" -name 'einvoicing-*.dump*' -type f -mtime +"$keep" -delete

size="$(du -h "$file" | cut -f1)"
echo "Backup written: $file ($size)"
