#!/bin/zsh
# DEV-02 migration check on a throwaway SQL Server container (crm-mig-dev02); prints no secrets.
set -u
S=/private/tmp/claude-501/-Users-vardahei-Vardahei-CRM-V2/03b2cf10-85b0-45bd-8062-9a4b58d2dbd4/scratchpad/mig-dev02
cd /Users/vardahei/Vardahei_CRM_V2
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH" DOTNET_ROOT="$HOME/.dotnet"
name=crm-mig-dev02; port=14337
pw="Mig$(openssl rand -hex 12)Aa1!"
docker run -d --name $name -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$pw" -p 127.0.0.1:$port:1433 mcr.microsoft.com/mssql/server:2022-latest >/dev/null
for i in {1..60}; do
  docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$pw" -Q "SELECT 1" >/dev/null 2>&1 && break
  sleep 2
done
sql() { docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -I -S localhost -U sa -P "$pw" -d crm_mig -W -s '|' "$@"; }
docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$pw" -Q "CREATE DATABASE crm_mig" >/dev/null
for f in mig-legacy-runs.sql mig-check.sql mig-old-app.sql; do docker cp $S/$f $name:/tmp/$f >/dev/null; done
conn="Server=127.0.0.1,$port;Database=crm_mig;User Id=sa;Password=$pw;TrustServerCertificate=True;Encrypt=False"
ef() { dotnet ef database update "$1" --project src/Modules/Billing/Crm.Billing/Crm.Billing.csproj --context BillingDbContext --connection "$conn" --no-build 2>&1 | grep -E "Applying|Reverting|No migrations|Done|rror" ; }

echo "### 1. previous schema (migrations up to ChargeIdentity, i.e. DEV-01)"
ef 20261003230254_ChargeIdentity
echo "### 2. synthetic runs in the previous shape"
sql -i /tmp/mig-legacy-runs.sql
sql -i /tmp/mig-check.sql
echo "### 3. apply RevisionBoundApprovals"
ef 20261003233005_RevisionBoundApprovals
sql -i /tmp/mig-check.sql
echo "### 4. the previous version writes during the rollback window (its column list)"
sql -i /tmp/mig-old-app.sql
echo "### 5. apply again (must be a no-op)"
ef 20261003233005_RevisionBoundApprovals
echo "### 6. roll the schema back to ChargeIdentity"
ef 20261003230254_ChargeIdentity
sql -i /tmp/mig-check.sql
echo "== archived acts"
sql -Q "DECLARE @t sysname = (SELECT TOP 1 name FROM sys.tables WHERE SCHEMA_NAME(schema_id) = 'billing' AND name LIKE 'BillingApprovals[_]rollback[_]%'); DECLARE @q nvarchar(max) = CONCAT(N'SELECT COUNT(*) AS Acts, SUM(CASE WHEN InvalidationReason = ''Migrated'' THEN 1 ELSE 0 END) AS Migrated FROM [billing].', QUOTENAME(@t)); EXEC sp_executesql @q;"
echo "### 7. forward again after the rollback"
ef 20261003233005_RevisionBoundApprovals
sql -i /tmp/mig-check.sql
docker rm -f $name >/dev/null && echo "### container $name removed"
