#!/bin/bash
# One-time generation of the server-side secrets of the Atlas deployment (docs/deploy/DEPLOY.md). Root only; never prints a value.
# Creates /etc/atlas-admin/db.env and generated.env if absent; an existing file is kept (no rotation).
set -euo pipefail
umask 077
D=/etc/atlas-admin
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
install -d -m 0700 -o root -g root "$D"
hex() { openssl rand -hex "$1"; }
if [ ! -f "$D/db.env" ]; then printf 'POSTGRES_PASSWORD=%s\n' "$(hex 24)" > "$D/db.env"; echo "db.env created"; fi
if [ ! -f "$D/generated.env" ]; then
  pw=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$D/db.env")
  {
    printf 'ATLAS_OWNER_DATABASE_URL=postgresql://postgres:%s@atlas-admin-db:5432/atlas\n' "$pw"
    printf 'ATLAS_APP_PASSWORD=%s\n' "$(hex 24)"
    printf 'ATLAS_RUNNER_PASSWORD=%s\n' "$(hex 24)"
    printf 'ATLAS_PO_RUNNER_PASSWORD=%s\n' "$(hex 24)"
    printf 'ATLAS_REVAL_READER_PASSWORD=%s\n' "$(hex 24)"
    printf 'ATLAS_CORRELATION_CURSOR_SECRET=%s\n' "$(hex 32)"
    printf 'ATLAS_PROXY_SECRET=%s\n' "$(hex 32)"
    printf 'OAUTH2_PROXY_COOKIE_SECRET=%s\n' "$(openssl rand -base64 32 | tr -- '+/' '-_')"
  } > "$D/generated.env"
  echo "generated.env created"
fi
chmod 0600 "$D"/*.env
ls "$D"
