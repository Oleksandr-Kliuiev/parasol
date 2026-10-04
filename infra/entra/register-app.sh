#!/usr/bin/env bash
# Registers the "Vardahei CRM" application in Entra ID for one environment (docs/05-integrations.md §1).
# Run by a Global/Privileged Role Administrator:  ./register-app.sh test https://crm-test.example.no [worker-identity-principal-id]
# The optional third argument is the principal id of the crm-worker managed identity id-crm-worker-<env> (created by the
# deployment pipeline); it receives the Microsoft Graph application permissions the worker's directory jobs need:
# User.Read.All for the hourly user synchronization, Application.Read.All and GroupMember.Read.All for the role
# synchronization every two minutes (DEV-10, docs/adr/ADR-019-sessions-and-privilege-freshness.md).
# Creates: app registration (single-tenant, web), App Roles, service principal with assignment required,
# security groups CRM-<Role>-<env> and role assignments to those groups. Idempotent for re-runs.
set -euo pipefail

ENV_NAME="${1:?environment (test|prod)}"
BASE_URL="${2:?base URL, e.g. https://crm.example.no}"
APP_NAME="Vardahei CRM (${ENV_NAME})"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
USER_READ_DELEGATED="e1fe6dd8-ba31-4d61-89e7-88639da4683d"   # User.Read
APP_IDENTITY_PRINCIPAL_ID="${3:-}"

role_json() { # value displayName description
  local id
  id=$(python3 -c "import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, 'vardahei-crm/' + sys.argv[1]))" "$1")
  printf '{"allowedMemberTypes":["User"],"description":"%s","displayName":"%s","id":"%s","isEnabled":true,"value":"%s"}' "$3" "$2" "$id" "$1"
}

ROLES="[$(role_json Crm.Admin 'CRM Administrator' 'Configures the CRM, integrations and reference data'),\
$(role_json Crm.Management 'CRM Management' 'Reads all data including margins, approves discounts and large invoices'),\
$(role_json Crm.Sales 'CRM Sales' 'Leads, opportunities, quotes, customers and contracts'),\
$(role_json Crm.Technician 'CRM Technician' 'Customer overview without finance, tickets, devices, time'),\
$(role_json Crm.ServiceLead 'CRM Service lead' 'Technician rights plus time approval and SLA reports'),\
$(role_json Crm.Finance 'CRM Finance' 'Billing runs, price lists, cost prices, PowerOffice export'),\
$(role_json Crm.ReadOnly 'CRM Read-only' 'Read access without finance fields')]"

APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [[ -z "$APP_ID" ]]; then
  echo "Creating app registration '$APP_NAME'"
  APP_ID=$(az ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "${BASE_URL}/signin-oidc" \
    --query appId -o tsv)
fi

OBJECT_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/${OBJECT_ID}" --headers "Content-Type=application/json" --body "{
  \"appRoles\": ${ROLES},
  \"web\": {
    \"redirectUris\": [\"${BASE_URL}/signin-oidc\"],
    \"logoutUrl\": \"${BASE_URL}/signout-oidc\",
    \"implicitGrantSettings\": { \"enableIdTokenIssuance\": false, \"enableAccessTokenIssuance\": false }
  },
  \"api\": { \"requestedAccessTokenVersion\": 2 },
  \"optionalClaims\": { \"idToken\": [{ \"name\": \"xms_cc\" }, { \"name\": \"login_hint\" }] },
  \"requiredResourceAccess\": [{
    \"resourceAppId\": \"${GRAPH_APP_ID}\",
    \"resourceAccess\": [
      { \"id\": \"${USER_READ_DELEGATED}\", \"type\": \"Scope\" }
    ]
  }]
}"

SP_ID=$(az ad sp list --filter "appId eq '${APP_ID}'" --query "[0].id" -o tsv)
if [[ -z "$SP_ID" ]]; then
  SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
fi
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/servicePrincipals/${SP_ID}" \
  --headers "Content-Type=application/json" --body '{"appRoleAssignmentRequired": true}'

for ROLE in Admin Management Sales Technician ServiceLead Finance ReadOnly; do
  GROUP="CRM-${ROLE}-${ENV_NAME}"
  GROUP_ID=$(az ad group list --display-name "$GROUP" --query "[0].id" -o tsv)
  if [[ -z "$GROUP_ID" ]]; then
    GROUP_ID=$(az ad group create --display-name "$GROUP" --mail-nickname "crm-$(echo "$ROLE" | tr "[:upper:]" "[:lower:]")-${ENV_NAME}" --query id -o tsv)
  fi
  ROLE_ID=$(python3 -c "import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, 'vardahei-crm/Crm.' + sys.argv[1]))" "$ROLE")
  EXISTING=$(az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
    --query "value[?principalId=='${GROUP_ID}' && appRoleId=='${ROLE_ID}'] | length(@)" -o tsv)
  if [[ "$EXISTING" == "0" ]]; then
    az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/${SP_ID}/appRoleAssignedTo" \
      --headers "Content-Type=application/json" \
      --body "{\"principalId\":\"${GROUP_ID}\",\"resourceId\":\"${SP_ID}\",\"appRoleId\":\"${ROLE_ID}\"}" >/dev/null
  fi
  echo "Group ${GROUP} -> Crm.${ROLE}"
done

if [[ -n "$APP_IDENTITY_PRINCIPAL_ID" ]]; then
  GRAPH_SP_ID=$(az ad sp show --id "$GRAPH_APP_ID" --query id -o tsv)
  # Application permissions of the managed identity, not of the app registration; ids are looked up by name.
  for PERMISSION in User.Read.All Application.Read.All GroupMember.Read.All; do
    ROLE_ID=$(az ad sp show --id "$GRAPH_APP_ID" --query "appRoles[?value=='${PERMISSION}' && contains(allowedMemberTypes, 'Application')].id | [0]" -o tsv)
    [[ -n "$ROLE_ID" ]] || { echo "Microsoft Graph has no application permission ${PERMISSION}" >&2; exit 1; }
    HAS_ROLE=$(az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/${APP_IDENTITY_PRINCIPAL_ID}/appRoleAssignments" \
      --query "value[?appRoleId=='${ROLE_ID}'] | length(@)" -o tsv)
    if [[ "$HAS_ROLE" == "0" ]]; then
      az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/${APP_IDENTITY_PRINCIPAL_ID}/appRoleAssignments" \
        --headers "Content-Type=application/json" \
        --body "{\"principalId\":\"${APP_IDENTITY_PRINCIPAL_ID}\",\"resourceId\":\"${GRAPH_SP_ID}\",\"appRoleId\":\"${ROLE_ID}\"}" >/dev/null
    fi
    echo "Managed identity ${APP_IDENTITY_PRINCIPAL_ID} -> Microsoft Graph ${PERMISSION}"
  done
fi

cat <<INFO

Done. Next steps (docs/runbooks/01-first-deployment.md):
  1. Grant admin consent for Microsoft Graph permissions:
       az ad app permission admin-consent --id ${APP_ID}
  2. Create the credential certificate in Key Vault and upload its public key to the app registration.
  3. Set the deployment variable CRM_ENTRA_CLIENT_ID_$(echo "$ENV_NAME" | tr "[:lower:]" "[:upper:]")=${APP_ID}
  4. Add people to the CRM-<Role>-${ENV_NAME} groups (the Admin group via PIM).
INFO
