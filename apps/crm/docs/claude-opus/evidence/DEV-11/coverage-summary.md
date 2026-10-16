## Coverage (NFR-10)

Reports: unit.cobertura.xml, integration.cobertura.xml

| Scope | Covered lines | Coverable lines | Line coverage | Threshold | Result | Branch coverage (info) |
|---|---:|---:|---:|---:|---|---:|
| Domain of Billing, Contracts, TimeTracking | 1269 | 1315 | 96.50 % | 90 % | pass | 90.16 % of 752 |
| Rest of the backend (src/) | 18635 | 21299 | 87.49 % | 70 % | pass | 72.95 % of 10312 |

Excluded from the denominator:

- EF Core migrations and model snapshots (generated): 39335 lines
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
| Crm.Activities | 486 | 581 | 83.65 % |
| Crm.Activities.Contracts | 30 | 32 | 93.75 % |
| Crm.Audit | 226 | 327 | 69.11 % |
| Crm.Authorization | 122 | 123 | 99.19 % |
| Crm.Billing | 2253 | 2479 | 90.88 % |
| Crm.Billing.Contracts | 40 | 43 | 93.02 % |
| Crm.Catalog | 838 | 973 | 86.13 % |
| Crm.Catalog.Contracts | 15 | 15 | 100.00 % |
| Crm.Contracts | 1528 | 1634 | 93.51 % |
| Crm.Contracts.Contracts | 73 | 75 | 97.33 % |
| Crm.CustomFields | 210 | 234 | 89.74 % |
| Crm.Customers | 1674 | 1810 | 92.49 % |
| Crm.Customers.Contracts | 53 | 53 | 100.00 % |
| Crm.Identity | 324 | 358 | 90.50 % |
| Crm.Identity.Contracts | 27 | 27 | 100.00 % |
| Crm.Infrastructure | 921 | 980 | 93.98 % |
| Crm.Integrations.Atera | 689 | 856 | 80.49 % |
| Crm.Integrations.Brreg | 117 | 165 | 70.91 % |
| Crm.Integrations.Core | 1027 | 1173 | 87.55 % |
| Crm.Integrations.MicrosoftGraph | 551 | 629 | 87.60 % |
| Crm.Integrations.PartnerCenter | 297 | 578 | 51.38 % |
| Crm.Integrations.PowerOffice | 760 | 816 | 93.14 % |
| Crm.Licensing | 824 | 889 | 92.69 % |
| Crm.Licensing.Contracts | 44 | 46 | 95.65 % |
| Crm.Notifications | 482 | 567 | 85.01 % |
| Crm.Notifications.Contracts | 12 | 12 | 100.00 % |
| Crm.Privacy | 872 | 961 | 90.74 % |
| Crm.Privacy.Contracts | 21 | 21 | 100.00 % |
| Crm.Projects | 547 | 610 | 89.67 % |
| Crm.Projects.Contracts | 11 | 11 | 100.00 % |
| Crm.Reports | 247 | 325 | 76.00 % |
| Crm.Sales | 2027 | 2293 | 88.40 % |
| Crm.Sales.Contracts | 35 | 37 | 94.59 % |
| Crm.Service | 589 | 654 | 90.06 % |
| Crm.Service.Contracts | 25 | 27 | 92.59 % |
| Crm.ServiceDefaults | 26 | 28 | 92.86 % |
| Crm.SharedKernel | 319 | 342 | 93.27 % |
| Crm.TimeTracking | 708 | 817 | 86.66 % |
| Crm.TimeTracking.Contracts | 43 | 44 | 97.73 % |
| Crm.Web | 811 | 969 | 83.69 % |

Gate: **passed**

