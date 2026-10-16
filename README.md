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
| `npm run check` | История, типы, lint, CRM unit/architecture/frontend, строгие Atlas unit |
| `npm run check:history` | Проверка SHA, точности импорта и архивных веток |
| `npm run test:atlas:strict` | Полный unit-набор Atlas без ошибок и пропусков (macOS arm64) |
| `npm run test:atlas:pg` | Полный PostgreSQL 17 набор, включая native Unix и 200-case rehearsal |
| `npm run test:atlas:ui` | Все браузерные тесты Atlas, включая 200 запросов; требуется Chromium и тестовый PG |
| `npm run test:crm:integration` | Тесты CRM в локальных контейнерах после Release-сборки |
| `npm run test:crm:e2e` | CRM + worker + локальная SQL test DB + макеты внешних API |

Сборка Atlas появляется в `apps/atlas/dist`; SPA CRM — в `apps/crm/src/Hosts/Crm.Web/wwwroot`,
.NET-сборки — в каталогах `bin/Release`. Это результаты сборки, не готовый пакет VPS-развёртывания.

## Что означает зелёный CI

CI проверяет Linux-сборку Atlas и полный набор тестов на macOS arm64, включая
унаследованные нативные проверки терминала, peer credentials и F_FULLFSYNC.
**Список разрешённых ошибок удалён.** Unit, PostgreSQL и browser gates отвергают ошибки,
пропуски, отмены и todo; браузерный gate также отвергает retries. Оба сценария на 200
случаев выполняются с настоящими временными ограничениями.

CRM сохраняет свои unit, architecture, SQL/storage integration, coverage, frontend,
браузерные проверки и аудит зависимостей. Рабочие базы и внешние интеграции не используются.
Инструкция запуска полного Atlas: [ATLAS.md](docs/testing/ATLAS.md).

Текущие результаты и ограничения: [VERIFICATION.md](docs/migration/VERIFICATION.md).
Следующий реализованный этап — [M04: единый CustomerId и подтверждённые связи Atlas ↔ CRM](docs/migration/M04-CUSTOMER-IDENTITY.md).
GitHub Actions ранее не запускал jobs из-за billing/spending limit аккаунта;
локальные результаты не подменяют подтверждение выполнения CI на GitHub.

История и SHA исходников сохранены: [описание импорта](docs/migration/IMPORT.md).
План продолжения и границы этапа: [M01–M03](docs/migration/M01-M03.md).
Вложенные Azure workflows и инфраструктурные файлы CRM сохранены как исходный материал;
GitHub не запускает workflows из `apps/crm/.github`. В корневом CI нет Azure, публикации образов,
деплоя, рабочих ключей или подключения к Microsoft 365/Atera/Huntress/PowerOffice.
