param location string
param environmentName string
param shortSuffix string
param tags object
param infrastructureSubnetId string
param logAnalyticsCustomerId string
param logAnalyticsWorkspaceName string
param appInsightsConnectionString string
param appIdentityId string
param appIdentityClientId string
param appIdentityName string
param appIdentityPrincipalId string
param workerIdentityId string
param workerIdentityClientId string
param workerIdentityName string
param workerIdentityPrincipalId string
param migratorIdentityId string
param migratorIdentityClientId string
param migratorIdentityPrincipalId string
param sqlServerFqdn string
param sqlDatabaseName string
param keyVaultUri string
param dataProtectionBlobUri string
param documentsContainerUri string
param dataProtectionKeyUri string
param entraTenantId string
param entraClientId string
param entraCertificateName string
param webImageDigest string
param workerImageDigest string
param webStableRevision string
param releaseCommit string
param bootstrapImages bool
param webMinReplicas int
param enablePowerOffice bool
param powerOfficeEnvironment string
param enableAtera bool
param recordScope string
param maintenanceForceReadOnly bool
param biEnabled bool
param biAudience string
param biAllowedClients array

var acrPullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538f'
var placeholderImage = 'mcr.microsoft.com/k8se/quickstart:latest'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'crcrm${environmentName}${shortSuffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in [appIdentityPrincipalId, workerIdentityPrincipalId, migratorIdentityPrincipalId]: {
  scope: registry
  name: guid(registry.id, principalId, acrPullRole)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRole)
  }
}]

resource environment 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: 'cae-crm-${environmentName}'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      internal: false
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

var sqlConnectionPrefix = 'Server=tcp:${sqlServerFqdn},1433;Database=${sqlDatabaseName};Authentication=Active Directory Managed Identity;Encrypt=True;Connect Timeout=30'
// Each host signs in to SQL as its own identity; the migrator maps crm-web to crm_web and crm-worker to crm_worker (DEV-04).
var webConnectionString = '${sqlConnectionPrefix};User Id=${appIdentityClientId}'
var workerConnectionString = '${sqlConnectionPrefix};User Id=${workerIdentityClientId}'
var migratorConnectionString = '${sqlConnectionPrefix};User Id=${migratorIdentityClientId}'

var commonEnv = [
  { name: 'ASPNETCORE_ENVIRONMENT', value: 'Production' }
  // Issued quote documents (DEV-08); each host reaches the container with its own identity (AZURE_CLIENT_ID).
  { name: 'Documents__Provider', value: 'AzureBlob' }
  { name: 'Documents__BlobContainerUri', value: documentsContainerUri }
  // Which deployment this is: the apps check environment-bound settings against it (PowerOffice Demo/Production, DEV-05).
  { name: 'Deployment__Environment', value: environmentName }
  // Record scope (DEV-09): set per environment in infra/env/*.bicepparam; crm-web logs a warning on every start when Open.
  { name: 'Authorization__RecordScope', value: recordScope }
  // Read-only maintenance by configuration (DEV-13): normally false; the operator's switch lives in the document store.
  { name: 'Maintenance__ForceReadOnly', value: string(maintenanceForceReadOnly) }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'OTEL_SERVICE_NAME', value: 'crm' }
]

// DEV-14: the BI read API takes bearer tokens on crm-web only; the worker has no use for it.
var biClientEnv = [for (client, i) in biAllowedClients: { name: 'Bi__AllowedClients__${i}', value: client }]
var biEnv = concat([
  { name: 'Bi__Enabled', value: string(biEnabled) }
  { name: 'Bi__TenantId', value: entraTenantId }
  { name: 'Bi__Audience', value: biAudience }
], biClientEnv)

var webEnv = concat(commonEnv, biEnv, [
  { name: 'AZURE_CLIENT_ID', value: appIdentityClientId }
  { name: 'ConnectionStrings__crm', value: webConnectionString }
  { name: 'AzureAd__TenantId', value: entraTenantId }
  { name: 'AzureAd__ClientId', value: entraClientId }
  { name: 'AzureAd__ClientCertificates__0__SourceType', value: 'KeyVault' }
  { name: 'AzureAd__ClientCertificates__0__KeyVaultUrl', value: keyVaultUri }
  { name: 'AzureAd__ClientCertificates__0__KeyVaultCertificateName', value: entraCertificateName }
  { name: 'DataProtection__BlobUri', value: dataProtectionBlobUri }
  { name: 'DataProtection__KeyVaultKeyUri', value: dataProtectionKeyUri }
  { name: 'Integrations__MicrosoftGraph__Enabled', value: 'true' }
  { name: 'Integrations__MicrosoftGraph__TenantId', value: entraTenantId }
  { name: 'Integrations__MicrosoftGraph__ManagedIdentityClientId', value: appIdentityClientId }
])

var workerEnv = concat(commonEnv, [
  { name: 'AZURE_CLIENT_ID', value: workerIdentityClientId }
  { name: 'ConnectionStrings__crm', value: workerConnectionString }
  { name: 'Integrations__MicrosoftGraph__Enabled', value: 'true' }
  { name: 'Integrations__MicrosoftGraph__TenantId', value: entraTenantId }
  { name: 'Integrations__MicrosoftGraph__ManagedIdentityClientId', value: workerIdentityClientId }
  // DEV-10: the role sync reads who holds the CRM's own app roles (Graph Application.Read.All, GroupMember.Read.All).
  { name: 'Integrations__MicrosoftGraph__CrmAppId', value: entraClientId }
])

// Provider keys live in Key Vault (docs/runbooks/02-integrations.md) and reach crm-worker only: it is the host that calls
// PowerOffice and Atera (sync jobs, the outbound queue, connection tests). crm-web works from stored data and the switches.
var integrationSecrets = concat(
  enablePowerOffice ? [
    { name: 'poweroffice-application-key', keyVaultUrl: '${keyVaultUri}secrets/poweroffice-application-key', identity: workerIdentityId }
    { name: 'poweroffice-client-key', keyVaultUrl: '${keyVaultUri}secrets/poweroffice-client-key', identity: workerIdentityId }
    { name: 'poweroffice-subscription-key', keyVaultUrl: '${keyVaultUri}secrets/poweroffice-subscription-key', identity: workerIdentityId }
  ] : [],
  enableAtera ? [
    { name: 'atera-api-key', keyVaultUrl: '${keyVaultUri}secrets/atera-api-key', identity: workerIdentityId }
  ] : [])

var integrationSwitches = [
  { name: 'Integrations__PowerOffice__Enabled', value: string(enablePowerOffice) }
  { name: 'Integrations__PowerOffice__Environment', value: powerOfficeEnvironment }
  { name: 'Integrations__Atera__Enabled', value: string(enableAtera) }
]

var integrationKeys = concat(
  enablePowerOffice ? [
    { name: 'Integrations__PowerOffice__ApplicationKey', secretRef: 'poweroffice-application-key' }
    { name: 'Integrations__PowerOffice__ClientKey', secretRef: 'poweroffice-client-key' }
    { name: 'Integrations__PowerOffice__SubscriptionKey', secretRef: 'poweroffice-subscription-key' }
  ] : [],
  enableAtera ? [
    { name: 'Integrations__Atera__ApiKey', secretRef: 'atera-api-key' }
  ] : [])

// Images are referenced by digest from the release manifest, never by a tag that could move (DEV-05).
// The release that runs, for the schema guard of the next deployment or rollback (tools/release/schema-breaks.json).
var appTags = empty(releaseCommit) ? tags : union(tags, { crmRelease: releaseCommit })
var webImage = bootstrapImages ? placeholderImage : '${registry.properties.loginServer}/crm-web@${webImageDigest}'
var workerImage = bootstrapImages ? placeholderImage : '${registry.properties.loginServer}/crm-worker@${workerImageDigest}'
var webRegistries = bootstrapImages ? [] : [{ server: registry.properties.loginServer, identity: appIdentityId }]
var workerRegistries = bootstrapImages ? [] : [{ server: registry.properties.loginServer, identity: workerIdentityId }]

resource web 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: 'ca-crm-web-${environmentName}'
  location: location
  tags: appTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentityId}': {} }
  }
  dependsOn: [acrPull]
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        // A new revision first takes no traffic: the pipeline smoke-tests it under the label "candidate" and only then moves
        // the traffic (tools/release/deploy.sh). The first deployment has nothing to keep.
        traffic: empty(webStableRevision) ? [{ latestRevision: true, weight: 100 }] : [
          { revisionName: webStableRevision, weight: 100 }
          { latestRevision: true, weight: 0, label: 'candidate' }
        ]
      }
      registries: webRegistries
    }
    template: {
      containers: [
        {
          name: 'crm-web'
          image: webImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(webEnv, integrationSwitches)
          // DEV-06: live is the process alone (a database outage must not restart every replica); ready is the database and
          // its schema, answered within 4 s, so the probe gets 5 s.
          probes: bootstrapImages ? [] : [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, periodSeconds: 30, timeoutSeconds: 2 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, periodSeconds: 10, timeoutSeconds: 5 }
            { type: 'Startup', httpGet: { path: '/health/live', port: 8080 }, failureThreshold: 30, periodSeconds: 5, timeoutSeconds: 2 }
          ]
        }
      ]
      scale: {
        minReplicas: webMinReplicas
        maxReplicas: 4
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: 'ca-crm-worker-${environmentName}'
  location: location
  tags: appTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${workerIdentityId}': {} }
  }
  dependsOn: [acrPull]
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: workerRegistries
      secrets: integrationSecrets
    }
    template: {
      containers: [
        {
          name: 'crm-worker'
          image: workerImage
          resources: { cpu: json('1'), memory: '2Gi' }
          env: concat(workerEnv, integrationSwitches, integrationKeys)
          // DEV-06: live fails when the outbox loop stops finishing rounds (the platform restarts the worker); ready is the
          // database, so a new revision that cannot reach it never replaces a working one.
          probes: bootstrapImages ? [] : [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, periodSeconds: 30, timeoutSeconds: 2, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, periodSeconds: 30, timeoutSeconds: 5 }
            { type: 'Startup', httpGet: { path: '/health/live', port: 8080 }, failureThreshold: 30, periodSeconds: 5, timeoutSeconds: 2 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// Runs `crm-web --migrate-only` inside the VNet (SQL has no public endpoint). Started by the deployment pipeline.
resource migrate 'Microsoft.App/jobs@2024-10-02-preview' = {
  name: 'caj-crm-migrate-${environmentName}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${migratorIdentityId}': {} }
  }
  dependsOn: [acrPull]
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: bootstrapImages ? [] : [{ server: registry.properties.loginServer, identity: migratorIdentityId }]
    }
    template: {
      containers: [
        {
          name: 'crm-migrate'
          image: webImage
          args: bootstrapImages ? [] : ['--migrate-only']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(commonEnv, [
            { name: 'AZURE_CLIENT_ID', value: migratorIdentityClientId }
            { name: 'ConnectionStrings__crm', value: migratorConnectionString }
            { name: 'Database__WebIdentityName', value: appIdentityName }
            { name: 'Database__WebIdentityClientId', value: appIdentityClientId }
            { name: 'Database__WorkerIdentityName', value: workerIdentityName }
            { name: 'Database__WorkerIdentityClientId', value: workerIdentityClientId }
            { name: 'Auth__Mode', value: 'Entra' }
            { name: 'AzureAd__TenantId', value: entraTenantId }
            { name: 'AzureAd__ClientId', value: entraClientId }
            { name: 'Hangfire__DashboardEnabled', value: 'false' }
          ])
        }
      ]
    }
  }
}

output webUrl string = 'https://${web.properties.configuration.ingress.fqdn}'
output webCandidateUrl string = 'https://${web.name}---candidate.${environment.properties.defaultDomain}'
output registryLoginServer string = registry.properties.loginServer
output migrationJobName string = migrate.name
output webAppName string = web.name
output workerAppName string = worker.name
