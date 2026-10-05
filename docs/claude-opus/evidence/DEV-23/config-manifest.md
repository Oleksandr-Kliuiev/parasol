# Конфигурационный manifest (DEV-23)

Снимок разрешённых настроек **без секретов и без выдуманных значений**. Источники (все прочитаны при составлении): `src/Hosts/Crm.Web/appsettings.json`, `src/Hosts/Crm.Worker/appsettings.json`, `src/Hosts/Crm.Web/Program.cs`, `src/Hosts/Crm.Worker/Program.cs`, классы options в `src/**`, `infra/main.bicep`, `infra/modules/apps.bicep`, `infra/env/prod.bicepparam`, `infra/env/test.bicepparam`, `infra/entra/register-app.sh`, `.github/workflows/promote.yml`.

Состояние: `HEAD` = `b6da6a8` (ветка `codex/readiness`). Код, `infra/`, `tools/`, `.github/` и `web/` в рабочей копии совпадают с `HEAD` (`git diff --stat HEAD` по этим путям пуст); незафиксированы только документы (`CLAUDE.md`, `docs/…`).

Чего здесь **нет**, потому что не существует: идентификаторов tenant и приложений Entra (в bicepparam — переменные окружения, не значения), адресов окружений, digest образов `crm-web` и `crm-worker`, SHA релиза, имён владельцев и адресов получателей алертов. Digest-ы появляются только в release manifest, который строит `release.yml` (`python3 tools/release/release.py manifest-create …`); конвейер ни разу не выполнялся, поэтому manifest этого релиза отсутствует (см. `known-limitations.md` KL-O01).

Условные обозначения: **Bicep** — задаёт `infra/modules/apps.bicep` из параметров `infra/main.bicep`; **bicepparam** — значение зафиксировано в `infra/env/<env>.bicepparam`; **GitHub var** — значение приходит в bicepparam из переменной окружения конвейера (`readEnvironmentVariable`); **код** — значение по умолчанию в `appsettings.json` или в классе options, не переопределяется инфраструктурой; **owner** — решение/значение даёт владелец, место фиксации не определено репозиторием.

## 1. Настройки, при неверном значении которых Production не запускается

Все проверки найдены чтением кода; в колонке «Где проверяется» указан файл.

| Настройка | Где проверяется | Условие отказа | Что делает Bicep |
|---|---|---|---|
| `AllowedHosts` | `src/Hosts/Crm.Web/Http/HostSecurity.cs` (`AllowedHostsProblem`), вызов в `Program.cs` до `builder.Build()` | В среде `Production` пусто или содержит `*` → `InvalidOperationException`, crm-web не стартует. Только crm-web; worker не проверяет. В `appsettings.json` значение по умолчанию `"*"`. | `AllowedHosts` = `ca-crm-web-<env>.<defaultDomain>;ca-crm-web-<env>---candidate.<defaultDomain>` |
| `AzureAd:TenantId` | `src/Hosts/Crm.Web/Auth/AuthenticationSetup.cs` (`TenantProblem`) | Вне `Development` должен быть GUID (не нулевой) или доменное имя; пустое, `common`, `organizations`, `consumers` → отказ. Нулевой GUID `00000000-…` (значение по умолчанию в bicepparam, если `CRM_ENTRA_TENANT_ID` не задана) тоже отказ, т. к. проверка требует `id != Guid.Empty`. Действует и для задачи миграций (она передаёт `AzureAd__TenantId`). | `AzureAd__TenantId` = `entraTenantId` |
| `Auth:Mode` | `AuthenticationSetup.cs` | `Development` вне среды `Development` → отказ. | `ASPNETCORE_ENVIRONMENT=Production`, `Auth:Mode` по умолчанию `Entra` |
| `DataProtection:BlobUri`, `DataProtection:KeyVaultKeyUri` | `src/Hosts/Crm.Web/Http/DataProtectionSetup.cs` (`Problem`) | Задана только одна из двух — отказ в любой среде; в `Production` не заданы обе — отказ (все реплики должны делить одно кольцо ключей). Только crm-web. | `DataProtection__BlobUri`, `DataProtection__KeyVaultKeyUri` из `data.bicep` |
| `Documents:Provider`, `Documents:BlobContainerUri` | `src/BuildingBlocks/Crm.Infrastructure/Documents/DocumentStores.cs` (`DocumentStoreOptionsValidation`, `ValidateOnStart`) | `FileSystem` в `Production` → отказ; `AzureBlob` без абсолютного `BlobContainerUri` → отказ. Оба хоста и задача миграций. | `Documents__Provider=AzureBlob`, `Documents__BlobContainerUri` |
| Адреса интеграций | `ValidateOnStart` в `BrregModule.cs`, `PowerOfficeModule.cs`, `PartnerCenterModule.cs`, `MicrosoftGraphModule.cs` (`GraphOptions.IsValid`), `AteraModule.cs` | Любой адрес не `https` → отказ **в любой среде**: `Integrations:Brreg:BaseUrl`, PowerOffice `BaseUrl`/`TokenUrl` (эффективные), PartnerCenter `BaseUrl`/`GraphBaseUrl`/токен, Atera `BaseUrl`, Graph `BaseUrl`. Каналы Teams: адрес должен быть https и хост — из `Teams:AllowedHostSuffixes` (по умолчанию `logic.azure.com`, `powerplatform.com`, `webhook.office.com`, `office.com`; локальный loopback допускается). В сообщении об ошибке — только имя настройки, не URL. | Адреса по умолчанию в коде (https); Bicep их не переопределяет |
| `Integrations:PowerOffice:Environment` против `Deployment:Environment` | `PowerOfficeModule.cs` + `PowerOfficeOptions.FitsDeployment` (`ValidateOnStart`) | Если PowerOffice `Enabled`: `Deployment:Environment=prod` требует `Production`, `test` требует `Demo`, любое другое непустое имя → отказ; пустое `Deployment:Environment` допускает оба (разработка). При `Enabled=false` проверка проходит. | `Deployment__Environment=<env>`; `Integrations__PowerOffice__Environment` = `powerOfficeEnvironment`, зафиксирован в bicepparam: prod → `Production`, test → `Demo` |
| `Bi:Enabled` | `src/Hosts/Crm.Web/Auth/BiAuthentication.cs` | `true` без `Bi:TenantId`, `Bi:Audience` и хотя бы одного `Bi:AllowedClients` → отказ crm-web. | `Bi__Enabled` = `biEnabled` (по умолчанию `false`), `Bi__TenantId`, `Bi__Audience`, `Bi__AllowedClients__<i>` |
| `Forwarded:KnownNetworks`, `Forwarded:KnownProxies` | `HostSecurity.ConfigureForwardedHeaders` | Не CIDR / не IP → отказ. Если оба пусты вне Development — доверяются частные сети (10/8, 172.16/12, 192.168/16, fd00::/8). | `Forwarded__KnownNetworks__0` = подсеть приложений |
| `OTEL`/`APPLICATIONINSIGHTS_CONNECTION_STRING` | `ServiceDefaultsExtensions.cs` | Не проверяется на старте (экспорт включается, если задана). | `APPLICATIONINSIGHTS_CONNECTION_STRING` |

Проверок, которые я **не нашёл** в коде (не утверждается, что их нет): отказ при нулевом `AzureAd:ClientId`; отказ при пустой `ConnectionStrings:crm`.

## 2. Что задаёт инфраструктура (Bicep → переменные окружения)

crm-web (`ca-crm-web-<env>`), crm-worker (`ca-crm-worker-<env>`), задача миграций (`caj-crm-migrate-<env>`). «Общие» — во всех трёх.

| Переменная | Кто | Смысл | Кто задаёт значение | Безопасное значение | Если неверно |
|---|---|---|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | общие | Среда ASP.NET | Bicep: `Production` | `Production` | `Development` включил бы Development-ветки; Bicep не допускает |
| `Deployment__Environment` | общие | Имя окружения (`test`/`prod`) для проверок | Bicep из `environmentName` | `test` / `prod` | PowerOffice отказ (см. §1) |
| `Documents__Provider`, `Documents__BlobContainerUri` | общие | Хранилище PDF, журнала внешних эффектов, переключателя обслуживания, манифестов, снимков BI | Bicep | `AzureBlob` | отказ старта |
| `Authorization__RecordScope` | общие | Записевой охват предложений/проектов | bicepparam: `Restricted` (оба окружения) | `Restricted` | `Open` — все с `sales.read`/`projects.read` видят всё; при каждом старте crm-web пишет предупреждение |
| `Maintenance__ForceReadOnly` | общие | Режим «только чтение» по конфигурации | GitHub var `CRM_MAINTENANCE_FORCE_READ_ONLY` (по умолчанию `false`) | `false` | `true` — CRM только читает и ничего не отправляет; снимается только новым развёртыванием |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | общие | Телеметрия | Bicep из `monitoring.bicep` | — | нет телеметрии → алерты «телеметрия отсутствует» |
| `Monitoring__Freshness__<job>` | общие | Свежесть синхронизации, минуты | Bicep (`monitoringFreshness`): `atera-tickets` 15, `atera-tickets-recent` 15, `poweroffice-invoices` 90 | как в `main.bicep` | ложные/пропущенные алерты свежести (DEC-09: значения предложены, не утверждены) |
| `ConnectionStrings__crm` | общие | SQL, вход по managed identity своей удостоверяющей записи | Bicep | — | нет доступа к БД; readiness не проходит |
| `AZURE_CLIENT_ID` | общие | Какой identity использует SDK | Bicep | — | чужие права |
| `OTEL_SERVICE_NAME` | общие | `crm-web` / `crm-worker` / `crm-migrator` | Bicep | — | — |
| `AllowedHosts`, `Forwarded__KnownNetworks__0` | web | Допустимые хосты и доверенный прокси | Bicep | см. §1 | отказ старта / неверный redirect URI |
| `AzureAd__TenantId`, `AzureAd__ClientId`, `AzureAd__ClientCertificates__0__*` | web (+ `TenantId`, `ClientId` в migrate) | Вход Entra; сертификат `crm-web-auth` из Key Vault | GitHub vars `CRM_ENTRA_TENANT_ID`, `CRM_ENTRA_CLIENT_ID_TEST` / `CRM_ENTRA_CLIENT_ID_PROD` (по умолчанию в bicepparam — нулевые GUID); имя сертификата `entraCertificateName` = `crm-web-auth` | реальные идентификаторы владельца tenant | отказ старта (tenant); вход не работает (client, сертификат) |
| `DataProtection__BlobUri`, `DataProtection__KeyVaultKeyUri` | web | Общее кольцо ключей cookie | Bicep (`data.bicep`) | — | отказ старта |
| `Integrations__MicrosoftGraph__Enabled`, `…TenantId`, `…ManagedIdentityClientId` | web, worker | Графовые задания и подтверждение ролей | Bicep: `Enabled=true` **безусловно** | — | без прав Graph синхронизация ролей падает: через 5 минут привилегированные действия требуют нового входа |
| `Integrations__MicrosoftGraph__CrmAppId` | worker | Приложение, чьи App Roles читает синхронизация ролей | Bicep из `entraClientId` | — | синхронизация ролей не работает |
| `Bi__Enabled`, `Bi__TenantId`, `Bi__Audience`, `Bi__AllowedClients__<i>` | web | BI-API | GitHub vars `CRM_BI_ENABLED`, `CRM_BI_AUDIENCE`, `CRM_BI_CLIENTS` (через запятую) | `false` / пусто | см. §1 |
| `Integrations__PowerOffice__Enabled`, `…Environment`; `Integrations__Atera__Enabled`; `Integrations__PartnerCenter__Enabled`; `Integrations__MicrosoftGraph__Teams__Enabled` | web, worker | Включение интеграций | GitHub vars `CRM_ENABLE_POWEROFFICE`, `CRM_ENABLE_ATERA`, `CRM_ENABLE_PARTNERCENTER`, `CRM_ENABLE_TEAMS` (по умолчанию `false`); среда PowerOffice зафиксирована в bicepparam | `false` до готовности среды | см. §3 |
| `Integrations__PartnerCenter__TenantId`, `…ClientId` | worker | Идентификаторы (не секреты) | GitHub vars `CRM_PARTNERCENTER_TENANT_ID`, `CRM_PARTNERCENTER_CLIENT_ID` | — | `IsConfigured` ложно → задания не работают |
| Секреты провайдеров (`Integrations__PowerOffice__ApplicationKey/ClientKey/SubscriptionKey`, `Integrations__Atera__ApiKey`, `Integrations__PartnerCenter__ClientSecret/RefreshToken`, `Integrations__MicrosoftGraph__Teams__Channels__Sales/Finance/Operations`) | **только worker** | Ссылки Container Apps на секреты Key Vault: `poweroffice-application-key`, `poweroffice-client-key`, `poweroffice-subscription-key`, `atera-api-key`, `partnercenter-client-secret`, `partnercenter-refresh-token`, `teams-webhook-sales`, `teams-webhook-finance`, `teams-webhook-operations` | Operations, Key Vault; значения в репозитории не хранятся | секреты существуют до включения интеграции | ревизия не стартует (нет секрета) или интеграция не авторизуется |
| `Database__WebIdentityName/ClientId`, `Database__WorkerIdentityName/ClientId`, `Auth__Mode=Entra`, `Hangfire__DashboardEnabled=false` | migrate | Мигратор создаёт пользователей БД и права `crm_web` / `crm_worker` | Bicep | — | роли БД не создаются |

Параметры `main.bicep`, влияющие на инфраструктуру: `environmentName` (`test`/`prod`), `location` (`norwayeast`), `webMinReplicas` (prod 2, test 1; максимум 4), `sqlMaxVCores` (prod 4, test 2), `entraCertificateName` (`crm-web-auth`), `bootstrapImages` (GitHub var `CRM_BOOTSTRAP`), `webImageDigest`/`workerImageDigest`/`webStableRevision`/`releaseCommit` (GitHub vars `CRM_WEB_IMAGE_DIGEST`, `CRM_WORKER_IMAGE_DIGEST`, `CRM_WEB_STABLE_REVISION`, `CRM_RELEASE_COMMIT`), `tags`. Образы ссылаются на digest (`crm-web@<digest>`), не на тег; worker — одна ревизия, одна реплика (min = max = 1).

## 3. Флаги, которые должны оставаться выключенными, пока окружение не готово

Колонка «Как включается» показывает, есть ли у флага параметр в Bicep. Если параметра нет, значение берётся из кода, а изменить его в Production можно только правкой `apps.bicep` (новая ревизия) — иначе ручная правка переменной контейнера будет перезаписана следующим развёртыванием шаблона (поведение Container Apps при развёртывании шаблона не проверялось).

| Флаг | Значение по умолчанию | Как включается | Когда можно включать | Что произойдёт при включении |
|---|---|---|---|---|
| `Integrations:PowerOffice:WriteEnabled` | `false` (код) | параметра Bicep нет | После проверки в Demo и сверки (runbook 02 §1.4–1.5; EXT-03) | Создание клиентов/контактов и **заказов на продажу** в PowerOffice; в пилоте включать запрещено (runbook 18 §9) |
| `Integrations:Atera:WriteEnabled`, `Integrations:Atera:WriteAllowedCustomerIds` | `false`, пустой список (код) | параметра Bicep нет | После проверки (EXT-03); список ограничивает клиентов | Создание тикетов и контактов в Atera |
| Partner Center | флага записи **нет** (зеркало только для чтения); `Integrations:PartnerCenter:Enabled` = `enablePartnerCenter` (`false`) | `CRM_ENABLE_PARTNERCENTER` | После выдачи секретов и GDAP (EXT-03) | Чтение клиентов, подписок, лицензий и счетов Microsoft |
| `Sales:EmailEnabled` | `false` (код) | параметра Bicep нет | После EXT-01/EXT-11 и почтового ящика отправителя | Письма с предложениями клиентам (внешний эффект, журнал внешних эффектов) |
| `Integrations:MicrosoftGraph:MailEnabled`, `…CalendarEnabled` | `false` (код) | параметра Bicep нет | После согласия и проверки делегированных прав | Чтение почты сотрудника / запись встреч в Outlook |
| `Notifications:EmailEnabled` (+ `FromAddress`, `AppBaseUrl`) | `false` (код) | параметра Bicep нет | Когда есть ящик отправителя | Письма-дайджесты сотрудникам |
| `Integrations:MicrosoftGraph:Teams:Enabled` | `false` | `CRM_ENABLE_TEAMS` | После секретов `teams-webhook-*` и проверки белого списка хостов | Карточки в каналы Teams (без ключа идемпотентности возможен дубль) |
| `Integrations:MicrosoftGraph:SharePoint:Enabled` (+ `SiteId`) | `false` (код) | параметра Bicep нет | После права `Sites.Selected` | Папки клиентов в SharePoint |
| `Bi:Enabled` | `false` | `CRM_BI_ENABLED` + `CRM_BI_AUDIENCE` + `CRM_BI_CLIENTS` | После регистрации BI-приложения и выбора способа обновления (EXT-08) | Открывает `/api/v1/bi/v1` для токенов приложений |
| `Hangfire:DashboardEnabled` | **`true`** (код: `appsettings.json` и значение по умолчанию в `Program.cs`) | Для crm-web параметра Bicep нет (для задачи миграций задано `false`) | Панель `/admin/jobs` включена в Production; доступ — `integrations.manage`, POST — свежее подтверждение и anti-forgery. Отключение требует правки Bicep | — |
| `OpenApi:Enabled` | `IsDevelopment()` → в Production **выключено** (код) | параметра Bicep нет | Только если будет принято решение | Карта всех маршрутов; только для `integrations.manage` |
| `Authorization:RecordScope` | `Restricted` | bicepparam `recordScope` (оба окружения `Restricted`) | `Open` — только как датированное исключение (runbook 11 §1) | Все с `sales.read`/`projects.read` видят все предложения/проекты |
| `Maintenance:ForceReadOnly` | `false` | `CRM_MAINTENANCE_FORCE_READ_ONLY` на одно развёртывание | Только при отказе хранилища документов (runbook 03 §2) | Только чтение до нового развёртывания без переменной |
| `monitoringNotificationsEnabled` (+ `monitoringOperationsOwner`, `monitoringFinanceOwner`, `monitoringOperationsEmails`, `monitoringFinanceEmails`, `monitoringRunbookUrl`, `monitoringThresholds`) | `false`, пусто (`main.bicep`) | **Не заданы** в `prod.bicepparam` / `test.bicepparam` | После EXT-01 (владельцы и адресаты подтверждены; значения закрепить в bicepparam, иначе следующий выпуск вернёт значения по умолчанию — runbook 15) | Доставка алертов людям; сейчас выключена |
| `monitoringEntraOnlyIngestion` | `false` | параметра в bicepparam нет | Только после изменения кода хостов (F-G5-02) | Приём телеметрии только по Entra |
| `Privacy:Retention:Mode` | `DryRun` (код) | параметра Bicep нет | Только после EXT-07 и записи политик администратором БД | Реальное удаление по срокам (всё равно только для классов с утверждённой политикой) |
| `Database:MigrateOnStartup` | `false` (`appsettings.json`; `true` только в `appsettings.Development.json`) | миграции — только задачей `caj-crm-migrate-<env>` | — | Автомиграция при старте веб-хоста |
| `Hangfire:PrepareSchema` | `false` | схему ставит мигратор | — | — |
| `bootstrapImages` | `false` | `CRM_BOOTSTRAP` | Только при первом разворачивании без образов (runbook 01 §4) | Образы-заглушки, без проб и без алертов |

Флаги бизнес-режима, не связанные с внешними эффектами и не заданные инфраструктурой (значения по умолчанию из кода): `Auth:RevalidationInterval` 1 ч, `Auth:SlidingExpiration` 8 ч, `Auth:AbsoluteExpiration` 12 ч, `Auth:SessionStateCacheSeconds` 30, `Auth:ActiveUserCacheSeconds` 60, `Auth:RoleGrace` 8 ч, `Auth:PrivilegedFreshness` 5 мин, `Auth:RequiredAcr` пусто; `RateLimits:ApiPerMinute` 300, `RateLimits:ExportsPerHour` 10, `RateLimits:MigrationPerHour` 60, `RateLimits:SignInPerMinute` 30, `Bi:RequestsPerMinute` 120, `Imports:MaxRequestBytes` 10 МБ; `Billing:SecondApprovalThreshold` 200 000 (строго больше, без НДС), `Billing:TotalChangeAnomalyPct` 20, `Billing:StaleQuantityDays` 3, `Billing:InvoiceSyncCron` `20 * * * *`; `Sales:DiscountLimitPercent` 15, `Sales:QuoteValidityDays` 30; `Reports:InternalHourlyCost` 650 (часовая себестоимость для отчёта маржи — бизнес-значение по умолчанию, не утверждённое владельцем); `Customers:BillingDetailsMaster` `Crm` (решение отложено); `Outbox:Lease` 2 мин; `Worker:Health:HeartbeatStaleAfter` 3 мин, `LoopStaleAfter` 10 мин; `Audit:Integrity:SettleTime` 5 мин; `Monitoring:DirectoryConfirmationMinutes` 10, `Monitoring:DocumentPreparingMinutes` 15, `Monitoring:FreshnessMinutes` 1440. Реквизиты компании для PDF предложений (`Sales:Company:*`) в `appsettings.json` пусты, кроме `Name`; кто задаёт их в Production, репозиторий не определяет (что напечатает PDF с пустыми реквизитами — не проверялось).

## 4. Внешние условия, привязанные к настройкам (чек-листы EXT)

| Условие | Связанные настройки | Gate | Состояние на 05.10.2026 |
|---|---|---|---|
| **`infra/entra/register-app.sh` выполнить до выкладки DEV-21.** Скрипт добавляет в id_token optional claim `auth_time`; без него привилегированные действия и экспорты остаются закрытыми (`AUTH_REVERIFY_REQUIRED`), а приложение при этом работает. Скрипт идемпотентный; запускает Global/Privileged Role Administrator; не запускался. | `AzureAd:*`, `Auth:PrivilegedFreshness` | EXT-02 | blocked |
| Третий аргумент скрипта — `principalId` идентичности `id-crm-worker-<env>`: права Graph `User.Read.All`, `Application.Read.All`, `GroupMember.Read.All`; для DEV-04 также `Mail.Send` (ящик `crm@`), `Sites.Selected` (runbook 08 §2). Без них синхронизация ролей падает. | `Integrations:MicrosoftGraph:*` | EXT-02 | blocked |
| Роли приложения для BI `Crm.Bi.Read` / `Crm.Bi.Cost`, регистрация BI-приложения с сертификатом | `Bi:*` | EXT-08 | not_run |
| Redirect URI регистрации = итоговый адрес (повторный запуск скрипта после появления адреса), Conditional Access/MFA, PIM для `CRM-Admin-*` | `AllowedHosts`, `AzureAd:*` | EXT-02 | blocked |
| Сертификат `crm-web-auth` в Key Vault (RSA 3072, экспортируемый), загрузка публичной части в регистрацию (runbook 01 §5); секреты провайдеров в Key Vault до включения интеграции | `entraCertificateName`, `enable*` | EXT-02, EXT-03 | не выполнено |
| GitHub: переменные `AZURE_SUBSCRIPTION_ID`, `CRM_ENTRA_TENANT_ID`, `AZURE_CLIENT_ID` / `CRM_ENTRA_CLIENT_ID_<ENV>` на окружение; environments `test` и `prod` (reviewers, ветки), защита `main` с обязательными проверками, права Actions, OIDC, AcrPull идентичности prod на реестр test; проверка `tools/release/release-settings.sh` | все `CRM_*` | EXT-11 | not_run |
| Закрепить принятые `monitoring*` значения в `infra/env/<env>.bicepparam` | `monitoring*` | EXT-01 | blocked |
| Политика хранения: администратор БД записывает периоды в `privacy.RetentionPolicies` / `audit.RetentionPolicies`; `Privacy:Retention:Mode` остаётся `DryRun` до этого | `Privacy:*` | EXT-07 | not_run |
| Среда PowerOffice зафиксирована по окружению (prod → `Production`, test → `Demo`); ключи в Key Vault; `WriteEnabled` включать только после проверки | `Integrations:PowerOffice:*` | EXT-03 | blocked |
| Хранилище документов (Azure Storage): проверка RBAC managed identity и приватной сети в test | `Documents:*` | EXT-11 | not_run |
| Решение владельца по `Authorization:RecordScope` (матрица видимости) | `recordScope` | EXT-01 | blocked |

## 5. Что проверить перед использованием manifest

1. `az bicep build --file infra/main.bicep --stdout > /dev/null` — компиляция (по CLAUDE.md); она не доказывает ни доставку алертов, ни права.
2. Сопоставить фактическую конфигурацию окружения (`az containerapp show … --query properties.template.containers[].env`, без значений секретов) с таблицами §2–3. Это действие в Azure; в рамках данного пакета оно не выполнялось и не разрешено.
3. Записать фактический commit, digest-ы и результат `tools/release/release-settings.sh` в досье релиза (`GO_LIVE.md`, «Досье конкретного релиза»). Здесь они не заполняются.
