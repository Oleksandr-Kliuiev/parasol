#!/usr/bin/env bash
# Rollback check (DEV-05-AC04): does the previous release still work on the schema of this one? Migrates a throwaway SQL
# Server database with the current sources, then runs the end-to-end suite of the previous release — its own crm-web,
# crm-worker, SPA and tests, from a git worktree — against that database. This is what a rollback does in Azure: the
# schema stays as the newer release left it (deploy.sh --rollback runs no migrations) and the older images run on it.
#
# Usage: tools/release/rollback-compat.sh PREVIOUS_SHA [playwright args...]
#   ROLLBACK_SCHEMA_FROM=<sha>  migrate with that commit instead of the current sources (to check an older pair)
# Local and synthetic only: a container crm-rollback-<sha7> on 127.0.0.1:14341 and a worktree in a temporary folder, both
# removed at the end. Needs docker, git, dotnet (global.json SDK), node/npm and the Playwright browsers.
set -euo pipefail

previous=${1:?previous release commit}
shift
root=$(git rev-parse --show-toplevel)
current=$(git -C "$root" rev-parse HEAD)
git -C "$root" cat-file -e "$previous^{commit}"
name="crm-rollback-${previous:0:7}"
port=${ROLLBACK_SQL_PORT:-14341}
password="Rb-$(openssl rand -hex 12)Aa1!"
worktree="$(mktemp -d)/previous"
schema_from=${ROLLBACK_SCHEMA_FROM:-}
schema_tree=""
connection="Server=127.0.0.1,$port;Database=crm_e2e_rollback;User Id=sa;Password=$password;TrustServerCertificate=True;Encrypt=False"

cleanup() {
  docker rm -f "$name" > /dev/null 2>&1 || true
  git -C "$root" worktree remove --force "$worktree" > /dev/null 2>&1 || true
  [[ -z "$schema_tree" ]] || git -C "$root" worktree remove --force "$schema_tree" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== schema from ${schema_from:-$current (current sources, uncommitted changes included)}, previous $previous"
docker run -d --name "$name" -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=$password" -p "127.0.0.1:$port:1433" \
  mcr.microsoft.com/mssql/server:2022-latest > /dev/null
for _ in $(seq 1 60); do
  docker exec "$name" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$password" -Q "SELECT 1" > /dev/null 2>&1 && break
  sleep 2
done

migrator_root="$root"
if [[ -n "$schema_from" ]]; then
  schema_tree="$(mktemp -d)/schema"
  git -C "$root" worktree add --detach "$schema_tree" "$schema_from" > /dev/null
  migrator_root="$schema_tree"
fi
echo "== 1. the newer release migrates the database"
(cd "$migrator_root" && ASPNETCORE_ENVIRONMENT=Development ConnectionStrings__crm="$connection" \
  dotnet run --project src/Hosts/Crm.Web -- --migrate-only 2>&1 | grep -E "Applied|Migrated|rror" | sed -E 's/Password=[^;]*/Password=***/g' | tail -3)
# The newest migration of every schema, as the previous release will find it.
docker exec -i "$name" /opt/mssql-tools18/bin/sqlcmd -C -I -S localhost -U sa -P "$password" -d crm_e2e_rollback -W -s "|" \
  -i /dev/stdin < "$root/tools/release/newest-migrations.sql"

echo "== 2. the previous release runs its own end-to-end suite on that schema"
git -C "$root" worktree add --detach "$worktree" "$previous" > /dev/null
cd "$worktree/web"
npm ci --no-audit --no-fund > /dev/null
npm run build > /dev/null
E2E_SQL="$connection" npx playwright test "$@"
