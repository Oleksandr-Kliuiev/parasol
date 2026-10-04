using '../main.bicep'

param environmentName = 'test'
param entraTenantId = readEnvironmentVariable('CRM_ENTRA_TENANT_ID', '00000000-0000-0000-0000-000000000000')
param entraClientId = readEnvironmentVariable('CRM_ENTRA_CLIENT_ID_TEST', '00000000-0000-0000-0000-000000000000')
param webImageDigest = readEnvironmentVariable('CRM_WEB_IMAGE_DIGEST', '')
param workerImageDigest = readEnvironmentVariable('CRM_WORKER_IMAGE_DIGEST', '')
param webStableRevision = readEnvironmentVariable('CRM_WEB_STABLE_REVISION', '')
param releaseCommit = readEnvironmentVariable('CRM_RELEASE_COMMIT', '')
param bootstrapImages = bool(readEnvironmentVariable('CRM_BOOTSTRAP', 'false'))
param enablePowerOffice = bool(readEnvironmentVariable('CRM_ENABLE_POWEROFFICE', 'false'))
// Fixed for this environment (DEV-05): never taken from a pipeline variable that could be missing or wrong.
param powerOfficeEnvironment = 'Demo'
param enableAtera = bool(readEnvironmentVariable('CRM_ENABLE_ATERA', 'false'))
// Record scope (DEV-09, runbook 11): Open only as a dated, reviewed exception while owners and teams are reconciled.
param recordScope = 'Restricted'
