# Vardahei Atlas — Stage 1 Development Pack v1.1.3

Дата: 7 октября 2026. Назначение: начать разработку Atlas Foundation в Codex Desktop или Claude Desktop.

Это пакет спецификации и проверенного reference-кода. Производственная Stage 1 ещё не реализована: пример работает на синтетических данных и хранит pipeline в памяти. Prisma-схема, три миграции, RLS, runtime-роль и DB-query подготовлены для следующего шага. Доступ к вашим аккаунтам и клиентским системам не использовался.

**v1.1** закрывает дефекты контрактов, найденные двумя независимыми ревью v1.0 (см. `CHANGELOG.md`): утечка payload в audit, потеря события при конфликте привязки, коллизия ID разных типов ресурсов, несовместимость DB-контекста и gateway, вытеснение старых CRITICAL из контекста; добавлены RLS по workspace+клиенту с отдельной runtime-ролью, workspace security audit отказов, права per-client, `reasonCodes[]`/`priority`, связь observation с сущностью и применённым решением, конфигурируемая модель с `MODEL_MISMATCH`. Reference-код, миграции, тесты и задания изменены согласованно — агенту не нужно сверять отчёт с противоречащим ему кодом. **v1.1.3** закрывает семь находок независимого ревью v1.1 (R1–R7, см. `CHANGELOG.md`): решение сохраняется до commit и не дублируется при retry, конфликтный payload не скрывает CRITICAL, guard runtime-роли проверяет все таблицы, advisory-сбой ведёт в review, `MODEL_MISMATCH` несёт обе модели, upgrade заполненной v1.0 с preflight и `legacyClosure`, shadow не блокирует baseline.

## Что делать сейчас

1. Распакуйте ZIP; внутри — папка `vardahei-atlas-stage1-v1.1` (имя папки не меняется между патч-релизами 1.1.x; версия — в `package.json` и `MANIFEST.json`).
2. Откройте эту папку как проект в Codex Desktop или Claude Desktop. Если продолжаете существующий Atlas, сначала сравните его структуру с пакетом и работайте в отдельной ветке; не заменяйте проект архивом.
3. Передайте агенту **текст из `prompts/IMPLEMENT_STAGE_1.md`**. Архив нужен как файлы проекта, а промпт — как задание.
4. Агент читает `AGENTS.md`, `docs/01_STAGE_1_SPEC.md` и `docs/05_IMPLEMENTATION_PLAN.md`. Остальные документы — по текущей задаче, чтобы не загружать весь контекст каждый раз.
5. Первый рабочий этап: **1.1 → 1.2 → 1.3**, затем checkpoint по шаблону `prompts/CHECKPOINT_REPORT.md`. Не начинайте всю архитектуру заново.

Не нужно автоматически переключать модели. Этот пакет не устанавливает схему Opus/Astra или effort-настройки. Он совместим с обоими приложениями, а отчет можно передать другому агенту через `prompts/REVIEW_STAGE_1.md`.

## Проверить эталон без установки пакетов

Требуется Node.js 24+. Работает на macOS, Windows и Linux.

```sh
npm run demo
node --experimental-strip-types --test tests/pipeline.test.ts
```

Ожидаемый результат: `ClientContextV1`, Gasta → Kari → GASTA-LT-07; две связи с Atera/Huntress; два observation, CRITICAL первым. Disk 96 % (severity источника MEDIUM) → MONITOR, `priority NORMAL`. Синтетический CRITICAL incident → HUMAN_REVIEW, `priority URGENT`, `reasonCodes` содержит `SOURCE_URGENCY_FLOOR`, severity CRITICAL сохранена. Три ресурса (`atera/alert`, `atera/ticket`, `huntress/incident`) со статусом `FIXTURE`.

## Полная локальная проверка

```sh
npm ci
npm run db:generate
npm test
npm run typecheck
npm run api:build
```

`db:generate` и `schema:validate` требуют `DATABASE_URL`, даже если соединение с БД пока не используется. Настройте переменные из `.env.example` в окружении либо создайте локальный `.env`; секреты в git не сохраняйте. Команда `npm test` дополнительно применяет **все три** миграции в PGlite, проверяет ограничения PostgreSQL и пять приёмочных проверок RLS через роль без BYPASSRLS. Это не заменяет integration-test на отдельном PostgreSQL 17 — для него есть `npm run db:check:pg17` (см. ниже).

## Локальный API

Установите `ATLAS_DEMO_TOKEN` в случайную строку длиной не менее 20 символов. Сервер слушает только `127.0.0.1:3100` и возвращает фикстуры.

macOS/Linux:

```sh
export ATLAS_DEMO_TOKEN="your-local-random-token-at-least-20-chars"
npm run api:start
```

PowerShell:

```powershell
$env:ATLAS_DEMO_TOKEN = "your-local-random-token-at-least-20-chars"
npm run api:start
```

Для запросов используйте заголовок `Authorization: Bearer <ваш токен>`:

```text
GET /clients
GET /clients/demo-gasta/overview
GET /clients/demo-gasta/observations
GET /clients/demo-gasta/audit
GET /audit/security
GET /tools
POST /tools/execute
```

Тело последнего запроса:

```json
{"version":"1","clientId":"demo-gasta","tool":"atlas.client.get_context","parameters":{}}
```

## PostgreSQL для разработки

```sh
docker compose up -d
npm run db:deploy                                   # все миграции, владельцем
psql "$DATABASE_URL" -v atlas_app_password="$(cat secret)" -f prisma/roles.sql   # confined runtime role
ATLAS_DEMO_TOKEN="…" npm run db:seed                # владельцем: синтетический граф, актор, digest токена
ATLAS_PG_ADMIN_URL="$DATABASE_URL" npm run db:check:pg17   # миграции, инварианты, RLS, пул — на настоящем сервере
ATLAS_PG_ADMIN_URL="$DATABASE_URL" npm run test:pg         # Prisma/PostgreSQL: deploy, roles.sql, seed, API в режиме db
ATLAS_PG_ADMIN_URL="$DATABASE_URL" npm run db:check:drift  # миграции и schema.prisma описывают одну схему
```

Без локального `psql` роль создаётся psql из контейнера: `docker compose exec -T postgres psql -U atlas -d atlas -v ON_ERROR_STOP=1 -v atlas_app_password="…" -f - < prisma/roles.sql`. Проверьте `DATABASE_URL` перед командами. Seed создаёт только синтетические данные и не очищает таблицы; `ATLAS_DEMO_TOKEN` сохраняется только как SHA-256 digest. Приложение (API/worker) подключается **только** через `ATLAS_RUNTIME_DATABASE_URL` с ролью `atlas_app`: владелец таблиц обходит RLS, и `assertRuntimeRole()` откажет в старте.

API на PostgreSQL (задание 1.3): `npm run api:build`, затем `ATLAS_MODE=db ATLAS_RUNTIME_DATABASE_URL="postgresql://atlas_app:…@127.0.0.1:5432/atlas" npm run api:start` и запросы с `Authorization: Bearer <ATLAS_DEMO_TOKEN>`. Те же endpoints, что выше; актор, memberships, контекст и audit берутся из БД. Внешние ресурсы до задания 1.5 имеют статус `MISSING`, observations появятся с durable pipeline (1.6).

## Где главное

| Файл | Назначение |
|---|---|
| `docs/01_STAGE_1_SPEC.md` | Граница Stage 1 и условия завершения |
| `docs/02_DATA_AND_MODULES.md` | БД, связи, NestJS-модули, API-контракты |
| `docs/03_CONNECTORS_AND_SYNC.md` | Atera/Huntress, mapping, sync и нормализация |
| `docs/04_DECISION_LAYER.md` | Decisions API, fallback и shadow mode |
| `docs/05_IMPLEMENTATION_PLAN.md` | Задания 1.1–1.10, порядок и проверки |
| `docs/06_ACCEPTANCE.md` | Сквозные сценарии и production-gates |
| `docs/07_SOURCES_AND_ADR.md` | Источники и закреплённые решения |
| `verification/RESULTS.md` | Что действительно проверено при сборке: PGlite / PostgreSQL 17 / live — раздельно |
| `CHANGELOG.md` | Что изменилось в v1.1 и почему |

В этой Stage 1 нет UI, полноценного чата, write-actions и автоматического расследования. M365 и PowerOffice подключаются следующими отдельными slices. Decisions помогает маршрутизации; права и разрешения определяет детерминированный Policy Engine.
