## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 1268 | 1315 | 96.43 % | 90 % | pass | 90.16 % of 752 |
| Rest of the backend (src/) | 16800 | 19318 | 86.97 % | 70 % | pass | 71.23 % of 9432 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 36073 lines
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
| Crm.Audit | 187 | 251 | 74.50 % |
| Crm.Authorization | 102 | 103 | 99.03 % |
| Crm.Billing | 2251 | 2479 | 90.80 % |
| Crm.Billing.Contracts | 40 | 43 | 93.02 % |
| Crm.Catalog | 838 | 973 | 86.13 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1527 | 1634 | 93.45 % |
| Crm.Contracts.Contracts | 73 | 75 | 97.33 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1557 | 1685 | 92.40 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 221 | 249 | 88.76 % |
| Crm.Identity.Contracts | 24 | 24 | 100.00 % |
| Crm.Infrastructure | 905 | 967 | 93.59 % |
| Crm.Integrations.Atera | 681 | 849 | 80.21 % |
| Crm.Integrations.Brreg | 117 | 165 | 70.91 % |
| Crm.Integrations.Core | 877 | 1005 | 87.26 % |
| Crm.Integrations.MicrosoftGraph | 463 | 539 | 85.90 % |
| Crm.Integrations.PartnerCenter | 297 | 578 | 51.38 % |
| Crm.Integrations.PowerOffice | 760 | 816 | 93.14 % |
| Crm.Licensing | 824 | 889 | 92.69 % |
| Crm.Licensing.Contracts | 44 | 46 | 95.65 % |
| Crm.Notifications | 482 | 567 | 85.01 % |
| Crm.Notifications.Contracts | 12 | 12 | 100.00 % |
| Crm.Projects | 542 | 610 | 88.85 % |
| Crm.Projects.Contracts | 11 | 11 | 100.00 % |
| Crm.Reports | 246 | 324 | 75.93 % |
| Crm.Sales | 1910 | 2148 | 88.92 % |
| Crm.Sales.Contracts | 35 | 37 | 94.59 % |
| Crm.Service | 518 | 581 | 89.16 % |
| Crm.Service.Contracts | 25 | 27 | 92.59 % |
| Crm.ServiceDefaults | 26 | 28 | 92.86 % |
| Crm.SharedKernel | 319 | 342 | 93.27 % |
| Crm.TimeTracking | 708 | 817 | 86.66 % |
| Crm.TimeTracking.Contracts | 43 | 44 | 97.73 % |
| Crm.Web | 663 | 854 | 77.63 % |

Gate: **passed**

