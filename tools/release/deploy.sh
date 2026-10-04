#!/usr/bin/env bash
# Deploys the images of a release manifest to one environment (DEV-05, docs/adr/ADR-015-release-pipeline.md):
#   1. the migration job runs the crm-web image of the release by digest, with both identities (DEV-04); a failure stops
#      here, before any revision or traffic changes. A rollback runs no migrations: the schema is already at least as new
#      and expand/contract keeps the older image working on it.
#   2. Bicep with the release digests: a new crm-web revision under the label "candidate" without traffic, the new worker;
#   3. smoke test of the candidate, and every container must run exactly the manifest digest;
#   4. traffic to the candidate, smoke test of the public address (traffic goes back if it fails), deployment record.
# Usage: deploy.sh ENVIRONMENT MANIFEST OUT_DIR [--rollback]
# Needs az (logged in), jq, curl, python3, and CRM_ENTRA_TENANT_ID, CRM_ENTRA_CLIENT_ID_<ENV>, CRM_ENABLE_* from the
# environment of the workflow. Prints no secret: it handles none (OIDC, managed identities, Key Vault references).
set -euo pipefail

environment=${1:?environment (test|prod)}
manifest=${2:?release manifest}
out=${3:?output directory}
mode=${4:-}
[[ "$environment" == test || "$environment" == prod ]] || { echo "unknown environment $environment" >&2; exit 2; }
[[ -z "$mode" || "$mode" == --rollback ]] || { echo "unknown option $mode" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
mkdir -p "$out"

rg="rg-crm-$environment"
web_app="ca-crm-web-$environment"
worker_app="ca-crm-worker-$environment"
job="caj-crm-migrate-$environment"
registry=$(az acr list -g "$rg" --query "[0].loginServer" -o tsv)
[[ -n "$registry" ]] || { echo "no container registry in $rg" >&2; exit 1; }
web_digest=$(jq -er '.images.web.digest' "$manifest")
worker_digest=$(jq -er '.images.worker.digest' "$manifest")
web_image="$registry/crm-web@$web_digest"
worker_image="$registry/crm-worker@$worker_digest"

# The release digests must be in this environment's registry (prod gets them by import, never by a new build).
for image in "crm-web@$web_digest" "crm-worker@$worker_digest"; do
  found=$(az acr repository show -n "${registry%%.*}" --image "$image" --query digest -o tsv 2>/dev/null || true)
  [[ "$found" == "${image#*@}" ]] || { echo "$image is not in $registry" >&2; exit 1; }
done

if [[ "$mode" != --rollback ]]; then
  web_identity="id-crm-app-$environment"
  worker_identity="id-crm-worker-$environment"
  web_client=$(az identity show -g "$rg" -n "$web_identity" --query clientId -o tsv)
  worker_client=$(az identity show -g "$rg" -n "$worker_identity" --query clientId -o tsv 2>/dev/null ||
    az identity create -g "$rg" -n "$worker_identity" --tags application=vardahei-crm environment="$environment" --query clientId -o tsv)
  # --args as well: after the bootstrap deployment the job still has the placeholder's empty arguments.
  az containerapp job update -g "$rg" -n "$job" --image "$web_image" --args "--migrate-only" \
    --set-env-vars "Database__WebIdentityName=$web_identity" "Database__WebIdentityClientId=$web_client" \
                   "Database__WorkerIdentityName=$worker_identity" "Database__WorkerIdentityClientId=$worker_client" \
                   "Deployment__Environment=$environment" \
    --remove-env-vars Database__AppIdentityName Database__AppIdentityClientId > /dev/null
  execution=$(az containerapp job start -g "$rg" -n "$job" --query name -o tsv)
  status=""
  for _ in $(seq 1 90); do
    status=$(az containerapp job execution show -g "$rg" -n "$job" --job-execution-name "$execution" --query properties.status -o tsv)
    echo "migration $execution: $status"
    [[ "$status" == Succeeded ]] && break
    if [[ "$status" == Failed || "$status" == Stopped ]]; then
      echo "the migration failed: no revision and no traffic was changed" >&2
      exit 1
    fi
    sleep 10
  done
  [[ "$status" == Succeeded ]] || { echo "the migration timed out: no revision and no traffic was changed" >&2; exit 1; }
fi

stable=$(az containerapp revision list -g "$rg" -n "$web_app" --query "[?properties.trafficWeight==\`100\`].name | [0]" -o tsv 2>/dev/null || true)
client_var="CRM_ENTRA_CLIENT_ID_$(tr '[:lower:]' '[:upper:]' <<< "$environment")"
CRM_RELEASE_COMMIT=$(jq -er '.commit' "$manifest")
export CRM_WEB_IMAGE_DIGEST="$web_digest" CRM_WORKER_IMAGE_DIGEST="$worker_digest" CRM_WEB_STABLE_REVISION="$stable" CRM_RELEASE_COMMIT
export CRM_BOOTSTRAP=false
outputs=$(az deployment group create -g "$rg" --name "crm-$environment-$(date -u +%Y%m%d%H%M%S)" \
  --template-file "$root/infra/main.bicep" --parameters "$root/infra/env/$environment.bicepparam" \
  --query properties.outputs -o json)
public_url=$(jq -er '.webUrl.value' <<< "$outputs")
candidate_url=$(jq -er '.webCandidateUrl.value' <<< "$outputs")
latest=$(az containerapp show -g "$rg" -n "$web_app" --query properties.latestRevisionName -o tsv)
smoke_args=()
[[ -n "${!client_var:-}" ]] && smoke_args=(--entra-client-id "${!client_var}")

# The worker has no traffic to hold back: its single revision is replaced once the new one runs.
worker_revision=$(az containerapp show -g "$rg" -n "$worker_app" --query properties.latestRevisionName -o tsv)
worker_state=""
for _ in $(seq 1 60); do
  worker_state=$(az containerapp revision show -g "$rg" -n "$worker_app" --revision "$worker_revision" --query properties.runningState -o tsv)
  [[ "$worker_state" == Running* ]] && break
  sleep 10
done
[[ "$worker_state" == Running* ]] || { echo "crm-worker revision $worker_revision is $worker_state" >&2; exit 1; }

running_web=$(az containerapp revision show -g "$rg" -n "$web_app" --revision "$latest" --query "properties.template.containers[0].image" -o tsv)
running_worker=$(az containerapp revision show -g "$rg" -n "$worker_app" --revision "$worker_revision" --query "properties.template.containers[0].image" -o tsv)
migration_image=$(az containerapp job show -g "$rg" -n "$job" --query "properties.template.containers[0].image" -o tsv)
[[ "$running_web" == "$web_image" ]] || { echo "crm-web $latest runs $running_web, the release is $web_image" >&2; exit 1; }
[[ "$running_worker" == "$worker_image" ]] || { echo "crm-worker $worker_revision runs $running_worker, the release is $worker_image" >&2; exit 1; }

if [[ -n "$stable" && "$latest" != "$stable" ]]; then
  if ! "$here/smoke.sh" "$candidate_url" "$out/smoke-candidate.json" ${smoke_args[@]+"${smoke_args[@]}"}; then
    echo "the candidate $latest failed its smoke test: the traffic stays on $stable" >&2
    exit 1
  fi
  az containerapp ingress traffic set -g "$rg" -n "$web_app" --revision-weight "$latest=100" > /dev/null
fi

if ! "$here/smoke.sh" "$public_url" "$out/smoke.json" ${smoke_args[@]+"${smoke_args[@]}"}; then
  if [[ -n "$stable" && "$latest" != "$stable" ]]; then
    az containerapp ingress traffic set -g "$rg" -n "$web_app" --revision-weight "$stable=100" > /dev/null
    echo "the public smoke test failed after the switch: the traffic is back on $stable" >&2
  fi
  exit 1
fi

record_args=(--environment "$environment" --web-image "$running_web" --worker-image "$running_worker"
  --smoke "$out/smoke.json" --web-revision "$latest" --worker-revision "$worker_revision" --out "$out/deployment-$environment.json")
if [[ "$mode" == --rollback ]]; then
  record_args+=(--rollback)
else
  record_args+=(--migration-image "$migration_image")
fi
python3 "$here/release.py" deployment-record "$manifest" "${record_args[@]}"
