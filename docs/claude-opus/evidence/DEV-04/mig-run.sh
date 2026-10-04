#!/bin/zsh
# DEV-04 migration check on a throwaway SQL Server container (crm-mig-dev04); prints no secrets.
set -u
S=/private/tmp/claude-501/-Users-vardahei-Vardahei-CRM-V2/03b2cf10-85b0-45bd-8062-9a4b58d2dbd4/scratchpad/mig-dev04
cd /Users/vardahei/Vardahei_CRM_V2
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH" DOTNET_ROOT="$HOME/.dotnet"
name=crm-mig-dev04; port=14339
pw="Mig$(openssl rand -hex 12)Aa1!"; lpw="Lg$(openssl rand -hex 12)Aa1!"
docker run -d --name $name -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$pw" -p 127.0.0.1:$port:1433 mcr.microsoft.com/mssql/server:2022-latest >/dev/null
for i in {1..60}; do
  docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$pw" -Q "SELECT 1" >/dev/null 2>&1 && break
  sleep 2
done
sql() { docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -I -S localhost -U sa -P "$pw" -d crm_mig -W -s '|' "$@"; }
as() { local who=$1; shift; docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -I -S localhost -U $who -P "$lpw" -d crm_mig -W -s '|' "$@"; }
docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$pw" -Q "CREATE DATABASE crm_mig" >/dev/null
for f in mig-legacy-billing.sql seed-audit.sql snapshot.sql state.sql behaviour.sql; do docker cp $S/$f $name:/tmp/$f >/dev/null; done
conn="Server=127.0.0.1,$port;Database=crm_mig;User Id=sa;Password=$pw;TrustServerCertificate=True;Encrypt=False"
ef() { dotnet ef database update "$2" --project src/Modules/$1/Crm.$1/Crm.$1.csproj --context ${1}DbContext --connection "$conn" --no-build 2>&1 | grep -E "Applying|Reverting|No migrations|Done|rror" ; }
migrator() { ASPNETCORE_ENVIRONMENT=Development ConnectionStrings__crm="$conn" dotnet run --project src/Hosts/Crm.Web --no-build -- --migrate-only 2>&1 | grep -E "Applied and verified|rror|xception|51031|lacks" | sed -E 's/Password=[^;]*/Password=***/g'; }

echo "### 1. the previous version's schema (audit Initial, billing up to ChargeRegister) with its data"
ef Audit 20260915081313_Initial
ef Billing 20261003233005_RevisionBoundApprovals
sql -i /tmp/mig-legacy-billing.sql >/dev/null
ef Billing 20261004002311_ChargeRegister
sql -i /tmp/seed-audit.sql
sql -i /tmp/snapshot.sql | tee $S/snapshot-before.txt
echo "### 2. apply DEV-04 (AppendOnlyAudit, ProtectApprovedBilling)"
ef Audit 20261004011342_AppendOnlyAudit
ef Billing 20261004011343_ProtectApprovedBilling
echo "### 3. the migrator: every module, roles, grants, rollback guard, verification (twice: idempotent)"
migrator
migrator
sql -i /tmp/snapshot.sql | tee $S/snapshot-after.txt
diff -q $S/snapshot-before.txt $S/snapshot-after.txt && echo "== data unchanged by the migrations"
sql -i /tmp/state.sql
echo "### 4. what each role may do now (every probe is rolled back)"
sql -Q "CREATE LOGIN mig_worker WITH PASSWORD = N'$lpw', CHECK_POLICY = OFF; CREATE USER mig_worker FOR LOGIN mig_worker; ALTER ROLE crm_worker ADD MEMBER mig_worker;
        CREATE LOGIN mig_web WITH PASSWORD = N'$lpw', CHECK_POLICY = OFF; CREATE USER mig_web FOR LOGIN mig_web; ALTER ROLE crm_web ADD MEMBER mig_web;
        CREATE LOGIN mig_privacy WITH PASSWORD = N'$lpw', CHECK_POLICY = OFF; CREATE USER mig_privacy FOR LOGIN mig_privacy; ALTER ROLE crm_privacy ADD MEMBER mig_privacy;" >/dev/null
for who in mig_worker mig_web mig_privacy; do as $who -i /tmp/behaviour.sql; done
echo "== the previous migrator's grant is refused"
sql -Q "ALTER ROLE db_datawriter ADD MEMBER mig_worker;" 2>&1 | grep -oE "Msg [0-9]+|APPLICATION_ROLE_STAYS_NARROW[^.]*"
echo "### 5. roll the schema back (billing ChargeRegister, audit Initial)"
sql -Q "INSERT INTO audit.IntegrityCheckpoints (FromId, ToId, Entries, PreviousHash, ChainHash, CreatedAt) VALUES (1, 3, 3, NULL, REPLICATE(N'a', 64), SYSDATETIMEOFFSET());" >/dev/null
ef Billing 20261004002311_ChargeRegister
ef Audit 20260915081313_Initial
sql -i /tmp/state.sql
sql -Q "SELECT name AS ArchiveTable FROM sys.tables WHERE SCHEMA_NAME(schema_id) = 'audit' AND name LIKE '%[_]rollback[_]%';"
echo "== after the rollback the roles stay narrow: the worker login has no fixed role and the old grant is still refused"
as mig_worker -Q "SET NOCOUNT ON; SELECT IS_ROLEMEMBER('db_datawriter') AS DataWriter, IS_ROLEMEMBER('crm_worker') AS CrmWorker;"
sql -Q "ALTER ROLE db_datawriter ADD MEMBER mig_worker;" 2>&1 | grep -oE "Msg [0-9]+|APPLICATION_ROLE_STAYS_NARROW[^.]*"
sql -i /tmp/snapshot.sql | tee $S/snapshot-rollback.txt
echo "### 6. forward again after the rollback"
ef Audit 20261004011342_AppendOnlyAudit
ef Billing 20261004011343_ProtectApprovedBilling
migrator
as mig_worker -i /tmp/behaviour.sql
docker rm -f $name >/dev/null && echo "### container $name removed"
