// Vardahei CRM v2 — Azure infrastructure (docs/03-architecture.md §11).
// Deploy per environment into its own resource group:
//   az deployment group create -g rg-crm-<env> -f infra/main.bicep -p infra/env/<env>.bicepparam
targetScope = 'resourceGroup'

@description('Environment name, used in resource names.')
@allowed(['test', 'prod'])
param environmentName string

@description('Azure region. Norway East keeps data in Norway (NFR-05).')
param location string = 'norwayeast'

@description('Entra ID tenant of the company.')
param entraTenantId string

@description('Client ID of the "Vardahei CRM" app registration for this environment.')
param entraClientId string

@description('Name of the certificate in Key Vault used as the app registration credential.')
param entraCertificateName string = 'crm-web-auth'

@description('Digest (sha256:…) of the crm-web image of the release manifest; the migrations run from the same image (DEV-05).')
param webImageDigest string = ''

@description('Digest (sha256:…) of the crm-worker image of the release manifest.')
param workerImageDigest string = ''

@description('crm-web revision that keeps the traffic while the new one is smoke-tested under the label "candidate"; empty on the first deployment.')
param webStableRevision string = ''

@description('Commit of the release being deployed; kept as tag crmRelease on the container apps so the pipeline knows what runs (schema guard).')
param releaseCommit string = ''

@description('Use a placeholder image until the registry contains CRM images (first deployment).')
param bootstrapImages bool = false

@description('Minimum replicas of crm-web.')
param webMinReplicas int = environmentName == 'prod' ? 2 : 1

@description('Connect PowerOffice Go. Requires secrets poweroffice-application-key, poweroffice-client-key and poweroffice-subscription-key in Key Vault.')
param enablePowerOffice bool = false

@description('PowerOffice Go environment, fixed per environment in infra/env/*.bicepparam: test Demo, prod Production. No default: the apps refuse to start with the PowerOffice of the other environment (DEV-05).')
@allowed(['Demo', 'Production'])
param powerOfficeEnvironment string

@description('Connect Atera. Requires secret atera-api-key in Key Vault.')
param enableAtera bool = false

@description('SQL Database max vCores (serverless).')
param sqlMaxVCores int = environmentName == 'prod' ? 4 : 2

param tags object = {
  application: 'vardahei-crm'
  environment: environmentName
}

var suffix = '${environmentName}-${uniqueString(resourceGroup().id)}'
var shortSuffix = take(uniqueString(resourceGroup().id), 8)

module identities 'modules/identities.bicep' = {
  params: {
    location: location
    environmentName: environmentName
    tags: tags
  }
}

module monitoring 'modules/monitoring.bicep' = {
  params: {
    location: location
    name: 'crm-${suffix}'
    tags: tags
  }
}

module network 'modules/network.bicep' = {
  params: {
    location: location
    name: 'crm-${environmentName}'
    tags: tags
  }
}

module data 'modules/data.bicep' = {
  params: {
    location: location
    environmentName: environmentName
    shortSuffix: shortSuffix
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneIds: network.outputs.privateDnsZoneIds
    appIdentityPrincipalId: identities.outputs.appPrincipalId
    migratorIdentityName: identities.outputs.migratorName
    migratorIdentityClientId: identities.outputs.migratorClientId
    sqlMaxVCores: sqlMaxVCores
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
  }
}

// Provider secrets crm-worker resolves from Key Vault; crm-web gets none of them (DEV-04).
var workerSecretNames = concat(
  enablePowerOffice ? ['poweroffice-application-key', 'poweroffice-client-key', 'poweroffice-subscription-key'] : [],
  enableAtera ? ['atera-api-key'] : [])

module secretAccess 'modules/secret-access.bicep' = {
  params: {
    keyVaultName: data.outputs.keyVaultName
    webPrincipalId: identities.outputs.appPrincipalId
    workerPrincipalId: identities.outputs.workerPrincipalId
    entraCertificateName: entraCertificateName
    certificateReady: !bootstrapImages
    workerSecretNames: workerSecretNames
  }
}

module apps 'modules/apps.bicep' = {
  dependsOn: [secretAccess]
  params: {
    location: location
    environmentName: environmentName
    shortSuffix: shortSuffix
    tags: tags
    infrastructureSubnetId: network.outputs.appsSubnetId
    logAnalyticsCustomerId: monitoring.outputs.workspaceCustomerId
    logAnalyticsWorkspaceName: monitoring.outputs.workspaceName
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    appIdentityId: identities.outputs.appId
    appIdentityClientId: identities.outputs.appClientId
    appIdentityName: identities.outputs.appName
    appIdentityPrincipalId: identities.outputs.appPrincipalId
    workerIdentityId: identities.outputs.workerId
    workerIdentityClientId: identities.outputs.workerClientId
    workerIdentityName: identities.outputs.workerName
    workerIdentityPrincipalId: identities.outputs.workerPrincipalId
    migratorIdentityId: identities.outputs.migratorId
    migratorIdentityClientId: identities.outputs.migratorClientId
    migratorIdentityPrincipalId: identities.outputs.migratorPrincipalId
    sqlServerFqdn: data.outputs.sqlServerFqdn
    sqlDatabaseName: data.outputs.sqlDatabaseName
    keyVaultUri: data.outputs.keyVaultUri
    dataProtectionBlobUri: data.outputs.dataProtectionBlobUri
    dataProtectionKeyUri: data.outputs.dataProtectionKeyUri
    entraTenantId: entraTenantId
    entraClientId: entraClientId
    entraCertificateName: entraCertificateName
    webImageDigest: webImageDigest
    workerImageDigest: workerImageDigest
    webStableRevision: webStableRevision
    releaseCommit: releaseCommit
    bootstrapImages: bootstrapImages
    webMinReplicas: webMinReplicas
    enablePowerOffice: enablePowerOffice
    powerOfficeEnvironment: powerOfficeEnvironment
    enableAtera: enableAtera
  }
}

output webUrl string = apps.outputs.webUrl
output webCandidateUrl string = apps.outputs.webCandidateUrl
output registryLoginServer string = apps.outputs.registryLoginServer
output migrationJobName string = apps.outputs.migrationJobName
output keyVaultName string = data.outputs.keyVaultName
output sqlServerName string = data.outputs.sqlServerName
output natPublicIp string = network.outputs.natPublicIp
