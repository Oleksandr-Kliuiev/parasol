#!/usr/bin/env bash
# Collects the actual release settings as evidence for EXT-11 (DEV-05): what GitHub and Azure enforce, not what a YAML
# comment claims. Read-only. Run by the repository owner with gh (admin read on the repository) and az (reader on the
# resource groups); the JSON it writes contains names, rules and identifiers, no secret values.
#
# Usage: tools/release/release-settings.sh OWNER/REPO OUT.json
set -euo pipefail

repo=${1:?owner/repo}
out=${2:?output file}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh_json() { # FILE PATH: the API answer, or {"error": ...} when the setting does not exist or cannot be read
  gh api "$2" > "$work/$1.json" 2> "$work/$1.err" || jq -n --arg e "$(cat "$work/$1.err")" '{error: $e}' > "$work/$1.json"
}

gh_json repository "repos/$repo"
gh_json protection "repos/$repo/branches/main/protection"
gh_json rulesets "repos/$repo/rulesets"
gh_json actions "repos/$repo/actions/permissions"
gh_json workflow_permissions "repos/$repo/actions/permissions/workflow"
gh_json environments "repos/$repo/environments"
for environment in test prod; do
  gh_json "env-$environment" "repos/$repo/environments/$environment"
  gh_json "env-$environment-policies" "repos/$repo/environments/$environment/deployment-branch-policies"
  gh_json "env-$environment-variables" "repos/$repo/environments/$environment/variables"
done

for environment in test prod; do
  rg="rg-crm-$environment"
  az identity federated-credential list -g "$rg" --identity-name "id-crm-github-$environment" \
    --query "[].{name:name, issuer:issuer, subject:subject, audiences:audiences}" -o json > "$work/oidc-$environment.json" 2>/dev/null \
    || echo '{"error": "cannot read the federated credentials"}' > "$work/oidc-$environment.json"
  principal=$(az identity show -g "$rg" -n "id-crm-github-$environment" --query principalId -o tsv 2>/dev/null || true)
  if [[ -n "$principal" ]]; then
    az role assignment list --assignee "$principal" --all --query "[].{role:roleDefinitionName, scope:scope}" -o json > "$work/roles-$environment.json"
  else
    echo '{"error": "identity not found"}' > "$work/roles-$environment.json"
  fi
done

jq -n \
  --arg repo "$repo" --arg collectedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg collectedBy "$(gh api user --jq .login 2>/dev/null || echo unknown)" \
  --slurpfile repository "$work/repository.json" --slurpfile protection "$work/protection.json" --slurpfile rulesets "$work/rulesets.json" \
  --slurpfile actions "$work/actions.json" --slurpfile workflowPermissions "$work/workflow_permissions.json" \
  --slurpfile envTest "$work/env-test.json" --slurpfile envProd "$work/env-prod.json" \
  --slurpfile policiesTest "$work/env-test-policies.json" --slurpfile policiesProd "$work/env-prod-policies.json" \
  --slurpfile variablesTest "$work/env-test-variables.json" --slurpfile variablesProd "$work/env-prod-variables.json" \
  --slurpfile oidcTest "$work/oidc-test.json" --slurpfile oidcProd "$work/oidc-prod.json" \
  --slurpfile rolesTest "$work/roles-test.json" --slurpfile rolesProd "$work/roles-prod.json" \
  '{
    repository: $repo, collectedAt: $collectedAt, collectedBy: $collectedBy,
    defaultBranch: $repository[0].default_branch,
    mainProtection: {
      requiredStatusChecks: ($protection[0].required_status_checks.checks // $protection[0].required_status_checks.contexts // $protection[0].error),
      strict: $protection[0].required_status_checks.strict,
      requiredReviews: $protection[0].required_pull_request_reviews.required_approving_review_count,
      enforceAdmins: $protection[0].enforce_admins.enabled,
      allowForcePushes: $protection[0].allow_force_pushes.enabled
    },
    rulesets: ($rulesets[0] | if type == "array" then map({name, enforcement, target}) else . end),
    actions: { allowed: $actions[0].allowed_actions, defaultWorkflowPermissions: $workflowPermissions[0].default_workflow_permissions,
               canApprovePullRequests: $workflowPermissions[0].can_approve_pull_request_reviews },
    environments: {
      test: { protectionRules: $envTest[0].protection_rules, branchPolicy: $envTest[0].deployment_branch_policy,
              branchPolicies: $policiesTest[0].branch_policies, variables: ($variablesTest[0].variables // [] | map(.name)) },
      prod: { protectionRules: $envProd[0].protection_rules, branchPolicy: $envProd[0].deployment_branch_policy,
              branchPolicies: $policiesProd[0].branch_policies, variables: ($variablesProd[0].variables // [] | map(.name)) }
    },
    azure: { oidc: { test: $oidcTest[0], prod: $oidcProd[0] }, roles: { test: $rolesTest[0], prod: $rolesProd[0] } }
  }' > "$out"

python3 "$(dirname "$0")/release.py" scan-secrets "$out"
echo "release settings of $repo written to $out"
