#!/usr/bin/env bash
# The release that runs in an environment (DEV-05): the crmRelease tag that Bicep puts on crm-web, and that release's
# manifest — from the newest deployment record of the environment, else from the release's CI run. Writes
# OUT_DIR/release-manifest.json when it is found; prints why when it is not (the schema guard then treats it as unknown).
# Usage: current-release.sh ENVIRONMENT OUT_DIR   (needs az logged in, gh with GH_TOKEN and actions: read)
set -euo pipefail

environment=${1:?environment}
out=${2:?output directory}
mkdir -p "$out"
sha=$(az containerapp show -g "rg-crm-$environment" -n "ca-crm-web-$environment" --query "tags.crmRelease" -o tsv 2>/dev/null || true)
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "no release is recorded on ca-crm-web-$environment"
  exit 0
fi
echo "release running in $environment: $sha"

record_run=$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=deployment-$environment-$sha&per_page=100" \
  --jq '[.artifacts[] | select(.expired == false)] | sort_by(.created_at) | last | .workflow_run.id // empty')
if [[ -n "$record_run" ]]; then
  gh run download "$record_run" --repo "$GITHUB_REPOSITORY" -n "deployment-$environment-$sha" -D "$out/record"
  if [[ -f "$out/record/release-manifest.json" ]]; then
    cp "$out/record/release-manifest.json" "$out/release-manifest.json"
    exit 0
  fi
fi

ci_run=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --commit "$sha" --json databaseId,conclusion \
  --jq '[.[] | select(.conclusion == "success")][0].databaseId // empty')
if [[ -n "$ci_run" ]] && gh run download "$ci_run" --repo "$GITHUB_REPOSITORY" -n "release-$sha" -D "$out/ci"; then
  cp "$out/ci/release-manifest.json" "$out/release-manifest.json"
  exit 0
fi
echo "the manifest of $sha is no longer available: the running release counts as unknown"
