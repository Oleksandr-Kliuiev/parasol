# 04. Модель данных

Логическая модель. Физические таблицы разнесены по схемам модулей ([03 § 5.1](03-architecture.md#51-модули-и-границы)); связи между схемами — по ID без внешних ключей.

**Общие поля всех бизнес-сущностей:** `Id` (последовательный GUID, см. [03 § 8](03-architecture.md#8-данные)), `CreatedAt`, `CreatedBy`, `ModifiedAt`, `ModifiedBy`, `RowVersion`, `IsDeleted`. Даты — `datetimeoffset` (UTC), отображение в Europe/Oslo. Деньги — `decimal(19,4)` + `Currency` (ISO 4217, по умолчанию NOK).

## 1. Клиенты, контакты, среды

```mermaid
erDiagram
  ORGANIZATION ||--o{ ORGANIZATION : "parent"
  ORGANIZATION ||--o{ ADDRESS : has
  ORGANIZATION ||--o{ ORGANIZATION_CONTACT : employs
  CONTACT ||--o{ ORGANIZATION_CONTACT : "works at"
  ORGANIZATION ||--o{ CUSTOMER_ENVIRONMENT : has
  ORGANIZATION ||--o{ ORGANIZATION_DOMAIN : owns
  USER ||--o{ ORGANIZATION : "account manager"

  ORGANIZATION {
    uuid Id
    string Name
    string OrgNumber "9 цифр, уникален"
    string LegalForm "AS, ENK, ASA…"
    string Status "Lead|Prospect|Customer|Former|Partner"
    string NaceCode
    string Segment "S|M|L"
    string InvoiceEmail
    bool EhfEnabled
    uuid AccountManagerId
    uuid PrimaryTechnicianId
    uuid ParentOrganizationId "группа компаний (FR-CUS-07)"
    bool BilledThroughParent "позиции идут в основание материнской (BR-BIL-12)"
    string BrregStatus "Active|Bankrupt|Dissolving|Deleted"
    datetime BrregCheckedAt
  }
  CONTACT {
    uuid Id
    string FirstName
    string LastName
    string Email
    string Phone "E.164"
    string PreferredLanguage
    bool MarketingConsent
  }
  ORGANIZATION_CONTACT {
    uuid OrganizationId
    uuid ContactId
    string Title
    string Roles "DecisionMaker,Technical,Billing,EndUser"
    bool IsPrimary
    bool IsActive
  }
  ADDRESS {
    uuid Id
    string Type "Postal|Billing|Visit"
    string Street
    string PostalCode
    string City
    string CountryCode
  }
  ORGANIZATION_DOMAIN {
    string Domain
    bool IsPrimary
  }
  CUSTOMER_ENVIRONMENT {
    uuid Id
    string Kind "M365Tenant|AteraCustomer|PowerOfficeClient"
    string ExternalId "tenantId / Atera CustomerID / PO client"
    string DisplayName
    string Details "JSON: домены, GDAP-статус, модули PO…"
    datetime LastSyncedAt
  }
```

## 2. Продажи и каталог

```mermaid
erDiagram
  LEAD }o--o| ORGANIZATION : "converted to"
  ORGANIZATION ||--o{ OPPORTUNITY : has
  OPPORTUNITY ||--o{ QUOTE : has
  QUOTE ||--o{ QUOTE : "next version (RootId)"
  QUOTE ||--o{ QUOTE_LINE : contains
  QUOTE_TEMPLATE }o--o{ QUOTE : "wording copied from"
  PRODUCT ||--o{ QUOTE_LINE : "priced as"
  PRODUCT ||--o{ PRICE : has
  PRICE_LIST ||--o{ PRICE : contains
  PRODUCT ||--o{ BUNDLE_ITEM : "bundle of"
  PIPELINE_STAGE ||--o{ OPPORTUNITY : "in stage"

  LEAD {
    uuid Id
    string CompanyName
    string OrgNumber
    string ContactName
    string Email
    string Source
    string Status "New|Qualified|Disqualified|Converted"
    uuid OwnerId
  }
  OPPORTUNITY {
    uuid Id
    uuid OrganizationId
    string Name
    string BusinessLine "Microsoft|MSP|PowerOffice|Mixed"
    uuid StageId
    int Probability
    date ExpectedCloseDate
    money OneOffAmount
    money Mrr
    int TermMonths
    string LostReason
    uuid OwnerId
  }
  QUOTE {
    uuid Id
    string Number "T-ГГГГ-NNNN, общий для всех версий"
    uuid RootId "первая версия предложения"
    int VersionNo
    uuid OrganizationId
    uuid OpportunityId
    uuid ContactId
    string Title
    string Language "nb|en"
    date IssuedOn
    date ValidUntil
    int TermMonths
    string Status "Draft|PendingApproval|Ready|Sent|Accepted|Declined|Expired|Superseded|Cancelled"
    decimal MaxDiscountPct
    uuid ApprovedBy
    datetime SentAt
    string IntroText
    string TermsText
  }
  QUOTE_LINE {
    uuid Id
    uuid QuoteId
    uuid ProductId "пусто у свободной позиции"
    string Sku
    string Name
    string Description
    decimal Quantity
    money UnitPrice "зафиксирована в версии"
    decimal DiscountPct
    string Recurrence "OneTime|Monthly"
    decimal VatRate
  }
  QUOTE_TEMPLATE {
    uuid Id
    string Name
    string Language "nb|en"
    string IntroText
    string TermsText
    string FooterText
    int ValidityDays
    bool IsDefault
  }
  PRODUCT {
    uuid Id
    string Sku
    string Type "MicrosoftLicense|ManagedService|HourlyService|HourBank|PowerOfficeService|Hardware|Bundle"
    string BusinessLine
    string Unit "user|device|hour|month|piece"
    decimal VatRate
    string MsOfferId "для MicrosoftLicense"
    string BillingTermDefault "P1M|P1Y"
    bool IsActive
  }
  PRICE_LIST {
    uuid Id
    string Name
    string CustomerCategory
    date ValidFrom
    date ValidTo
  }
  PRICE {
    uuid ProductId
    money UnitPrice
    money UnitCost
  }
```

Документ предложения (DEV-08) — `sales.QuoteDocuments`: ревизия на версию предложения, происхождение (Issued/Reconstructed), состояние (Preparing/Ready), снимок всех полей документа (JSON) и его SHA-256, ключ объекта в хранилище, имя файла, длина, SHA-256 PDF, версия рендера. Готовый документ не меняется и не удаляется (триггер `trg_QuoteDocuments_Protect`, запрет DELETE для ролей приложения); байты PDF — в контейнере `documents` (Azure Blob, приватный) или в папке хранилища при разработке.

## 3. Владение данными (system of record)

| Данные | Мастер | CRM | Atera | PowerOffice | Partner Center |
|---|---|---|---|---|---|
| Организация: название, оргномер, адрес | CRM (+ Brreg как источник) | RW | ← получает | ← получает | — |
| Адрес и e-mail для счетов, EHF | CRM (настраиваемо: PowerOffice) | RW | — | ← получает | — |
| Контакты | CRM | RW | ↔ (новые контакты из Atera импортируются) | ← контакт для счетов | — |
| Продукты и цены продажи | CRM | RW | — | ← код продукта (сопоставление) | — |
| Цены партнёра Microsoft | Partner Center / дистрибьютор | R | — | — | мастер |
| Контракты, SLA, пакеты часов | CRM | RW | — | — | — |
| CSP-подписки | Partner Center (или дистрибьютор) | R | — | — | мастер |
| Лицензии в тенанте клиента | Тенант клиента (Graph/GDAP) | R | — | — | — |
| Тикеты | Atera | R + создание | мастер | — | — |
| Агенты/устройства, алерты | Atera | R | мастер | — | — |
| Записи времени по тикетам | Atera | R + статус биллинга | мастер | — | — |
| Записи времени по проектам | CRM | RW | — | — | — |
| Основания для счетов | CRM | RW до утверждения, затем неизменяемы | — | ← заказы | — |
| Счета, кредит-ноты, оплаты, задолженность | PowerOffice | R | — | мастер | — |
| Пользователи, роли | Entra ID | R (+ настройки профиля) | сопоставление техников | — | — |

## 4. Контракты, лицензии, сервис, время

```mermaid
erDiagram
  ORGANIZATION ||--o{ CONTRACT : has
  CONTRACT ||--o{ CONTRACT_LINE : contains
  CONTRACT }o--|| SLA_POLICY : uses
  CONTRACT ||--o{ HOUR_BANK : includes
  HOUR_BANK ||--o{ HOUR_BANK_TRANSACTION : ledger
  PRODUCT ||--o{ CONTRACT_LINE : "priced as"
  ORGANIZATION ||--o{ CSP_SUBSCRIPTION : "licensed"
  CONTRACT_LINE |o--o{ CSP_SUBSCRIPTION : "bills"
  ORGANIZATION ||--o{ LICENSE_SNAPSHOT : "usage (GDAP)"
  ORGANIZATION ||--o{ TICKET : "service"
  ORGANIZATION ||--o{ DEVICE : "managed"
  ORGANIZATION ||--o{ DEVICE_COUNT_SNAPSHOT : daily
  TICKET ||--o{ TIME_ENTRY : "work hours"
  PROJECT ||--o{ TIME_ENTRY : "work hours"
  USER ||--o{ TIME_ENTRY : "technician"
  HOUR_BANK_TRANSACTION }o--|| TIME_ENTRY : "deducts"

  CONTRACT {
    uuid Id
    string Number
    string Type "MSP|Licensing|PowerOfficeSupport|HourBank|Mixed"
    string Status "Draft|Active|Suspended|NoticeGiven|Ended"
    date StartDate
    date EndDate
    bool AutoRenew
    int RenewalTermMonths
    int NoticePeriodDays
    string InvoiceFrequency "Monthly|Quarterly|Yearly"
    string InvoiceTiming "InAdvance|InArrears"
    bool Indexation
    string CustomerReference "ссылка/PO клиента"
  }
  CONTRACT_LINE {
    uuid Id
    uuid ProductId
    string QuantityModel "Fixed|PerAteraDevice|PerM365User|PerSubscription|Manual"
    string QuantityFilter "JSON: deviceType=Workstation, sku=…"
    decimal FixedQuantity
    money UnitPrice
    decimal DiscountPct
    date ValidFrom
    date ValidTo
  }
  SLA_POLICY {
    uuid Id
    string Name
    string Coverage "8x5|12x5|24x7"
    string ResponseTimes "JSON по P1–P4"
    decimal IncludedHoursPerMonth
    string CoveredWorkTypes
    decimal AfterHoursMultiplier
  }
  HOUR_BANK {
    uuid Id
    decimal PurchasedHours
    decimal RemainingHours
    date ValidFrom
    date ValidTo
    money OverageRate
  }
  CSP_SUBSCRIPTION {
    uuid Id
    string Source "PartnerCenter|Distributor|Manual"
    string CspCustomerId
    string TenantId
    string SubscriptionId
    string OfferId
    string SkuName
    int Quantity
    string Status
    string TermDuration "P1M|P1Y|P3Y"
    string BillingCycle "Monthly|Annual"
    datetime PurchasedAt
    datetime CancellationWindowEndsAt
    date CommitmentEndDate
    bool AutoRenew
    money PartnerUnitPrice
  }
  LICENSE_SNAPSHOT {
    uuid Id
    uuid OrganizationId
    date SnapshotDate
    string SkuId
    string SkuPartNumber
    int Purchased
    int Assigned
    datetime ReadAt
  }
  MS_BILLED_LINE {
    uuid Id
    string LineKey "источник:счёт:подписка:предложение:период"
    string Source "GraphExport|Csv"
    date PeriodStart
    date PeriodEnd
    string InvoiceId
    string CspCustomerId
    uuid OrganizationId "nullable"
    string SubscriptionId
    string OfferId
    decimal Quantity
    money UnitPrice
    money Total
    string Currency
  }
  TICKET {
    uuid Id
    int AteraTicketId
    string Title
    string Status
    string Priority
    string Type
    uuid ContactId
    uuid TechnicianId
    datetime CreatedAtSource
    datetime FirstResponseAt
    datetime ResolvedAt
  }
  DEVICE {
    uuid Id
    string AteraAgentId
    string MachineName
    string DeviceType "Workstation|Server|Network|Other"
    string Os
    bool Online
    datetime LastSeenAt
  }
  DEVICE_COUNT_SNAPSHOT {
    date SnapshotDate
    string DeviceType
    int Count
  }
  TIME_ENTRY {
    uuid Id
    string Source "Atera|Crm"
    string ExternalId
    uuid OrganizationId
    uuid TechnicianId
    date WorkDate
    decimal Hours
    string WorkType
    bool BillableAtSource
    bool AfterHours
    string Description
    string Status "New|Approved|NonBillable|Invoiced"
    uuid ProjectId "проект внедрения, только для ручных записей (FR-PRJ-01)"
    string Classification "Covered|HourBank|Rate"
    money Rate
    uuid BillingLineId
  }
```

## 5. Биллинг

```mermaid
erDiagram
  BILLING_RUN ||--o{ BILLING_BASIS : "per customer"
  BILLING_RUN ||--o{ BILLING_APPROVAL : "approved as"
  BILLING_LINE ||--o{ CHARGE : "bills"
  BILLING_BASIS ||--o{ BILLING_LINE : contains
  BILLING_BASIS ||--o| EXPORT_ATTEMPT : "exported via"
  BILLING_BASIS ||--o{ INVOICE : "resulted in"
  INVOICE ||--o{ PAYMENT : paid
  ORGANIZATION ||--o{ BILLING_BASIS : billed

  BILLING_RUN {
    uuid Id
    date PeriodStart
    date PeriodEnd
    string Kind "Regular|Supplementary (ADR-013)"
    string Status "Draft|Collected|InReview|Approved|Exporting|Exported|ExportedWithErrors|Closed"
    uuid ApprovedBy "зеркало действующего первого акта текущей ревизии"
    uuid SecondApprovedBy "зеркало действующего второго акта"
    datetime ApprovedAt
    bool RequiresSecondApproval
    int ContentRevision "растёт при сборе и изменении содержания, ADR-012"
    int ApprovedRevision "ревизия выпуска; 0 — legacy"
    string ApprovedDigest "SHA-256 канонического содержания выпуска; legacy"
  }
  BILLING_APPROVAL {
    uuid Id
    uuid RunId
    string Kind "First|Second"
    uuid ApprovedBy
    datetime ApprovedAt
    int ContentRevision
    string ContentDigest "SHA-256; legacy для подписей до DEV-02"
    string Policy "basis-total-ex-vat>200000"
    bool RequiredSecond
    datetime InvalidatedAt
    string InvalidationReason "Recollected|LinesChanged|BasisCancelled|ContentChanged|RuleChanged|Migrated"
  }
  BILLING_BASIS {
    uuid Id
    uuid OrganizationId
    string IdempotencyKey "period-org-run"
    money TotalExVat
    money PreviousPeriodTotal
    string Anomalies "JSON"
    string Status "Draft|Approved|Exported|Failed|Cancelled|ReconciliationRequired"
    string PowerOfficeOrderNo
    datetime SendStartedAt "отправка начата; пока не выгружено — заказ может существовать"
  }
  CHARGE {
    uuid Id
    string Key "обязанность: contract:{серия}:{с}:{по} | time:{allocation} | hourbank:{покупка} | pending:{позиция} | legacy:{строка}"
    string Kind "Contract|Time|TimeInfo|HourBankPurchase|OneOff|Legacy"
    uuid SeriesId
    date ServiceFrom
    date ServiceTo
    uuid ContractLineId
    uuid CorrectsLineId "корректировка выгруженной строки"
    uuid SourceOrganizationId
    uuid PayerOrganizationId
    string Currency "NOK"
    money Amount
    string Status "Reserved|Committed|ExportConfirmed|ReconciliationRequired|Released|LegacyUnresolved; unique Key среди не Released"
    uuid RunId
    uuid BasisId
    uuid LineId
    string Reason
  }
  BILLING_LINE {
    uuid Id
    string Group "Subscription|License|HourlyWork|HourBank|OneOff|Info"
    uuid ProductId
    string PowerOfficeProductCode
    string Description
    decimal Quantity
    money UnitPrice
    decimal DiscountPct
    decimal VatRate
    money LineTotal
    string SourceRefs "JSON: contractLineId, subscriptionId, timeEntryIds, allocationIds, hourBankEntryId"
    bool ManuallyAdjusted "совместимость: ручная или исправленная"
    string Origin "Collected|Manual"
    string SourceKey "ключ начисления, ADR-011; unique (BasisId, SourceKey) среди текущих"
    uuid SourceOrganizationId "кому оказана услуга; плательщик — организация основания"
    string SourceSignature "экономические значения источника при последнем сборе"
    money SourceUnitPrice
    decimal SourceQuantity
    string Decision "None|Override|Exclusion"
    string DecisionSignature "источник, против которого принято решение"
    string Conflict "None|SourceChanged|SourceRemoved|LegacyUnmatched"
    uuid ChangedBy
    datetime ChangedAt
    string ChangeReason
  }
  EXPORT_ATTEMPT {
    datetime At
    string Result
    string ErrorMessage
    string CorrelationId
  }
  INVOICE {
    uuid Id
    string PowerOfficeInvoiceNo
    date InvoiceDate
    date DueDate
    money TotalIncVat
    money Outstanding
    string Status "Draft|Sent|PartiallyPaid|Paid|Overdue|Credited"
  }
  PAYMENT {
    date PaidAt
    money Amount
  }
```

**Неизменяемость:** после утверждения `BILLING_BASIS` и `BILLING_LINE` защищены на уровне домена (исключение при попытке изменения) и триггером БД; корректировки — только новыми позициями в следующем прогоне.

**Реестр начислений** (`billing.Charges`, [ADR-013](adr/ADR-013-charge-register.md)): одна действующая обязанность на ключ между всеми прогонами; сбор под блокировкой реестра вычитает уже занятые дни серии договора, утверждение фиксирует, выгрузка подтверждает, неизвестный исход отправки требует сверки, отмена до отправки освобождает.

**Разовые позиции из принятых предложений и завершённых этапов проектов** (`billing.PendingCharges`): организация, продукт, описание, количество, цена, скидка, ставка МВА, источник (`SourceType` = `quote` или `project-phase`, `SourceId`, `SourceLineId` — уникальны вместе) и дата, с которой позицию можно выставлять. Прогон включает все незакрытые позиции, а закрывает их (`InvoicedBasisId`) только когда основание действительно выгружено, поэтому отменённый или пересобранный прогон ничего не теряет и не выставляет дважды (BR-SAL-07).

## 6. Активности, проекты, интеграции, аудит

```mermaid
erDiagram
  ACTIVITY }o--|| ORGANIZATION : "regarding"
  ACTIVITY }o--o{ CONTACT : participants
  CUSTOM_FIELD_DEFINITION ||--o{ CUSTOM_FIELD_VALUE : answered
  PROJECT ||--o{ PROJECT_PHASE : has
  PROJECT ||--o{ PROJECT_MEMBER : team
  PROJECT_PHASE ||--o{ PROJECT_TASK : has
  EXTERNAL_LINK }o--|| ANY_ENTITY : maps
  AUDIT_ENTRY }o--|| ANY_ENTITY : tracks

  ACTIVITY {
    uuid Id
    string Type "Task|Call|Meeting|Note|Email"
    uuid OrganizationId "обязательна"
    uuid OpportunityId "необязательно"
    uuid ContractId "необязательно"
    uuid ContactId
    string Subject
    string Body "для Email — только предпросмотр, не тело"
    datetime DueAt "начало встречи или срок задачи"
    int DurationMinutes "встреча"
    string Location "встреча"
    string Status
    uuid AssigneeId
    string GraphEventId "событие в календаре организатора (FR-ACT-02)"
    datetime CalendarSyncedAt
    string ExternalMessageId "internetMessageId сохранённого письма (FR-ACT-03)"
    string FromAddress
    string WebLink "ссылка в Outlook"
  }
  PROJECT {
    uuid Id
    string Number "P-ГГГГ-NNNN, уникален"
    uuid OrganizationId
    string Name
    string Type "M365Migration|PowerOfficeImplementation|AteraRollout|Other"
    string Status "Planned|Active|OnHold|Completed|Cancelled"
    string BillingModel "Fixed|TimeAndMaterial|PerPhase"
    uuid ManagerId
    decimal BudgetHours
    money BudgetAmount
    date StartDate
    date EndDate
    date CompletedOn
    uuid ContractId "необязательно"
    uuid OpportunityId "необязательно"
  }
  PROJECT_PHASE {
    uuid Id
    uuid ProjectId
    int Order
    string Name
    string Status "Planned|Active|Completed|Cancelled"
    date PlannedStart
    date PlannedEnd
    decimal PlannedHours
    money Fee
    bool BillOnCompletion "завершение ставит позицию в billing.PendingCharges"
    uuid ProductId "необязательно"
    date CompletedOn
  }
  PROJECT_TASK {
    uuid Id
    uuid PhaseId
    string Title
    uuid AssigneeId
    date DueDate
    decimal EstimatedHours
    string Status "Open|InProgress|Done|Cancelled"
  }
  PROJECT_MEMBER {
    uuid Id
    uuid ProjectId
    uuid UserId "участник команды (DEV-09): вместе с руководителем и исполнителями задач — те, кому назначен проект"
    bool IsDeleted "удаление мягкое: журнал аудита хранит, кто и когда имел доступ"
  }
  CUSTOM_FIELD_DEFINITION {
    uuid Id
    string Entity "Organization|Opportunity|Contract"
    string Key "уникален в рамках Entity"
    string Label
    string Type "Text|Number|Date|Boolean|Select"
    string Options "варианты списка"
    bool Required
    int Order
    string Hint
    bool IsActive
  }
  CUSTOM_FIELD_VALUE {
    uuid Id
    uuid DefinitionId
    string Entity
    uuid EntityId "ссылка по id, без внешнего ключа"
    string Value
  }
  EXTERNAL_LINK {
    string EntityType
    uuid EntityId
    string System "Atera|PowerOffice|PartnerCenter|Graph|Brreg"
    string ExternalType
    string ExternalId
    datetime LinkedAt
  }
  AUDIT_ENTRY {
    bigint Id
    datetime At
    uuid UserId
    string Action "Create|Update|Delete|Export|Approve|Login|Merge"
    string EntityType
    uuid EntityId
    string Changes "JSON diff"
    string CorrelationId
    string IpAddress
  }
```

## 7. Индексы и ограничения (ключевые)

| Таблица | Индекс / ограничение |
|---|---|
| `customers.Organization` | UNIQUE (`OrgNumber`) WHERE `IsDeleted = 0 AND OrgNumber IS NOT NULL`; FTS (`Name`) |
| `customers.OrganizationDomain` | UNIQUE (`Domain`) |
| `customers.Contact` | INDEX (`Email`); FTS (`FirstName`, `LastName`, `Email`) |
| `integration.ExternalLink` | UNIQUE (`System`, `ExternalType`, `ExternalId`); UNIQUE (`EntityType`, `EntityId`, `System`, `ExternalType`) |
| `time.TimeEntry` | UNIQUE (`Source`, `ExternalId`); INDEX (`OrganizationId`, `WorkDate`, `Status`) |
| `service.Ticket` | UNIQUE (`AteraTicketId`); INDEX (`OrganizationId`, `Status`) |
| `licensing.CspSubscription` | UNIQUE (`Source`, `SubscriptionId`); INDEX (`CommitmentEndDate`) |
| `customfields.CustomFieldDefinition` | UNIQUE (`Entity`, `Key`) WHERE `IsDeleted = 0`; INDEX (`Entity`, `Order`) |
| `customfields.CustomFieldValue` | UNIQUE (`DefinitionId`, `EntityId`) WHERE `IsDeleted = 0`; INDEX (`Entity`, `EntityId`) |
| `projects.Project` | UNIQUE (`Number`); INDEX (`OrganizationId`, `Status`) |
| `projects.ProjectPhase` | INDEX (`ProjectId`) |
| `projects.ProjectTask` | INDEX (`PhaseId`); INDEX (`AssigneeId`, `Status`) |
| `projects.ProjectMember` | UNIQUE (`ProjectId`, `UserId`) WHERE `IsDeleted = 0`; INDEX (`UserId`) |
| `time.TimeEntry` (проект) | INDEX (`ProjectId`) WHERE `ProjectId IS NOT NULL` |
| `customers.Organization` (группа) | INDEX (`ParentId`) WHERE `ParentId IS NOT NULL` |
| `licensing.LicenseSnapshot` | UNIQUE (`OrganizationId`, `SnapshotDate`, `SkuId`); INDEX (`SnapshotDate`) |
| `licensing.MsBilledLine` | UNIQUE (`LineKey`); INDEX (`PeriodStart`, `OrganizationId`) |
| `billing.BillingBasis` | UNIQUE (`IdempotencyKey`) |
| `billing.BillingRun` | UNIQUE (`PeriodStart`) WHERE `Status <> 'Closed'` |
| `audit.AuditEntry` | Кластерный по `At`; INDEX (`EntityType`, `EntityId`); секционирование по году |

## 8. Сроки хранения

| Данные | Срок | Основание |
|---|---|---|
| Основания для счетов, прогоны, аудит финансовых действий | 5 лет после окончания отчётного года | Bokføringsloven |
| Контакты бывших клиентов | 3 года после окончания отношений, затем анонимизация | GDPR, законный интерес |
| Лиды без конверсии | 2 года без активности, затем удаление | GDPR, минимизация |
| Зеркало тикетов | 3 года (источник — Atera) | Минимизация |
| `ExternalRecord` (сырые payload) | 90 дней | Отладка |
| Журнал синхронизаций | 180 дней | Эксплуатация |
| Журнал аудита (нефинансовый) | 5 лет | Безопасность |

Уточнить у заказчика и юриста на Этапе 0 ([09](09-assumptions-questions.md)).
