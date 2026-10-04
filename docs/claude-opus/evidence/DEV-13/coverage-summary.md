## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 1270 | 1315 | 96.58 % | 90 % | pass | 90.16 % of 752 |
| Rest of the backend (src/) | 20002 | 22628 | 88.39 % | 70 % | pass | 73.85 % of 11026 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 40368 lines
- sources generated at build time: 256 lines
- Crm.Worker: no test loads it, so its lines are not measured (allowed by --allow-unmeasured)

### Critical domain by file

| File | Covered | Coverable | Line coverage |
|---|---:|---:|---:|
| src/Modules/Billing/Crm.Billing/Domain/BillingBasis.cs | 309 | 320 | 96.56 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingContentDigest.cs | 30 | 30 | 100.00 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingRun.cs | 153 | 167 | 91.62 % |
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
| Crm.Activities | 536 | 656 | 81.71 % |
| Crm.Activities.Contracts | 30 | 32 | 93.75 % |
| Crm.Audit | 244 | 344 | 70.93 % |
| Crm.Authorization | 122 | 123 | 99.19 % |
| Crm.Billing | 2357 | 2566 | 91.86 % |
| Crm.Billing.Contracts | 42 | 44 | 95.45 % |
| Crm.Catalog | 863 | 974 | 88.60 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1580 | 1668 | 94.72 % |
| Crm.Contracts.Contracts | 73 | 75 | 97.33 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1681 | 1812 | 92.77 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 344 | 382 | 90.05 % |
| Crm.Identity.Contracts | 27 | 27 | 100.00 % |
| Crm.Infrastructure | 1074 | 1150 | 93.39 % |
| Crm.Integrations.Atera | 689 | 856 | 80.49 % |
| Crm.Integrations.Brreg | 118 | 165 | 71.52 % |
| Crm.Integrations.Core | 1129 | 1294 | 87.25 % |
| Crm.Integrations.MicrosoftGraph | 555 | 634 | 87.54 % |
| Crm.Integrations.PartnerCenter | 297 | 578 | 51.38 % |
| Crm.Integrations.PowerOffice | 775 | 833 | 93.04 % |
| Crm.Licensing | 893 | 957 | 93.31 % |
| Crm.Licensing.Contracts | 44 | 46 | 95.65 % |
| Crm.Notifications | 590 | 673 | 87.67 % |
| Crm.Notifications.Contracts | 12 | 12 | 100.00 % |
| Crm.Privacy | 918 | 996 | 92.17 % |
| Crm.Privacy.Contracts | 21 | 21 | 100.00 % |
| Crm.Projects | 556 | 619 | 89.82 % |
| Crm.Projects.Contracts | 11 | 11 | 100.00 % |
| Crm.Reports | 262 | 329 | 79.64 % |
| Crm.Sales | 2136 | 2398 | 89.07 % |
| Crm.Sales.Contracts | 35 | 37 | 94.59 % |
| Crm.Service | 674 | 729 | 92.46 % |
| Crm.Service.Contracts | 25 | 27 | 92.59 % |
| Crm.ServiceDefaults | 26 | 28 | 92.86 % |
| Crm.SharedKernel | 368 | 391 | 94.12 % |
| Crm.TimeTracking | 731 | 837 | 87.34 % |
| Crm.TimeTracking.Contracts | 43 | 44 | 97.73 % |
| Crm.Web | 1113 | 1273 | 87.43 % |

Gate: **passed**

