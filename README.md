# Parasol

Общий проект Vardahei для трёх сотрудников: Atlas + CRM V2. Целевая среда — **VPS Hostinger**.

M01–M03 объединяют исходники, историю Git, сборку и CI. M04 связывает клиентов по CustomerId.
[M05](docs/migration/M05-WORKSPACE.md) использует вход и роли CRM для общей карточки клиента
с технической сводкой Atlas. Базы пока раздельные: Atlas — PostgreSQL 17; CRM — SQL Server.
[M06: документы](docs/migration/M06-VPS-DOCUMENTS.md) переносит хранилище на постоянный
том VPS с атомарной записью и проверкой неизменности.
[M07: комплект VPS](deploy/hostinger/README.md) добавляет Linux-образы, Caddy, private config,
зашифрованные backup и отдельное учение restore. Реальный запуск и подключение провайдеров
ещё не выполнены.
[M08: сопоставление клиентов](docs/migration/M08-CUSTOMER-MAPPING-UI.md) добавляет импорт
экспорта Atlas через интерфейс, предпросмотр конфликтов и исправление связи в карточке CRM.
[M09: список клиентов Atlas](docs/migration/M09-ATLAS-DIRECTORY.md) позволяет загрузить
доступных сотруднику клиентов прямо в этот интерфейс через серверное подключение.

## Структура

| Путь | Назначение |
| --- | --- |
| `apps/atlas` | Atlas: Node/TypeScript, Prisma, операторский интерфейс |
| `apps/crm` | CRM: .NET, React/Vite, фоновые задания |
| `deploy/hostinger` | Docker Compose, секреты в файлах, backup/restic, изолированное restore |
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
.NET-сборки — в каталогах `bin/Release`. Для контейнеров и эксплуатации использовать
[комплект Hostinger](deploy/hostinger/README.md), а не копировать локальные build-каталоги на сервер.

## Что означает зелёный CI

CI проверяет Linux-сборку Atlas и полный набор тестов на macOS arm64, включая
унаследованные нативные проверки терминала, peer credentials и F_FULLFSYNC.
**Список разрешённых ошибок удалён.** Unit, PostgreSQL и browser gates отвергают ошибки,
пропуски, отмены и todo; браузерный gate также отвергает retries. Оба сценария на 200
случаев выполняются с настоящими временными ограничениями.

CRM сохраняет свои unit, architecture, SQL/storage integration, coverage, frontend,
браузерные проверки и аудит зависимостей. Hostinger job дополнительно собирает образы,
поднимает обе БД и проверяет настоящий restic backup/restore на синтетических данных.
Рабочие базы и внешние интеграции не используются.
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
