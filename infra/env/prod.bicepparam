using '../main.bicep'

param environmentName = 'prod'
param entraTenantId = readEnvironmentVariable('CRM_ENTRA_TENANT_ID', '00000000-0000-0000-0000-000000000000')
param entraClientId = readEnvironmentVariable('CRM_ENTRA_CLIENT_ID_PROD', '00000000-0000-0000-0000-000000000000')
param imageTag = readEnvironmentVariable('CRM_IMAGE_TAG', 'latest')
param bootstrapImages = bool(readEnvironmentVariable('CRM_BOOTSTRAP', 'false'))
param enablePowerOffice = bool(readEnvironmentVariable('CRM_ENABLE_POWEROFFICE', 'false'))
param powerOfficeEnvironment = readEnvironmentVariable('CRM_POWEROFFICE_ENVIRONMENT', 'Production')
param enableAtera = bool(readEnvironmentVariable('CRM_ENABLE_ATERA', 'false'))
