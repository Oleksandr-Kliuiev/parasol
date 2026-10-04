## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 1269 | 1315 | 96.50 % | 90 % | pass | 90.16 % of 752 |
| Rest of the backend (src/) | 19086 | 21728 | 87.84 % | 70 % | pass | 73.00 % of 10592 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 40368 lines
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
| Crm.Activities | 505 | 616 | 81.98 % |
| Crm.Activities.Contracts | 30 | 32 | 93.75 % |
| Crm.Audit | 226 | 327 | 69.11 % |
| Crm.Authorization | 122 | 123 | 99.19 % |
| Crm.Billing | 2291 | 2503 | 91.53 % |
| Crm.Billing.Contracts | 41 | 43 | 95.35 % |
| Crm.Catalog | 839 | 974 | 86.14 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1554 | 1668 | 93.17 % |
| Crm.Contracts.Contracts | 73 | 75 | 97.33 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1678 | 1812 | 92.60 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 344 | 382 | 90.05 % |
| Crm.Identity.Contracts | 27 | 27 | 100.00 % |
| Crm.Infrastructure | 921 | 980 | 93.98 % |
| Crm.Integrations.Atera | 689 | 856 | 80.49 % |
| Crm.Integrations.Brreg | 117 | 165 | 70.91 % |
| Crm.Integrations.Core | 1041 | 1197 | 86.97 % |
| Crm.Integrations.MicrosoftGraph | 551 | 629 | 87.60 % |
| Crm.Integrations.PartnerCenter | 297 | 578 | 51.38 % |
| Crm.Integrations.PowerOffice | 760 | 816 | 93.14 % |
| Crm.Licensing | 891 | 957 | 93.10 % |
| Crm.Licensing.Contracts | 44 | 46 | 95.65 % |
| Crm.Notifications | 522 | 591 | 88.32 % |
| Crm.Notifications.Contracts | 12 | 12 | 100.00 % |
| Crm.Privacy | 888 | 986 | 90.06 % |
| Crm.Privacy.Contracts | 21 | 21 | 100.00 % |
| Crm.Projects | 556 | 619 | 89.82 % |
| Crm.Projects.Contracts | 11 | 11 | 100.00 % |
| Crm.Reports | 262 | 329 | 79.64 % |
| Crm.Sales | 2097 | 2346 | 89.39 % |
| Crm.Sales.Contracts | 35 | 37 | 94.59 % |
| Crm.Service | 674 | 729 | 92.46 % |
| Crm.Service.Contracts | 25 | 27 | 92.59 % |
| Crm.ServiceDefaults | 26 | 28 | 92.86 % |
| Crm.SharedKernel | 326 | 349 | 93.41 % |
| Crm.TimeTracking | 727 | 837 | 86.86 % |
| Crm.TimeTracking.Contracts | 43 | 44 | 97.73 % |
| Crm.Web | 811 | 969 | 83.69 % |

Gate: **passed**

