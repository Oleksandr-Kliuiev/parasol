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
    DisableLocalAuth: false
  }
}

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
