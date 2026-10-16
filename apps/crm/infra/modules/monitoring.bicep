param location string
param name string
param tags object
param alertsEnabled bool = true
param notificationsEnabled bool = false
param operationsOwner string = ''
param financeOwner string = ''
param operationsEmails array = []
param financeEmails array = []
param runbookUrl string = ''
param thresholdOverrides object = {}

@description('DEV-21 / F-G5-02: true makes Application Insights accept only Entra-authenticated ingestion, so the connection string alone can no longer post telemetry (forged AUDIT_CHECKPOINT lines, noise). Keep false until crm-web, crm-worker and crm-migrate pass an Entra credential to the Azure Monitor exporter; with true and no credential ALL telemetry is rejected silently.')
param entraOnlyIngestion bool = false

@description('Principals that publish telemetry (the three app identities). They get Monitoring Metrics Publisher on the Application Insights resource only.')
param publisherPrincipalIds array = []

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: entraOnlyIngestion
  }
}

var monitoringMetricsPublisher = '3913510d-42f4-4e42-8a64-420c390055eb'

// Granted now, effective only for Entra-authenticated ingestion: harmless while local auth is still allowed.
resource publishers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in publisherPrincipalIds: {
  scope: appInsights
  name: guid(appInsights.id, principalId, monitoringMetricsPublisher)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisher)
  }
}]

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output workspaceCustomerId string = workspace.properties.customerId
output appInsightsConnectionString string = appInsights.properties.ConnectionString

module operations 'monitoring-operations.bicep' = {
  name: 'operations-${name}'
  params: {
    location: location
    name: name
    tags: tags
    workspaceId: workspace.id
    alertsEnabled: alertsEnabled
    notificationsEnabled: notificationsEnabled
    operationsOwner: operationsOwner
    financeOwner: financeOwner
    operationsEmails: operationsEmails
    financeEmails: financeEmails
    runbookUrl: runbookUrl
    thresholdOverrides: thresholdOverrides
  }
}

output workbookId string = operations.outputs.workbookId
output notificationReadiness object = operations.outputs.notificationReadiness
