#!/bin/sh
set -eu
MSSQL_SA_PASSWORD=$(cat /run/secrets/sql-sa-password)
export MSSQL_SA_PASSWORD
exec /opt/mssql/bin/sqlservr
