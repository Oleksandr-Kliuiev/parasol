# Vardahei CRM v2 — проектная документация

CRM для IT-компании — поставщика услуг, лицензий и поддержки продуктов **Microsoft**, **Atera** и **PowerOffice**.
Компания сама работает на этих продуктах: Microsoft 365 / Entra ID — рабочая среда и вход, Atera — сервис-деск и RMM, PowerOffice Go — бухгалтерия и счета.
Вход в CRM — **только через Microsoft-аккаунт (Entra ID)**.

## Комплект документов

| # | Документ | Для кого | Что внутри |
|---|----------|----------|------------|
| 01 | [Техническое задание](docs/01-technical-assignment.md) | Заказчик, руководитель проекта | Цели, границы, роли, требования с ID, этапы, приёмка |
| 02 | [Функциональная спецификация](docs/02-functional-spec.md) | Аналитик, разработка, QA | Модули, сценарии, бизнес-правила, критерии приёмки |
| 03 | [Архитектура](docs/03-architecture.md) | Архитектор, разработка | C4, стек, модули, потоки данных, ADR |
| 04 | [Модель данных](docs/04-data-model.md) | Разработка | Сущности, ER-диаграммы, владение данными |
| 05 | [Интеграции](docs/05-integrations.md) | Разработка | Entra ID, Graph, Partner Center, Atera, PowerOffice, Brreg |
| 06 | [Безопасность и GDPR](docs/06-security.md) | Архитектор, ИБ | Аутентификация, RBAC, секреты, аудит, персональные данные |
| 07 | [НФТ, DevOps и эксплуатация](docs/07-nfr-devops.md) | DevOps, QA | Производительность, окружения, CI/CD, мониторинг, тестирование |
| 08 | [План работ и релизы](docs/08-roadmap.md) | Руководитель проекта | Этапы, состав релизов, команда, риски |
| 09 | [Допущения и открытые вопросы](docs/09-assumptions-questions.md) | Заказчик | Что принято по умолчанию и что нужно подтвердить |

## Ключевые решения — кратко

- **Модульный монолит** на ASP.NET Core (.NET 10 LTS) + React/TypeScript с Fluent UI v9 (визуально как Microsoft 365).
- **BFF-аутентификация**: OIDC Authorization Code + PKCE через Entra ID (single-tenant), токены хранятся только на сервере, в браузере — HttpOnly-cookie. Роли — App Roles, назначаемые группам Entra.
- **Azure, регион Norway East**: Container Apps, Azure SQL, Key Vault, Application Insights; всё через Managed Identity, инфраструктура описана в Bicep.
- **CRM — мастер клиентов, контрактов и прайса.** Atera — мастер тикетов, устройств и отработанного времени. PowerOffice — мастер счетов, платежей и бухгалтерии. Partner Center — мастер CSP-подписок.
- **Предложение → контракт → счёт в одном потоке:** предложение с фиксированными ценами и согласованием скидки, PDF из CRM, а принятое предложение само создаёт контракт-черновик и разовые позиции для ближайшего биллинга.
- **Главная бизнес-ценность** — ежемесячный биллинг из одного окна: контракты + лицензии + оплачиваемые часы из Atera → проверка → заказы в PowerOffice → статус оплаты обратно в карточку клиента.

Нумерация требований: `FR-<модуль>-<nn>` — функциональные, `NFR-<nn>` — нефункциональные, `INT-<система>-<nn>` — интеграционные, `SEC-<nn>` — безопасность.

## Разработка

### Состав репозитория
```
src/BuildingBlocks   SharedKernel, Authorization (роли → права), Infrastructure (EF, аудит, outbox)
src/Modules          Audit, Identity, Customers, Catalog, Contracts, Service, TimeTracking, Sales, Projects, Activities, Licensing, Billing, CustomFields, Notifications, Reports (+ *.Contracts — публичный API модулей; у модуля Contracts это Crm.Contracts.Contracts)
src/Integrations     Brreg (реестр компаний), PowerOffice, Atera, PartnerCenter (CSP, только чтение)
src/Hosts            Crm.Web (BFF + API + SPA), Crm.Worker (Hangfire, outbox), Crm.AppHost (.NET Aspire)
web/                 SPA на React 19 + Fluent UI v9
tests/               Unit, Architecture (границы модулей), Integration (SQL Server и Azurite для хранилища документов в Testcontainers)
infra/               Bicep (Azure Norway East), скрипт регистрации приложения в Entra ID
.github/workflows    CI и деплой (OIDC в Azure)
docs/runbooks        Эксплуатационные инструкции
tools/load-test      Сценарий k6 «рабочий день» (NFR-01)
```
Статус по спринтам — [08-roadmap § 3.1a](docs/08-roadmap.md#31a-статус-выполнения-на-16092026) (R1) и [§ 5.1](docs/08-roadmap.md#51-статус-выполнения-r2-на-23092026) (R2).

### Требования
.NET SDK 10.0.401 (`global.json`), Node.js 24, Docker Desktop.

### Запуск локально
Вариант 1 — .NET Aspire (SQL Server в контейнере, crm-web, crm-worker, дашборд телеметрии):
```bash
dotnet run --project src/Hosts/Crm.AppHost
```
Вариант 2 — по отдельности. SQL Server:
```bash
docker run -d --name vardahei-crm-sql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Local_Dev_Passw0rd!' -p 14333:1433 mcr.microsoft.com/mssql/server:2022-latest
```
API и BFF:
```bash
dotnet run --project src/Hosts/Crm.Web --launch-profile http
```
Интерфейс с горячей перезагрузкой (http://localhost:5173):
```bash
npm --prefix web install && npm --prefix web run dev
```
Без Vite интерфейс доступен на http://localhost:5180 после `npm --prefix web run build`.

В окружении Development вход через Entra ID отключён (`Auth:Mode=Development`): на странице входа выбирается роль. В любом другом окружении этот режим запрещён при старте.

### Тесты
```bash
dotnet test --project tests/Crm.UnitTests/Crm.UnitTests.csproj
```
```bash
dotnet test --project tests/Crm.ArchitectureTests/Crm.ArchitectureTests.csproj
```
```bash
dotnet test --project tests/Crm.IntegrationTests/Crm.IntegrationTests.csproj
```
Покрытие (NFR-10: домен Billing/Contracts/TimeTracking ≥ 90 %, остальной backend ≥ 70 %) — тесты с `--coverage`, затем gate по отчётам Cobertura; CI делает то же и падает ниже порога:
```bash
dotnet test --project tests/Crm.UnitTests/Crm.UnitTests.csproj --coverage --coverage-output-format cobertura --coverage-output "$PWD/coverage/unit.cobertura.xml"
```
```bash
dotnet test --project tests/Crm.IntegrationTests/Crm.IntegrationTests.csproj --coverage --coverage-output-format cobertura --coverage-output "$PWD/coverage/integration.cobertura.xml"
```
```bash
python3 tools/coverage/coverage-gate.py --allow-unmeasured Crm.Worker coverage/unit.cobertura.xml coverage/integration.cobertura.xml
```
Архитектурные тесты запускаются без `--coverage`: инструментирование добавляет типы в каждую сборку.
```bash
npm --prefix web run lint && npm --prefix web run typecheck && npm --prefix web test
```
Сквозные тесты (Playwright): поднимают crm-web (по HTTPS на development-сертификате, как в production: Secure-cookie сессии WebKit на http не хранит), crm-worker и заглушки внешних API; нужен запущенный SQL-контейнер из раздела выше. Проверяют ключевые сценарии, доступность (axe, WCAG 2.1 AA) в светлой и тёмной теме, работу с клавиатуры и ширину телефона; сценарии с тегом `@critical` — также в Firefox и WebKit:
```bash
npm --prefix web exec -- playwright install chromium firefox webkit
```
```bash
npm --prefix web run e2e
```
`E2E_SQL` задаёт свою базу: только локальный SQL Server и имя `crm_e2e…`, иначе запуск отказывается. Уже запущенные crm-web/crm-worker переиспользуются только при `E2E_REUSE_SERVERS=1` (они могут смотреть в другую базу). Месяцы биллинга тесты занимают созданием прогона, поэтому параллельные workers и прогоны на одной базе не конфликтуют. Тест, прошедший только при повторе, роняет прогон (`failOnFlakyTests`).

`npm run build` также проверяет бюджет первой загрузки (≤ 300 КБ gzip).

Нагрузочный тест (k6, сценарий «рабочий день» — NFR-01): нужна среда с режимом входа `Development`, никогда не production.
```bash
k6 run -e BASE_URL=http://localhost:5180 tools/load-test/workday.js
```

Попробовать сопоставления PowerOffice без ключей: локальная заглушка API — [tools/dev-mocks](tools/dev-mocks/README.md). Подключение настоящих PowerOffice Go и Atera — [runbook 02](docs/runbooks/02-integrations.md).

### Развёртывание
Первое развёртывание окружения — [runbook 01](docs/runbooks/01-first-deployment.md). Далее каждый push в `main` разворачивает `test`; `prod` — ручной запуск workflow `Deploy` с подтверждением.
