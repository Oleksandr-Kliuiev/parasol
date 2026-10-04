param location string
param environmentName string
param tags object

// crm-web: SQL role crm_web, its sign-in certificate, the Data Protection key and blobs, Graph for the documents tab and
// quote e-mail. No provider secrets (DEV-04, docs/runbooks/08-database-permissions.md).
resource app 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-crm-app-${environmentName}'
  location: location
  tags: tags
}

// crm-worker: SQL role crm_worker, the provider secrets (PowerOffice, Atera), Graph for the user sync, the digest e-mail and
// SharePoint folders. Created by the deployment pipeline before the migrations run, so its database user exists in time.
resource worker 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-crm-worker-${environmentName}'
  location: location
  tags: tags
}

// crm-migrate job: SQL Entra administrator, applies migrations, roles and grants, and maps the identities to their roles.
resource migrator 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-crm-migrator-${environmentName}'
  location: location
  tags: tags
}

output appId string = app.id
output appName string = app.name
output appClientId string = app.properties.clientId
output appPrincipalId string = app.properties.principalId
output workerId string = worker.id
output workerName string = worker.name
output workerClientId string = worker.properties.clientId
output workerPrincipalId string = worker.properties.principalId
output migratorId string = migrator.id
output migratorName string = migrator.name
output migratorClientId string = migrator.properties.clientId
output migratorPrincipalId string = migrator.properties.principalId
