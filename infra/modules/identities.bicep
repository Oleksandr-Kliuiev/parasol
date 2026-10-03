param location string
param environmentName string
param tags object

// crm-web and crm-worker: data read/write, Key Vault secrets, blob keys. No DDL.
resource app 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-crm-app-${environmentName}'
  location: location
  tags: tags
}

// crm-migrate job: SQL Entra administrator, applies migrations and grants the app identity.
resource migrator 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-crm-migrator-${environmentName}'
  location: location
  tags: tags
}

output appId string = app.id
output appName string = app.name
output appClientId string = app.properties.clientId
output appPrincipalId string = app.properties.principalId
output migratorId string = migrator.id
output migratorName string = migrator.name
output migratorClientId string = migrator.properties.clientId
output migratorPrincipalId string = migrator.properties.principalId
