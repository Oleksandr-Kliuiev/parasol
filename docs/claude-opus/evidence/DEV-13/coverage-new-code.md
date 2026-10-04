# DEV-13: line coverage of the new and changed code

Unit + integration reports of the final CI emulation (Release, 04.10.2026), lines of both reports united.

| File | Covered | Coverable | Line coverage |
|---|---:|---:|---:|
| BuildingBlocks/Crm.Infrastructure/Operations/MaintenanceGate.cs | 56 | 57 | 98.2 % |
| BuildingBlocks/Crm.Infrastructure/Operations/EffectJournal.cs | 44 | 49 | 89.8 % |
| BuildingBlocks/Crm.Infrastructure/Operations/MaintenanceWriteInterceptor.cs | 23 | 28 | 82.1 % |
| BuildingBlocks/Crm.Infrastructure/Http/MaintenanceHttp.cs | 13 | 13 | 100.0 % |
| BuildingBlocks/Crm.SharedKernel/Operations/Maintenance.cs | 19 | 19 | 100.0 % |
| BuildingBlocks/Crm.SharedKernel/Operations/ExternalEffects.cs | 22 | 22 | 100.0 % |
| Hosts/Crm.Web/Http/MaintenanceMiddleware.cs | 19 | 19 | 100.0 % |
| Hosts/Crm.Web/Http/OperationsEndpoints.cs | 197 | 220 | 89.5 % |
| Hosts/Crm.Web/Http/JobEndpoints.cs | 63 | 75 | 84.0 % |
| Integrations/Crm.Integrations.Core/IntegrationRestore.cs | 48 | 55 | 87.3 % |
| Modules/Billing/Crm.Billing/Features/BillingRestore.cs | 49 | 58 | 84.5 % |
| Modules/Notifications/Crm.Notifications/Features/NotificationsRestore.cs | 48 | 48 | 100.0 % |
| Modules/Sales/Crm.Sales/Features/SalesRestore.cs | 28 | 41 | 68.3 % |
| Modules/Activities/Crm.Activities/Features/ActivitiesRestore.cs | 19 | 22 | 86.4 % |
| Modules/Privacy/Crm.Privacy/Features/PrivacyRestore.cs | 8 | 8 | 100.0 % |
| Modules/Audit/Crm.Audit/Features/AuditRestore.cs | 16 | 16 | 100.0 % |
| Integrations/Crm.Integrations.Core/Outbound.cs | 134 | 161 | 83.2 % |
| Integrations/Crm.Integrations.PowerOffice/PowerOfficeBilling.cs | 138 | 156 | 88.5 % |
| Hosts/Crm.Web/Auth/AuthenticationSetup.cs | 141 | 163 | 86.5 % |
| Crm.Worker/MaintenanceJobFilter.cs | — | — | not loaded by unit or integration tests (Crm.Worker; covered by architecture test MaintenanceTests) |
