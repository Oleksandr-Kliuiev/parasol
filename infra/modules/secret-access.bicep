// Key Vault access per secret (DEV-04-AC05, docs/runbooks/08-database-permissions.md): crm-web reads only its sign-in
// certificate, crm-worker only the provider secrets it calls PowerOffice and Atera with. A vault-wide Secrets User or
// Certificate User role would let either read every secret, so neither has one.
param keyVaultName string
param webPrincipalId string
param workerPrincipalId string

@description('The certificate the app registration signs in with; its private key is the secret of the same name.')
param entraCertificateName string

@description('False on the bootstrap deployment: the certificate is created afterwards (runbook 01 §5).')
param certificateReady bool

@description('Provider secrets crm-worker resolves; each must exist in Key Vault before its integration is switched on.')
param workerSecretNames array

var roles = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
}

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource certificateSecret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = if (certificateReady) {
  parent: keyVault
  name: entraCertificateName
}

resource webCertificate 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (certificateReady) {
  scope: certificateSecret
  name: guid(keyVault.id, 'secret', entraCertificateName, webPrincipalId, roles.keyVaultSecretsUser)
  properties: {
    principalId: webPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
  }
}

resource providerSecrets 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = [for name in workerSecretNames: {
  parent: keyVault
  name: name
}]

resource workerSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in workerSecretNames: {
  scope: providerSecrets[i]
  name: guid(keyVault.id, 'secret', name, workerPrincipalId, roles.keyVaultSecretsUser)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
  }
}]
