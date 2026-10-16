# Parasol

Общий проект Vardahei для трёх сотрудников: Atlas + CRM V2. Целевая среда — **VPS Hostinger**.

M01–M03 объединяют исходники, историю Git, сборку и CI. Приложения пока сохраняют свои API,
интерфейсы и базы данных: Atlas — PostgreSQL 17; CRM — SQL Server. Общая клиентская модель,
авторизация, навигация и развёртывание относятся к следующим этапам.

## Структура

| Путь | Назначение |
| --- | --- |
| `apps/atlas` | Atlas: Node/TypeScript, Prisma, операторский интерфейс |
| `apps/crm` | CRM: .NET, React/Vite, фоновые задания |
| `scripts` | Общие команды сборки и проверки переноса |
| `.github/workflows/ci.yml` | Единственный активный CI, без развёртывания |
| `docs/migration` | Источники, способ импорта, известные ограничения |

## Быстрый старт

Требуются Git с полной историей, Node **24**, npm и .NET SDK **10.0.401 или совместимый 10.0.4xx**
(точные правила SDK — `apps/crm/global.json`). Для интеграционных проверок нужны Docker,
PostgreSQL 17 и локальный SQL Server; обычная сборка не обращается к рабочим системам.

```sh
git clone https://github.com/Oleksandr-Kliuiev/parasol.git
cd parasol
nvm use
npm run bootstrap
npm run build
# Только синтаксическая проверка Prisma; подключение к этому адресу не выполняется.
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/unused npm run check
```

Если `dotnet` отсутствует в PATH, задайте `DOTNET` полным путём к бинарному файлу и
`DOTNET_ROOT` каталогом установленного SDK. Корневой npm-пакет не добавляет зависимостей;
каждое приложение сохраняет свой lockfile и инструменты.

## Команды

| Команда | Результат |
| --- | --- |
| `npm run bootstrap` | `npm ci` обоих приложений и `dotnet restore` CRM |
| `npm run build` | Atlas API + оба интерфейса Atlas, CRM backend + SPA |
| `npm run check` | История, типы, lint, CRM unit/architecture/frontend, Atlas import baseline |
| `npm run check:history` | Проверка SHA, точности импорта и архивных веток |
| `npm run test:atlas:strict` | Исходный набор Atlas без исключений; сейчас завершится с ошибками |
| `npm run test:atlas:pg` | Тесты на отдельном PostgreSQL 17 (`ATLAS_PG_ADMIN_URL`) после сборки |
| `npm run test:atlas:ui` | Браузерные тесты Atlas; предварительно установите его Chromium |
| `npm run test:crm:integration` | Тесты CRM в локальных контейнерах после Release-сборки |
| `npm run test:crm:e2e` | CRM + worker + локальная SQL test DB + макеты внешних API |

Сборка Atlas появляется в `apps/atlas/dist`; SPA CRM — в `apps/crm/src/Hosts/Crm.Web/wwwroot`,
.NET-сборки — в каталогах `bin/Release`. Это результаты сборки, не готовый пакет VPS-развёртывания.

## Что означает зелёный CI

CI проверяет перенос и отсутствие новых регрессий. **Это не полная приёмка Atlas**:
14 сбоев исходного `main` зафиксированы в [списке известных ошибок](docs/migration/BASELINE.md).
Все тесты выполняются; исключение ограничено неизменённым деревом импортированного Atlas.
Любое изменение Atlas требует закрыть или заново обосновать этот технический долг.

CI включает обычные проверки CRM без исключений: unit, architecture, SQL/storage integration,
coverage, frontend, браузерные сценарии и аудит зависимостей. PostgreSQL и браузерные тесты
Atlas выполняются строго, без baseline-исключений.

Текущий результат проверок и блокеры: [VERIFICATION.md](docs/migration/VERIFICATION.md).
GitHub Actions пока не запускает jobs из-за billing/spending limit аккаунта.
Полные PostgreSQL/browser suites Atlas имеют открытые ошибки; зелёного полного CI пока нет.

История и SHA исходников сохранены: [описание импорта](docs/migration/IMPORT.md).
План продолжения и границы этапа: [M01–M03](docs/migration/M01-M03.md).
Вложенные Azure workflows и инфраструктурные файлы CRM сохранены как исходный материал;
GitHub не запускает workflows из `apps/crm/.github`. В корневом CI нет Azure, публикации образов,
деплоя, рабочих ключей или подключения к Microsoft 365/Atera/Huntress/PowerOffice.
