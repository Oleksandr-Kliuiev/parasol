// DEV-17. Alert state lives in Azure Monitor; unchanged incidents do not send mail every evaluation.
param location string
param name string
param tags object
param workspaceId string
param alertsEnabled bool
param notificationsEnabled bool
param operationsOwner string
param financeOwner string
param operationsEmails array
param financeEmails array
param runbookUrl string
param thresholdOverrides object

var runbook = empty(runbookUrl) ? 'docs/runbooks/15-monitoring.md' : runbookUrl
var thresholds = union({
  httpErrorPercent: 5
  httpP95Milliseconds: 2000
  heartbeatAgeSeconds: 180
  outboxDepth: 100
  outboxAgeSeconds: 300
}, thresholdOverrides)
var recipients = [
  { category: 'operations', owner: operationsOwner, emails: operationsEmails }
  { category: 'finance', owner: financeOwner, emails: financeEmails }
]
var notificationReady = [for recipient in recipients: notificationsEnabled && !empty(recipient.owner) && !empty(recipient.emails)]

resource actionGroups 'Microsoft.Insights/actionGroups@2023-01-01' = [for (recipient, i) in recipients: {
  name: 'ag-${name}-${recipient.category}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: i == 0 ? 'CRM-ops' : 'CRM-finance'
    enabled: notificationReady[i]
    emailReceivers: [for (email, emailIndex) in recipient.emails: {
      name: '${recipient.category}-${emailIndex}'
      emailAddress: email
      useCommonAlertSchema: true
    }]
  }
}]

// Snapshots retain only bounded labels. Pick the latest sample, never sum repeated database counts or worker replicas.
var snapshots = '''
AppMetrics
| where TimeGenerated > ago(5m)
| where Name startswith "crm."
| extend Dimension = strcat(AppRoleName, "/", tostring(Properties["system"]), "/", tostring(Properties["job"]), "/", tostring(Properties["module"]), "/", tostring(Properties["component"]), "/", tostring(Properties["category"]), "/", tostring(Properties["source"]), "/", tostring(Properties["kind"]))
| summarize arg_max(TimeGenerated, *) by Name, Dimension
| extend Value = Sum / max_of(1, ItemCount)
'''
var rules = [
  {
    id: 'http-errors'
    title: 'HTTP server errors'
    severity: 1
    group: 0
    threshold: thresholds.httpErrorPercent
    query: '''
AppRequests | where TimeGenerated > ago(5m) and AppRoleName == "crm-web"
| summarize Requests=sum(ItemCount), Errors=sumif(ItemCount, toint(ResultCode) >= 500) by Dimension=AppRoleName
| where Requests >= 20
| project Dimension, Value=100.0 * Errors / Requests
'''
  }
  {
    id: 'http-latency'
    title: 'HTTP p95 latency'
    severity: 2
    group: 0
    threshold: thresholds.httpP95Milliseconds
    query: '''
AppRequests | where TimeGenerated > ago(5m) and AppRoleName == "crm-web"
| summarize Value=percentilew(DurationMs, ItemCount, 95), Requests=sum(ItemCount) by Dimension=AppRoleName
| where Requests >= 20
| project Dimension, Value
'''
  }
  {
    id: 'sql-readiness'
    title: 'Database readiness failed'
    severity: 1
    group: 0
    threshold: 0
    query: '''
AppMetrics | where TimeGenerated > ago(5m) and Name == "crm.sql.ready"
| where AppRoleName in ("crm-web", "crm-worker")
| summarize Value=1.0-min(Min) by Dimension=AppRoleName
'''
  }
  {
    id: 'host-telemetry-missing'
    title: 'Host telemetry missing for five minutes'
    severity: 1
    group: 0
    threshold: 0
    query: '''
datatable(Dimension:string)["crm-web", "crm-worker"]
| join kind=leftouter (AppMetrics | where Name == "crm.sql.ready" | summarize LastSeen=max(TimeGenerated) by Dimension=AppRoleName) on Dimension
| where isnull(LastSeen) or LastSeen < ago(5m)
| project Dimension, Value=1
'''
  }
  {
    id: 'collector-failed'
    title: 'Operational telemetry collection failed or missing'
    severity: 1
    group: 0
    threshold: 0
    query: '''
datatable(Dimension:string)["crm-worker"]
| join kind=leftouter (AppMetrics | where Name == "crm.monitoring.collection.success" | summarize arg_max(TimeGenerated, *) by Dimension=AppRoleName) on Dimension
| project Dimension, Value=iff(isnull(TimeGenerated) or TimeGenerated < ago(5m) or Min < 1, 1, 0)
'''
  }
  {
    id: 'heartbeat-old'
    title: 'Worker heartbeat is stale'
    severity: 1
    group: 0
    threshold: thresholds.heartbeatAgeSeconds
    query: '${snapshots}\n| where Name == "crm.worker.heartbeat.age" | project Dimension, Value'
  }
  {
    id: 'heartbeat-missing'
    title: 'Worker component never reported a heartbeat'
    severity: 1
    group: 0
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.worker.heartbeat.missing" | project Dimension, Value'
  }
  {
    id: 'outbox-depth'
    title: 'Outbox queue depth'
    severity: 2
    group: 0
    threshold: thresholds.outboxDepth
    query: '${snapshots}\n| where Name == "crm.outbox.depth" and tostring(Properties["maintenance"]) != "true" | project Dimension, Value'
  }
  {
    id: 'outbox-old'
    title: 'Outbox oldest undelivered message'
    severity: 2
    group: 0
    threshold: thresholds.outboxAgeSeconds
    query: '${snapshots}\n| where Name == "crm.outbox.oldest.age" and tostring(Properties["maintenance"]) != "true" | project Dimension, Value'
  }
  {
    id: 'outbox-deadletter'
    title: 'Outbox dead letter or quarantine'
    severity: 1
    group: 0
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.outbox.deadletter" | project Dimension, Value'
  }
  {
    id: 'outbound-errors'
    title: 'Outbound operation errors'
    severity: 2
    group: 0
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.outbound.errors" and tostring(Properties["paused"]) != "true" and tostring(Properties["maintenance"]) != "true" | project Dimension, Value'
  }
  {
    id: 'sync-failed'
    title: 'Integration synchronization failed or completed only partially'
    severity: 2
    group: 0
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.sync.failed" | project Dimension, Value'
  }
  {
    id: 'sync-overdue'
    title: 'Integration data has no sufficiently recent successful synchronization'
    severity: 2
    group: 0
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.sync.overdue" | project Dimension, Value'
  }
  {
    id: 'unmapped-records'
    title: 'External records need mapping'
    severity: 3
    group: 0
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.records.unmapped" | project Dimension, Value'
  }
  {
    id: 'financial-exceptions'
    title: 'Unbilled records or financial discrepancies need review'
    severity: 2
    group: 1
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.exceptions.count" and tostring(Properties["category"]) == "Financial" | project Dimension, Value'
  }
  {
    id: 'operational-exceptions'
    title: 'Mapping or document preparation needs review'
    severity: 2
    group: 0
    threshold: 0
    query: '${snapshots}\n| where Name == "crm.exceptions.count" and tostring(Properties["category"]) != "Financial" | project Dimension, Value'
  }
]

resource alerts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [for rule in rules: {
  name: 'alert-${name}-${rule.id}'
  location: location
  kind: 'LogAlert'
  tags: tags
  properties: {
    displayName: 'CRM: ${rule.title}'
    description: '${rule.title}. Runbook: ${runbook}. Owner: ${empty(recipients[rule.group].owner) ? 'unassigned (EXT-01 pending)' : recipients[rule.group].owner}. Stateful: one fired notification and one recovery notification.'
    enabled: alertsEnabled
    severity: rule.severity
    scopes: [workspaceId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    resolveConfiguration: { autoResolved: true, timeToResolve: 'PT10M' }
    criteria: {
      allOf: [{
        query: rule.query
        metricMeasureColumn: 'Value'
        timeAggregation: 'Maximum'
        operator: 'GreaterThan'
        threshold: rule.threshold
        dimensions: [{ name: 'Dimension', operator: 'Include', values: ['*'] }]
        failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
      }]
    }
    // Deployment validates queries against Azure. Local compilation does not claim EXT-01 or live query validation.
    skipQueryValidation: false
    actions: {
      actionGroups: notificationReady[rule.group] ? [actionGroups[rule.group].id] : []
      customProperties: {
        runbook: runbook
        owner: empty(recipients[rule.group].owner) ? 'unassigned (EXT-01 pending)' : recipients[rule.group].owner
        category: recipients[rule.group].category
      }
    }
  }
}]

var rulePanels = [for rule in rules: {
  type: 3
  name: rule.id
  content: {
    version: 'KqlItem/1.0'
    title: rule.title
    query: rule.query
    size: 0
    queryType: 0
    resourceType: 'microsoft.operationalinsights/workspaces'
    crossComponentResources: [workspaceId]
    timeContext: { durationMs: 300000 }
  }
}]

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(workspaceId, 'crm-operations-dev17')
  location: location
  kind: 'shared'
  tags: tags
  properties: {
    displayName: 'CRM operational exceptions'
    category: 'workbook'
    sourceId: workspaceId
    serializedData: string({
      version: 'Notebook/1.0'
      isLocked: false
      fallbackResourceIds: [workspaceId]
      items: concat([
        {
          type: 1
          name: 'runbook'
          content: {
            json: '# CRM operational exceptions\n\n[Runbook](${runbook})\n\nOperations owner: ${empty(operationsOwner) ? 'EXT-01 pending' : operationsOwner}. Finance owner: ${empty(financeOwner) ? 'EXT-01 pending' : financeOwner}.\n\nNotifications: operations ${notificationReady[0] ? 'enabled' : 'disabled'}, finance ${notificationReady[1] ? 'enabled' : 'disabled'}. Values contain counts and ages only. Silence is not proof of health: check host/collector telemetry first.'
          }
        }
      ], rulePanels, [
        {
          type: 3
          name: 'freshness-and-pauses'
          content: {
            version: 'KqlItem/1.0'
            title: 'Last successful sync age (seconds) and intentional pauses (1 = paused)'
            query: '${snapshots}\n| where Name in ("crm.sync.last_success.age", "crm.integration.paused") | project TimeGenerated, Name, Dimension, Value'
            size: 0
            queryType: 0
            resourceType: 'microsoft.operationalinsights/workspaces'
            crossComponentResources: [workspaceId]
            timeContext: { durationMs: 300000 }
          }
        }
      ])
    })
  }
}

output workbookId string = workbook.id
output notificationReadiness object = { operations: notificationReady[0], finance: notificationReady[1] }
