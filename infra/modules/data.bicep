param location string
param environmentName string
param shortSuffix string
param tags object
param privateEndpointSubnetId string
param privateDnsZoneIds object
param appIdentityPrincipalId string
param workerIdentityPrincipalId string
param migratorIdentityName string
param migratorIdentityClientId string
param sqlMaxVCores int
param logAnalyticsWorkspaceId string

var roles = {
  keyVaultReader: '21090545-7ca7-4776-b22c-e363652d74d2'
  keyVaultCryptoUser: '12338af0-0e69-4776-bea7-57ae8d297424'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

// ---------------- Azure SQL (Entra-only authentication, private) ----------------
resource sqlServer 'Microsoft.Sql/servers@2023-08-01' = {
  name: 'sql-crm-${environmentName}-${shortSuffix}'
  location: location
  tags: tags
  properties: {
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: true
      principalType: 'Application'
      login: migratorIdentityName
      sid: migratorIdentityClientId
      tenantId: subscription().tenantId
    }
  }
}

resource sqlDatabase 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: sqlServer
  name: 'crm'
  location: location
  tags: tags
  sku: {
    name: 'GP_S_Gen5'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: sqlMaxVCores
  }
  properties: {
    autoPauseDelay: environmentName == 'prod' ? -1 : 60
    minCapacity: json('0.5')
    requestedBackupStorageRedundancy: 'Geo'
    zoneRedundant: false
  }
}

resource sqlShortTermRetention 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies@2023-08-01' = {
  parent: sqlDatabase
  name: 'default'
  properties: { retentionDays: 35 }
}

// Monthly backups for 12 months, yearly for 5 years (docs/06-security.md §9).
resource sqlLongTermRetention 'Microsoft.Sql/servers/databases/backupLongTermRetentionPolicies@2023-08-01' = if (environmentName == 'prod') {
  parent: sqlDatabase
  name: 'default'
  properties: {
    monthlyRetention: 'P12M'
    yearlyRetention: 'P5Y'
    weekOfYear: 1
  }
}

resource sqlAudit 'Microsoft.Sql/servers/auditingSettings@2023-08-01' = {
  parent: sqlServer
  name: 'default'
  properties: {
    state: 'Enabled'
    isAzureMonitorTargetEnabled: true
  }
}

resource masterDb 'Microsoft.Sql/servers/databases@2023-08-01' existing = {
  parent: sqlServer
  name: 'master'
}

resource sqlAuditDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: masterDb
  name: 'audit-to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [{ category: 'SQLSecurityAuditEvents', enabled: true }]
  }
}

// ---------------- Key Vault ----------------
resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: 'kv-crm-${environmentName}-${shortSuffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    // DEV-21 (F-G4-12): bypass AzureServices is the one exception next to the private endpoint (publicNetworkAccess is
    // Disabled, defaultAction Deny). It admits only services on Microsoft's trusted-services list. Which services of this
    // deployment depend on it (diagnostics, Backup, secret references of Container Apps) has NOT been verified in a real
    // environment, so it stays until a test environment shows it can go (docs/06-security.md §6, EXT-11).
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

resource dataProtectionKey 'Microsoft.KeyVault/vaults/keys@2024-11-01' = {
  parent: keyVault
  name: 'dataprotection'
  properties: {
    kty: 'RSA'
    // DEV-21 (F-G4-08): 3072 bits (128-bit security level). A different size creates a new key version; the previous
    // version stays enabled, so key rings already wrapped with it stay readable. Verify in test before prod (not run here).
    keySize: 3072
    keyOps: ['wrapKey', 'unwrapKey']
    rotationPolicy: {
      lifetimeActions: [{ action: { type: 'rotate' }, trigger: { timeAfterCreate: 'P90D' } }]
      attributes: { expiryTime: 'P2Y' }
    }
  }
}

resource keyVaultDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: keyVault
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [{ categoryGroup: 'audit', enabled: true }]
  }
}

// crm-web (appIdentity) reads certificate metadata vault-wide — never a secret value; the private key of its sign-in
// certificate and the provider secrets are granted one secret at a time (modules/secret-access.bicep, DEV-04).
resource kvReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, appIdentityPrincipalId, roles.keyVaultReader)
  properties: {
    principalId: appIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultReader)
  }
}

resource kvCryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: dataProtectionKey
  name: guid(dataProtectionKey.id, appIdentityPrincipalId, roles.keyVaultCryptoUser)
  properties: {
    principalId: appIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultCryptoUser)
  }
}

// ---------------- Storage (Data Protection keys, attachments) ----------------
resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: take('stcrm${environmentName}${shortSuffix}', 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}

resource dataProtectionContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: 'dataprotection'
}

resource attachmentsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: 'attachments'
}

// Issued quote documents (DEV-08): private, reached only through the application with its managed identity. Keys are never
// reused and uploads are create-only; blob versioning and soft delete above keep an overwritten or deleted object recoverable.
resource documentsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: 'documents'
  properties: {
    publicAccess: 'None'
  }
}

// crm-worker stores documents that could not be stored at release and removes unreferenced objects; it gets this container
// only. crm-web keeps its account-wide role (Data Protection keys and documents).
resource workerDocumentsContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: documentsContainer
  name: guid(documentsContainer.id, workerIdentityPrincipalId, roles.storageBlobDataContributor)
  properties: {
    principalId: workerIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
  }
}

resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, appIdentityPrincipalId, roles.storageBlobDataContributor)
  properties: {
    principalId: appIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
  }
}

// ---------------- Private endpoints ----------------
var endpoints = [
  { name: 'sql', resourceId: sqlServer.id, groupId: 'sqlServer', zoneId: privateDnsZoneIds.sql }
  { name: 'kv', resourceId: keyVault.id, groupId: 'vault', zoneId: privateDnsZoneIds.keyVault }
  { name: 'blob', resourceId: storage.id, groupId: 'blob', zoneId: privateDnsZoneIds.blob }
]

resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for endpoint in endpoints: {
  name: 'pe-crm-${endpoint.name}-${environmentName}'
  location: location
  tags: tags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: endpoint.name
        properties: {
          privateLinkServiceId: endpoint.resourceId
          groupIds: [endpoint.groupId]
        }
      }
    ]
  }
}]

resource privateDnsGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (endpoint, i) in endpoints: {
  parent: privateEndpoints[i]
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: endpoint.name, properties: { privateDnsZoneId: endpoint.zoneId } }]
  }
}]

output sqlServerName string = sqlServer.name
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output sqlDatabaseName string = sqlDatabase.name
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output dataProtectionBlobUri string = '${storage.properties.primaryEndpoints.blob}${dataProtectionContainer.name}/keys.xml'
output documentsContainerUri string = '${storage.properties.primaryEndpoints.blob}${documentsContainer.name}'
output storageAccountName string = storage.name
output dataProtectionKeyUri string = dataProtectionKey.properties.keyUri
