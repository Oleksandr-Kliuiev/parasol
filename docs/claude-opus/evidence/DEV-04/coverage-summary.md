## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 1262 | 1309 | 96.41 % | 90 % | pass | 90.27 % of 750 |
| Rest of the backend (src/) | 15237 | 17835 | 85.43 % | 70 % | pass | 69.27 % of 8822 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 23362 lines
- sources generated at build time: 256 lines
- Crm.Worker: no test loads it, so its lines are not measured (allowed by --allow-unmeasured)

### Critical domain by file

| File | Covered | Coverable | Line coverage |
|---|---:|---:|---:|
| src/Modules/Billing/Crm.Billing/Domain/BillingBasis.cs | 309 | 320 | 96.56 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingContentDigest.cs | 30 | 30 | 100.00 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingRun.cs | 151 | 167 | 90.42 % |
| src/Modules/Billing/Crm.Billing/Domain/BillingSchedule.cs | 29 | 30 | 96.67 % |
| src/Modules/Billing/Crm.Billing/Domain/Charge.cs | 104 | 110 | 94.55 % |
| src/Modules/Billing/Crm.Billing/Domain/Invoice.cs | 37 | 38 | 97.37 % |
| src/Modules/Billing/Crm.Billing/Domain/PendingCharge.cs | 26 | 31 | 83.87 % |
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
| Crm.Audit | 181 | 251 | 72.11 % |
| Crm.Authorization | 102 | 103 | 99.03 % |
| Crm.Billing | 2224 | 2449 | 90.81 % |
| Crm.Billing.Contracts | 40 | 43 | 93.02 % |
| Crm.Catalog | 838 | 973 | 86.13 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1519 | 1631 | 93.13 % |
| Crm.Contracts.Contracts | 73 | 75 | 97.33 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1556 | 1684 | 92.40 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 221 | 249 | 88.76 % |
| Crm.Identity.Contracts | 24 | 24 | 100.00 % |
| Crm.Infrastructure | 387 | 423 | 91.49 % |
| Crm.Integrations.Atera | 678 | 849 | 79.86 % |
| Crm.Integrations.Brreg | 117 | 165 | 70.91 % |
| Crm.Integrations.Core | 768 | 891 | 86.20 % |
| Crm.Integrations.MicrosoftGraph | 462 | 538 | 85.87 % |
| Crm.Integrations.PartnerCenter | 297 | 578 | 51.38 % |
| Crm.Integrations.PowerOffice | 748 | 803 | 93.15 % |
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
| Crm.SharedKernel | 293 | 320 | 91.56 % |
| Crm.TimeTracking | 689 | 798 | 86.34 % |
| Crm.TimeTracking.Contracts | 43 | 44 | 97.73 % |
| Crm.Web | 408 | 597 | 68.34 % |

Gate: **passed**

