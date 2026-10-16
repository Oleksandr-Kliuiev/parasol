## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 843 | 882 | 95.58 % | 90 % | pass | 86.60 % of 470 |
| Rest of the backend (src/) | 14398 | 16942 | 84.98 % | 70 % | pass | 68.17 % of 8340 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 18799 lines
- sources generated at build time: 256 lines
- Crm.Worker: no test loads it, so its lines are not measured (allowed by --allow-unmeasured)

### Critical domain by file

| File | Covered | Coverable | Line coverage |
|---|---:|---:|---:|
| src/Modules/Billing/Crm.Billing/Domain/BillingBasis.cs | 123 | 135 | 91.11 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingRun.cs | 61 | 74 | 82.43 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingSchedule.cs | 29 | 30 | 96.67 % |
| src/Modules/Billing/Crm.Billing/Domain/Invoice.cs | 37 | 38 | 97.37 % |
| src/Modules/Billing/Crm.Billing/Domain/PendingCharge.cs | 17 | 22 | 77.27 % |
| src/Modules/Contracts/Crm.Contracts/Domain/Contract.cs | 217 | 221 | 98.19 % |
| src/Modules/Contracts/Crm.Contracts/Domain/HourBank.cs | 112 | 113 | 99.12 % |
| src/Modules/Contracts/Crm.Contracts/Domain/SlaPolicy.cs | 40 | 40 | 100.00 % |
| src/Modules/TimeTracking/Crm.TimeTracking/Domain/TariffEngine.cs | 49 | 51 | 96.08 % |
| src/Modules/TimeTracking/Crm.TimeTracking/Domain/TimeEntry.cs | 158 | 158 | 100.00 % |

### Backend by assembly

| Assembly | Covered | Coverable | Line coverage |
|---|---:|---:|---:|
| Crm.Activities | 429 | 524 | 81.87 % |
| Crm.Activities.Contracts | 30 | 32 | 93.75 % |
| Crm.Audit | 82 | 101 | 81.19 % |
| Crm.Authorization | 102 | 103 | 99.03 % |
| Crm.Billing | 1268 | 1462 | 86.73 % |
| Crm.Billing.Contracts | 39 | 42 | 92.86 % |
| Crm.Catalog | 838 | 973 | 86.13 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1505 | 1631 | 92.27 % |
| Crm.Contracts.Contracts | 72 | 74 | 97.30 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1556 | 1684 | 92.40 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 221 | 249 | 88.76 % |
| Crm.Identity.Contracts | 24 | 24 | 100.00 % |
| Crm.Infrastructure | 299 | 335 | 89.25 % |
| Crm.Integrations.Atera | 675 | 847 | 79.69 % |
| Crm.Integrations.Brreg | 117 | 165 | 70.91 % |
| Crm.Integrations.Core | 717 | 839 | 85.46 % |
| Crm.Integrations.MicrosoftGraph | 462 | 538 | 85.87 % |
| Crm.Integrations.PartnerCenter | 294 | 576 | 51.04 % |
| Crm.Integrations.PowerOffice | 722 | 789 | 91.51 % |
| Crm.Licensing | 821 | 886 | 92.66 % |
| Crm.Licensing.Contracts | 44 | 46 | 95.65 % |
| Crm.Notifications | 401 | 483 | 83.02 % |
| Crm.Notifications.Contracts | 12 | 12 | 100.00 % |
| Crm.Projects | 459 | 532 | 86.28 % |
| Crm.Projects.Contracts | 9 | 11 | 81.82 % |
| Crm.Reports | 246 | 324 | 75.93 % |
| Crm.Sales | 1504 | 1833 | 82.05 % |
| Crm.Sales.Contracts | 35 | 37 | 94.59 % |
| Crm.Service | 512 | 579 | 88.43 % |
| Crm.Service.Contracts | 25 | 27 | 92.59 % |
| Crm.ServiceDefaults | 26 | 28 | 92.86 % |
| Crm.SharedKernel | 291 | 319 | 91.22 % |
| Crm.TimeTracking | 688 | 797 | 86.32 % |
| Crm.TimeTracking.Contracts | 42 | 43 | 97.67 % |
| Crm.Web | 396 | 577 | 68.63 % |

Gate: **passed**

