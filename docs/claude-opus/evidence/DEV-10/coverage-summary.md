# Coverage after DEV-10 (local run of the backend job of ci.yml, 2026-10-04 09:15–09:17 UTC)

## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 1269 | 1315 | 96.50 % | 90 % | pass | 90.16 % of 752 |
| Rest of the backend (src/) | 17168 | 19644 | 87.40 % | 70 % | pass | 71.87 % of 9630 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 36586 lines
- sources generated at build time: 256 lines
- Crm.Worker: no test loads it, so its lines are not measured (allowed by --allow-unmeasured)

### Critical domain by file

| File | Covered | Coverable | Line coverage |
|---|---:|---:|---:|
| src/Modules/Billing/Crm.Billing/Domain/BillingBasis.cs | 309 | 320 | 96.56 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingContentDigest.cs | 30 | 30 | 100.00 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingRun.cs | 152 | 167 | 91.02 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingSchedule.cs | 29 | 30 | 96.67 % |
| src/Modules/Billing/Crm.Billing/Domain/Charge.cs | 104 | 110 | 94.55 % |
| src/Modules/Billing/Crm.Billing/Domain/Invoice.cs | 37 | 38 | 97.37 % |
| src/Modules/Billing/Crm.Billing/Domain/PendingCharge.cs | 32 | 37 | 86.49 % |
| src/Modules/Contracts/Crm.Contracts/Domain/Contract.cs | 217 | 221 | 98.19 % |
| src/Modules/Contracts/Crm.Contracts/Domain/HourBank.cs | 112 | 113 | 99.12 % |
| src/Modules/Contracts/Crm.Contracts/Domain/SlaPolicy.cs | 40 | 40 | 100.00 % |
| src/Modules/TimeTracking/Crm.TimeTracking/Domain/TariffEngine.cs | 49 | 51 | 96.08 % |
| src/Modules/TimeTracking/Crm.TimeTracking/Domain/TimeEntry.cs | 158 | 158 | 100.00 % |

### Backend by assembly

| Assembly | Covered | Coverable | Line coverage |
|---|---:|---:|---:|
| Crm.Activities | 432 | 527 | 81.97 % |
| Crm.Activities.Contracts | 30 | 32 | 93.75 % |
| Crm.Audit | 187 | 251 | 74.50 % |
| Crm.Authorization | 122 | 123 | 99.19 % |
| Crm.Billing | 2253 | 2479 | 90.88 % |
| Crm.Billing.Contracts | 40 | 43 | 93.02 % |
| Crm.Catalog | 838 | 973 | 86.13 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1528 | 1634 | 93.51 % |
| Crm.Contracts.Contracts | 73 | 75 | 97.33 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1558 | 1686 | 92.41 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 320 | 350 | 91.43 % |
| Crm.Identity.Contracts | 27 | 27 | 100.00 % |
| Crm.Infrastructure | 905 | 967 | 93.59 % |
| Crm.Integrations.Atera | 681 | 849 | 80.21 % |
| Crm.Integrations.Brreg | 117 | 165 | 70.91 % |
| Crm.Integrations.Core | 894 | 1017 | 87.91 % |
| Crm.Integrations.MicrosoftGraph | 551 | 629 | 87.60 % |
| Crm.Integrations.PartnerCenter | 297 | 578 | 51.38 % |
| Crm.Integrations.PowerOffice | 760 | 816 | 93.14 % |
| Crm.Licensing | 824 | 889 | 92.69 % |
| Crm.Licensing.Contracts | 44 | 46 | 95.65 % |
| Crm.Notifications | 482 | 567 | 85.01 % |
| Crm.Notifications.Contracts | 12 | 12 | 100.00 % |
| Crm.Projects | 547 | 610 | 89.67 % |
| Crm.Projects.Contracts | 11 | 11 | 100.00 % |
| Crm.Reports | 247 | 325 | 76.00 % |
| Crm.Sales | 1910 | 2148 | 88.92 % |
| Crm.Sales.Contracts | 35 | 37 | 94.59 % |
| Crm.Service | 519 | 581 | 89.33 % |
| Crm.Service.Contracts | 25 | 27 | 92.59 % |
| Crm.ServiceDefaults | 26 | 28 | 92.86 % |
| Crm.SharedKernel | 319 | 342 | 93.27 % |
| Crm.TimeTracking | 708 | 817 | 86.66 % |
| Crm.TimeTracking.Contracts | 43 | 44 | 97.73 % |
| Crm.Web | 794 | 952 | 83.40 % |

Gate: **passed**

## DEV-10 files (unit + integration, merged)

| File | Covered | Coverable | Line coverage | Not covered (lines) |
|---|---:|---:|---:|---|
| Crm.Web/Auth/SessionStateCache.cs | 16 | 16 | 100.0 % | — |
| Crm.Web/Auth/CrmAuthorizationResultHandler.cs | 14 | 14 | 100.0 % | — |
| Crm.Web/Auth/AuthenticationSetup.cs | 130 | 146 | 89.0 % | 27, 29, 32, 33, 34, 35, 51, 53, 56, 57, 69, 70, 71, 72, 131, 132 |
| Crm.Web/Http/DataProtectionSetup.cs | 14 | 21 | 66.7 % | 24, 25, 26, 27, 28, 29, 30 |
| Crm.Web/Bff/BffEndpoints.cs | 68 | 106 | 64.2 % | 34, 35, 37, 40, 41, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 89, 93, 94, 95, 103, 120, 121, 122, 123, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137 |
| Crm.Integrations.MicrosoftGraph/EntraRoleSync.cs | 79 | 81 | 97.5 % | 150, 151 |
| Crm.Integrations.Core/SyncRunner.cs | 75 | 77 | 97.4 % | 93, 94 |
| Crm.Authorization/PermissionAuthorization.cs | 34 | 35 | 97.1 % | 84 |
| Crm.Identity/Domain/User.cs | 43 | 47 | 91.5 % | 52, 102, 117, 118 |
| Crm.Identity/Domain/UserSession.cs | 6 | 6 | 100.0 % | — |
| Crm.Identity/Domain/DirectoryRoleConfirmation.cs | 7 | 7 | 100.0 % | — |
| Crm.Identity/Features/UserServices.cs | 99 | 102 | 97.1 % | 113, 168, 195 |

Not covered, by design: the OIDC sign-in and the Microsoft Identity Web token cache in AuthenticationSetup (need Entra) and its redirect for non-API paths; the Key Vault + Blob key ring in DataProtectionSetup (needs Azure); the development sign-in page and the Entra sign-out redirect in BffEndpoints (exercised by E2E, which is not measured); the "not configured" log line of the role sync job; the cancelled-run branch of SyncRunner; pre-existing branches of User and PermissionPolicyProvider.
