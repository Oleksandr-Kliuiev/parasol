#!/bin/zsh
# DEV-06 on the real hosts: crm-web migrates a throwaway database, crm-worker runs on it; SQL is paused and resumed.
set -u
S=/private/tmp/claude-501/-Users-vardahei-Vardahei-CRM-V2/03b2cf10-85b0-45bd-8062-9a4b58d2dbd4/scratchpad/worker-health-dev06
cd /Users/vardahei/Vardahei_CRM_V2
export PATH="$HOME/.dotnet:$PATH" DOTNET_ROOT="$HOME/.dotnet"
name=crm-health-dev06; port=14342; pw="Wh$(openssl rand -hex 12)Aa1!"
docker run -d --name $name -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$pw" -p 127.0.0.1:$port:1433 mcr.microsoft.com/mssql/server:2022-latest >/dev/null 2>&1
for i in {1..60}; do docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$pw" -Q "SELECT 1" >/dev/null 2>&1 && break; sleep 2; done
conn="Server=127.0.0.1,$port;Database=crm_health;User Id=sa;Password=$pw;TrustServerCertificate=True;Encrypt=False"
probe() { local t0=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000'); local out=$(curl -s -m 15 -o /tmp/dev06-body -w '%{http_code}' "http://localhost:5192$1"); local t1=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000'); echo "$1 -> $out $(cat /tmp/dev06-body) ($((t1 - t0)) ms)"; }
echo "== 1. migrate the empty database (crm-web --migrate-only)"
ASPNETCORE_ENVIRONMENT=Development ConnectionStrings__crm="$conn" dotnet run --project src/Hosts/Crm.Web --no-build -- --migrate-only 2>&1 | grep -E "Applied and verified|rror" | sed -E 's/Password=[^;]*/Password=***/g'
echo "== 2. start crm-worker"
ASPNETCORE_ENVIRONMENT=Development dotnet run --project src/Hosts/Crm.Worker --no-build --launch-profile http -- --urls http://localhost:5192 "--ConnectionStrings:crm=$conn" > $S/worker.log 2>&1 &
worker=$!
for i in {1..90}; do curl -s -o /dev/null -w '%{http_code}' http://localhost:5192/health/live 2>/dev/null | grep -q 200 && break; sleep 1; done
sleep 8
probe /health/live; probe /health/ready
echo "heartbeats stored:"; docker exec $name /opt/mssql-tools18/bin/sqlcmd -C -I -S localhost -U sa -P "$pw" -d crm_health -W -s '|' -Q "SET NOCOUNT ON; SELECT Component, DATEDIFF(second, BeatAt, SYSDATETIMEOFFSET()) AS AgeSeconds, Detail FROM integration.WorkerHeartbeats"
echo "== 3. SQL paused (unreachable, connections hang)"
docker pause $name >/dev/null
sleep 2
probe /health/live; probe /health/ready; probe /health/ready
sleep 20
probe /health/live
echo "== 4. SQL resumed"
docker unpause $name >/dev/null
for i in {1..30}; do code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:5192/health/ready); [[ $code == 200 ]] && break; sleep 1; done
probe /health/ready; probe /health/live
kill $worker; wait $worker 2>/dev/null
grep -c "The outbox heartbeat could not be stored" $S/worker.log | xargs echo "heartbeat store failures logged while SQL was away:"
docker rm -f $name >/dev/null && echo "== container $name removed"
