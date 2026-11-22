#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into DATABASE_URL.
#
#   DATABASE_URL=postgres://.../einvoicing_restore npm run restore -- backups/einvoicing-20261122T030000Z.dump
#
# Restore into a NEW, empty database first and check it (see docs/operations.md,
# "Recovery"), then point the app at it. Restoring over a live database needs
# --replace, and stops everything that uses it.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL (the database to restore into)}"
file="${1:?Give the dump file}"
replace="${2:-}"

if [ -f "$file.sha256" ]; then
  ( cd "$(dirname "$file")" && sha256sum --check --status "$(basename "$file").sha256" ) || { echo "Checksum does not match: $file is damaged" >&2; exit 1; }
fi

tables="$(psql "$DATABASE_URL" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [ "$tables" != "0" ] && [ "$replace" != "--replace" ]; then
  echo "The target database is not empty ($tables tables). Restore into an empty database, or add --replace." >&2
  exit 1
fi

pg_restore --no-owner --no-privileges --clean --if-exists --exit-on-error --dbname="$DATABASE_URL" "$file"

docs="$(psql "$DATABASE_URL" -Atc 'select count(*) from documents')"
tenants="$(psql "$DATABASE_URL" -Atc 'select count(*) from tenants')"
echo "Restored $file: $tenants business(es), $docs document(s)."
echo "Check: start the app against this database with the same KEY_ENCRYPTION_KEY and open a document's PDF."
