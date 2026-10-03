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
param migratorIdentityId string
param migratorIdentityClientId string
param migratorIdentityPrincipalId string
param sqlServerFqdn string
param sqlDatabaseName string
param keyVaultUri string
param dataProtectionBlobUri string
param dataProtectionKeyUri string
param entraTenantId string
param entraClientId string
param entraCertificateName string
param imageTag string
param bootstrapImages bool
param webMinReplicas int
param enablePowerOffice bool
param powerOfficeEnvironment string
param enableAtera bool

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

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in [appIdentityPrincipalId, migratorIdentityPrincipalId]: {
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
var appConnectionString = '${sqlConnectionPrefix};User Id=${appIdentityClientId}'
var migratorConnectionString = '${sqlConnectionPrefix};User Id=${migratorIdentityClientId}'

var commonEnv = [
  { name: 'ASPNETCORE_ENVIRONMENT', value: 'Production' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'OTEL_SERVICE_NAME', value: 'crm' }
]

var appEnv = concat(commonEnv, [
  { name: 'AZURE_CLIENT_ID', value: appIdentityClientId }
  { name: 'ConnectionStrings__crm', value: appConnectionString }
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

// Integration keys live in Key Vault (docs/runbooks/02-integrations.md); Container Apps resolves them with the app identity.
var integrationSecrets = concat(
  enablePowerOffice ? [
    { name: 'poweroffice-application-key', keyVaultUrl: '${keyVaultUri}secrets/poweroffice-application-key', identity: appIdentityId }
    { name: 'poweroffice-client-key', keyVaultUrl: '${keyVaultUri}secrets/poweroffice-client-key', identity: appIdentityId }
    { name: 'poweroffice-subscription-key', keyVaultUrl: '${keyVaultUri}secrets/poweroffice-subscription-key', identity: appIdentityId }
  ] : [],
  enableAtera ? [
    { name: 'atera-api-key', keyVaultUrl: '${keyVaultUri}secrets/atera-api-key', identity: appIdentityId }
  ] : [])

var integrationEnv = concat(
  [
    { name: 'Integrations__PowerOffice__Enabled', value: string(enablePowerOffice) }
    { name: 'Integrations__PowerOffice__Environment', value: powerOfficeEnvironment }
    { name: 'Integrations__Atera__Enabled', value: string(enableAtera) }
  ],
  enablePowerOffice ? [
    { name: 'Integrations__PowerOffice__ApplicationKey', secretRef: 'poweroffice-application-key' }
    { name: 'Integrations__PowerOffice__ClientKey', secretRef: 'poweroffice-client-key' }
    { name: 'Integrations__PowerOffice__SubscriptionKey', secretRef: 'poweroffice-subscription-key' }
  ] : [],
  enableAtera ? [
    { name: 'Integrations__Atera__ApiKey', secretRef: 'atera-api-key' }
  ] : [])

var webImage = bootstrapImages ? placeholderImage : '${registry.properties.loginServer}/crm-web:${imageTag}'
var workerImage = bootstrapImages ? placeholderImage : '${registry.properties.loginServer}/crm-worker:${imageTag}'
var registries = bootstrapImages ? [] : [{ server: registry.properties.loginServer, identity: appIdentityId }]

resource web 'Microsoft.App/containerApps@2024-10-02-preview' = {
  name: 'ca-crm-web-${environmentName}'
  location: location
  tags: tags
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
        traffic: [{ latestRevision: true, weight: 100 }]
      }
      registries: registries
      secrets: integrationSecrets
    }
    template: {
      containers: [
        {
          name: 'crm-web'
          image: webImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(appEnv, integrationEnv)
          probes: bootstrapImages ? [] : [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, periodSeconds: 10 }
            { type: 'Startup', httpGet: { path: '/health/live', port: 8080 }, failureThreshold: 30, periodSeconds: 5 }
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
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentityId}': {} }
  }
  dependsOn: [acrPull]
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: registries
      secrets: integrationSecrets
    }
    template: {
      containers: [
        {
          name: 'crm-worker'
          image: workerImage
          resources: { cpu: json('1'), memory: '2Gi' }
          env: concat(appEnv, integrationEnv)
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
            { name: 'Database__AppIdentityName', value: appIdentityName }
            { name: 'Database__AppIdentityClientId', value: appIdentityClientId }
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
output registryLoginServer string = registry.properties.loginServer
output migrationJobName string = migrate.name
