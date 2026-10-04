## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 1268 | 1315 | 96.43 % | 90 % | pass | 90.16 % of 752 |
| Rest of the backend (src/) | 16113 | 18741 | 85.98 % | 70 % | pass | 69.84 % of 9158 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 34558 lines
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
| Crm.Audit | 181 | 251 | 72.11 % |
| Crm.Authorization | 102 | 103 | 99.03 % |
| Crm.Billing | 2251 | 2479 | 90.80 % |
| Crm.Billing.Contracts | 40 | 43 | 93.02 % |
| Crm.Catalog | 838 | 973 | 86.13 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1528 | 1634 | 93.51 % |
| Crm.Contracts.Contracts | 73 | 75 | 97.33 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1557 | 1685 | 92.40 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 221 | 249 | 88.76 % |
| Crm.Identity.Contracts | 24 | 24 | 100.00 % |
| Crm.Infrastructure | 803 | 864 | 92.94 % |
| Crm.Integrations.Atera | 682 | 849 | 80.33 % |
| Crm.Integrations.Brreg | 117 | 165 | 70.91 % |
| Crm.Integrations.Core | 877 | 1005 | 87.26 % |
| Crm.Integrations.MicrosoftGraph | 463 | 539 | 85.90 % |
| Crm.Integrations.PartnerCenter | 297 | 578 | 51.38 % |
| Crm.Integrations.PowerOffice | 760 | 816 | 93.14 % |
| Crm.Licensing | 824 | 889 | 92.69 % |
| Crm.Licensing.Contracts | 44 | 46 | 95.65 % |
| Crm.Notifications | 482 | 567 | 85.01 % |
| Crm.Notifications.Contracts | 12 | 12 | 100.00 % |
| Crm.Projects | 466 | 538 | 86.62 % |
| Crm.Projects.Contracts | 9 | 11 | 81.82 % |
| Crm.Reports | 246 | 324 | 75.93 % |
| Crm.Sales | 1506 | 1835 | 82.07 % |
| Crm.Sales.Contracts | 35 | 37 | 94.59 % |
| Crm.Service | 514 | 581 | 88.47 % |
| Crm.Service.Contracts | 25 | 27 | 92.59 % |
| Crm.ServiceDefaults | 26 | 28 | 92.86 % |
| Crm.SharedKernel | 293 | 320 | 91.56 % |
| Crm.TimeTracking | 691 | 799 | 86.48 % |
| Crm.TimeTracking.Contracts | 43 | 44 | 97.73 % |
| Crm.Web | 611 | 805 | 75.90 % |

Gate: **passed**

