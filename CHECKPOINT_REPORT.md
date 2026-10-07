# Atlas Stage 1 checkpoint

Date: 2026-10-07
Checkpoint: **A** (после задания 1.3)
Branch/commit: `stage1/foundation` @ `c4c536c` — проверенное состояние кода после исправления по ревью; эта редакция отчёта закоммичена поверх. Первая редакция отчёта проверяла `1fdab12`. База: `main` @ `4d6f897` (пакет 1.1.3 без изменений, sha256 архива сверен с `SHA256SUMS`).
Tasks completed: 1.1 Baseline, 1.2 Database, 1.3 Client Graph/API
Review: `REVIEW_REPORT.md` (ревью `9770c83`) — REQUEST_CHANGES из-за одной находки R1 [P2], P0/P1 нет. R1 исправлена в `c4c536c` (раздел «Review R1» ниже); нужна повторная проверка ревьюером.

## Review R1 — исправлено

**Находка.** NUL или одиночный UTF-16 surrogate в запрошенном client ID (путь URL или тело) или в имени инструмента: PostgreSQL отклонял строку audit, API отвечал 500, и отказ не записывался. Доступ при этом оставался закрыт, но запись об отказе можно было детерминированно обойти. Утверждение первой редакции «блокеров нет» было неверным.

**Исправление:**
- `packages/audit/sanitize.ts` (`auditText`). Все недоверенные строки audit хранятся как ограниченный экранированный текст, ≤ 200 символов, в обоих sinks. NUL, управляющие символы, DEL и одиночные surrogates записываются как `\uXXXX`, обратный слэш удваивается. Граница не разрезает ни escape, ни пару surrogates. Экранирование выполняется один раз при записи; чтение применяет только allowlist.
- **HTTP-граница.** Client ID вне политики идентификаторов получает тот же 403, что и любой клиент вне scope, с `INVALID_SCOPE_ID` в `SecurityAuditEvent`. Проверка срабатывает до любого запроса, RLS-настройки и gateway — во всех `/clients/:id/*` и `POST /tools/execute`.
- **Gateway.** Имя инструмента вне синтаксиса реестра → клиентский `tool.denied` с `INVALID_TOOL_NAME`. Scope проверяется раньше, поэтому чужой клиент с плохим именем инструмента остаётся scope-отказом.
- **Без изменений.** Структурно неверное тело — по-прежнему 400 до проверки scope. Непереводимая %-последовательность в пути — 400 от Express до маршрутизации: обработчик не вызывается и клиента, которому можно отказать, нет.

**Доказательства:**
- Probe ревьюера на исправленной сборке: все шесть случаев дают 403 и ровно одну audit-запись. Сохранено, например, `ghost\u0000client` (`INVALID_SCOPE_ID`) и `unknown\ud800tool` (`INVALID_TOOL_NAME`).
- Новые тесты:
  - `tests/audit-sanitize.test.ts` (unit);
  - repository-уровень PostgreSQL в `tests/pg/database.pg.test.ts`;
  - HTTP-регрессия `tests/pg/api-input.pg.test.ts`: путь и тело, без 500, ровно одна audit-запись, ни одного чтения.
- Добавлен и необязательный тест ревьюера: один актор с `context:read` у Gasta и только `events:ingest` у другого клиента.
- **Негативный контроль.** Новые тесты запущены против кода до исправления: все три регрессионных теста упали. Кроме того, процесс `database.pg.test.ts` после этого завис и был остановлен вручную. Вероятная причина: Prisma не завершает запрос, когда одиночный surrogate доходит до query engine внутри интерактивной транзакции. Вывод: недоверенные строки не должны доходить до Prisma без проверки. После исправления такие строки до Prisma не доходят.

## Result

- **БД (PostgreSQL 17.11, docker compose, синтетические данные).** В persistent dev-БД есть Gasta → Kari → GASTA-LT-07 и два confirmed mapping устройства: Atera agent `demo-atera-agent-107` и Huntress agent `demo-huntress-agent-207` → `demo-device-07`. Connections — customer/organization mapping с `secretRef = fixture://no-credentials`, без credentials. Повторный seed ничего не меняет.
- **Scoped DB context через confined runtime role.** `getClientContext` идёт через `withScope` ролью `atlas_app` из `prisma/roles.sql` (NOBYPASSRLS, не владелец). Результат: `ClientContextV1` с `mode: db` и `completeness: PARTIAL`.
  - Ресурсы `atera/alert`, `atera/ticket`, `huntress/incident` имеют статус `MISSING` (`SYNC_NOT_CONFIGURED`) и `items: null`, не `[]`.
  - Observations читаются из БД в приоритетном порядке: `severityRank DESC, createdAt DESC, id`. `counts` считаются по всему OPEN-набору, есть `truncated`.
  - В dev-БД observations пока 0: durable pipeline — задание 1.6. Порядок доказан тестом на 102 синтетических строках.
- **Аутентификация.** `Authorization: Bearer <token>` → `Actor` из БД: memberships с правами на каждого клиента и workspace-права. Хранится только SHA-256 digest токена. Без токена, с неверным, отозванным или просроченным токеном и для отключённого актора — 401.
- **Изоляция и аудит.** Чужой или несуществующий клиент → одинаковый 403. Отказ записывается в `SecurityAuditEvent` до любого чтения. Журнал целевого клиента не трогается. `GET /audit/security` требует `security_audit:read`; отказ в доступе к журналу тоже записывается. В ответах нет `secretRef`, tenant ID, digest и токена.
- **Отказ в старте.** API в режиме `db` не стартует через owner-подключение (`RUNTIME_ROLE_BYPASSES_RLS`) и без `ATLAS_RUNTIME_DATABASE_URL`.
- **Статусы, раздельно:**
  - Fixture-режим API работает как раньше: синтетика в памяти.
  - DB-режим: настоящий PostgreSQL 17, синтетические данные.
  - **Live: ничего.** Ни одного вызова Atera/Huntress/OpenAI, credentials нет.

## Changes

**Схема.** Добавлена миграция `202610071600_stage1_actor_membership`; три замороженные миграции не тронуты.
- Таблицы `Actor`, `ClientMembership` и `ApiToken` (только digest токена).
- CHECK-словари прав, составные FK с workspace в каждой связи.
- RLS только для lookup-чтения: токен виден по собственному digest (`app.token_hash`), актор и его memberships — только когда токен назвал актора (`app.actor_id`). Политик записи для runtime-роли нет.
- Условный `REVOKE` для уже существующей роли `atlas_app`. Такой же `REVOKE` добавлен в `roles.sql`.
- `schema.prisma`: новые модели; закреплены два имени FK и default `reasonCodes`, которые создают замороженные миграции. Drift теперь пустой.

**Сервисы (`packages/`):**
- `auth/` — разбор bearer-токена, digest, `authenticateToken`.
- `audit/prisma.ts` — client audit и workspace security audit в PostgreSQL (allowlist), ограниченное чтение с проверкой прав.
- `graph/` — `withWorkspaceScope`; общая приоритетная страница observations, `getObservationPage`, `listClients`, проверка `limit`; `PROTECTED_TABLES` расширен на таблицы identities.
- `tools/gateway.ts` — ждёт синхронные и асинхронные sinks.

**API.** `ATLAS_MODE=db`, `apps/api/src/db/`:
- DatabaseModule — проверка роли до старта HTTP.
- AuthModule — guard и `AccessPolicy`.
- ClientGraphModule, AuditModule, ToolsModule.

Маршруты те же, что в fixture-режиме. Fixture-модуль переведён на общие `http-boundary.ts`, поведение не изменилось.

**Seed.** Добавлены синтетический актор и его membership из `fixtures/gasta.ts`, плюс digest `ATLAS_DEMO_TOKEN`.

**Connectors.** Без изменений: нормализаторы по-прежнему работают на синтетических Atlas DTO.

**Инструменты:**
- `npm run test:pg` — throwaway-БД по настоящему пути: `prisma migrate deploy` → сам `prisma/roles.sql` → seed.
- `npm run db:check:drift` — сверка миграций и `schema.prisma`.
- Тест бюджета контекста (файлы не длиннее 700 строк), `docs/AI_CONTEXT_MAP.md`, `CLAUDE.md`.
- `npm run typecheck` теперь покрывает `apps/`.
- Итог: 42 файла, +1448/−100 строк относительно `main`.

## Verification

Среда: macOS 26.6.2 arm64, Node 25.8.1, npm 11.11.0, PostgreSQL 17.11 (`postgres:17`). Строки с командами `npm` повторены на дереве `c4c536c` от `npm ci`. Dev-БД и мутационные проверки выполнялись по ходу 1.2–1.3; seed и миграции после них не менялись. Ручной smoke на dev-БД повторён на сборке `c4c536c`, после исправления R1.

| Command/scenario | Environment | Actual result |
|---|---|---|
| `npm ci` | локально | OK. `npm audit`: 10 находок (2 moderate, 8 high) в закреплённых деревьях NestJS 11.1.6 и Prisma 6.19.0 — см. blockers |
| `npm run db:generate`, `npm run schema:validate` | локально | Prisma Client 6.19.0 сгенерирован, схема валидна |
| `npm test` | unit + PGlite (встроенный движок PG 17) | **49/49 pass**: 40 исходных + context budget + identities + 2 token + 5 R1 |
| `npm run typecheck`, `npm run api:build` | локально | pass (typecheck включает `apps/`) |
| `npm run api:smoke`, `npm run demo` | fixture | PASS, поведение прежнее |
| `npm run db:check:pg17` | PostgreSQL 17.11 | PASS: 4 миграции по порядку, структурные инварианты, RLS acceptance, lookup-политики identities, guard runtime-роли, переиспользование соединений пула |
| `npm run test:pg` | PostgreSQL 17.11, отдельная throwaway-БД на файл | **22/22 pass**: deploy всех миграций; `roles.sql` (guard принимает runtime-роль и отклоняет owner; нет DELETE, TRUNCATE и UPDATE журналов); seed ×2 без изменений; кросс-клиентские FK; RLS через Prisma; audit sinks; аутентификация; API в режиме db (см. Result); R1: недопустимый ввод в пути и теле, multi-membership |
| `npm run db:check:drift` | PostgreSQL 17.11, shadow-БД | PASS, diff пустой. Контроль: на схеме из пакета — FAIL, 3 строки drift |
| Dev-БД: `db:deploy` → `roles.sql` через `psql` контейнера → `db:seed` ×2 → `db:deploy` новой миграции → `db:seed` | PostgreSQL 17.11, persistent volume | 3, затем 1 миграция применены. Seed идемпотентен. Upgrade-путь: после миграции у `atlas_app` только SELECT на identities |
| Ручной smoke API `ATLAS_MODE=db` на dev-БД (сборка `c4c536c`) | loopback | 401 без токена; `/clients` → `[demo-gasta]`; overview: Kari, GASTA-LT-07, 2 CONFIRMED, 3 `MISSING`, PARTIAL; `demo-other` → 403; `ghost%00client` → 403; оба отказа видны в `/audit/security` (`ghost\u0000client` с `INVALID_SCOPE_ID`) |
| Probe ревьюера (R1) на исправленной сборке | PostgreSQL 17.11, throwaway-БД | 6/6 случаев: 403 и ровно одна audit-запись (до исправления: четыре ответа 500 без записи) |
| Мутационные проверки (код временно ломался, затем восстановлен) | PGlite / PostgreSQL 17 | Каждый тест упал, как и должен: расширенный scope → тест `withScope`; политика `ApiToken USING (true)` → тест identities; отказ без security audit → 2 API-теста; сортировка только по `createdAt` → тест «CRITICAL первым» |

По `verification/RESULTS.md` пакета теперь выполнено то, что там значилось как «не выполнено»: `prisma migrate deploy` на сохраняемой БД, `prisma/seed.ts`, `prisma-context`/`withScope`/`assertRuntimeRole` через Prisma, `prisma/roles.sql` как файл через psql и DB-backed NestJS API.

## Remaining gates / blockers

Известных блокеров после исправления R1 нет; принятие Checkpoint A — за повторной проверкой ревьюера. Не выполнено:
- **Live read-only smoke Atera/Huntress и live Decisions (OpenAI)** — нет credentials и mapping аккаунтов; по заданию вне этого checkpoint.
- **Durable pipeline/worker (1.6).** RawEvent, DecisionRun и Observation через Prisma ещё не пишутся; observations в БД есть только как тестовые фикстуры.
- **Snapshot repository (1.5).** Ресурсы остаются `MISSING`.
- **Node 24 ровно и Windows** не запускались. Проверено на Node 25.8.1 (`engines >=24`); spawn в тестах кроссплатформенный (node + Prisma CLI, без npx), но на Windows не запускался.
- **`npm audit`, 10 находок** (path-to-regexp, multer и file-type в NestJS 11.1.6; effect и deepmerge-ts в Prisma 6.19.0). Версии закреплены `AGENTS.md`; нужен отдельный решённый patch-bump. API слушает только loopback.
- **`GET /clients/:id/observations`**: только `limit`; cursor и фильтры status/severity из docs/02 не сделаны (план — 1.8).
- **Нет администрирования identities.** Выдача и отзыв токенов, управление memberships — только владельцем (seed/SQL). Production IdP (OIDC) не входит в Stage 1.
- **Ошибки аутентификации не пишутся в security audit** (для неизвестного токена workspace неизвестен); rate limiting нет.
- **`ToolExecution` не пишется**; runtime-схемы входа и versioned DTO с `parameters` — задание 1.9.
- **`MANIFEST.json` и `verification/RESULTS.md`** описывают импортированный пакет, а не ветку; актуальный статус ветки — этот отчёт.

## Decisions and scope

1. **Акторы и memberships хранятся в БД (новая миграция), а не в конфигурации.** docs/02 относит проверенного актора к 1.3, а права на клиента — это данные. Аутентификация идёт той же confined-ролью по узким RLS-политикам, без SECURITY DEFINER и без owner-подключения.
2. **Токен хранится как SHA-256 digest, без медленного хеша.** Токены случайные и высокоэнтропийные; формат digest закреплён CHECK.
3. **Identities пишет только seed (owner).** Это согласуется с правилом «миграции и синтетический seed — единственные owner-операции».
4. **Drift устранён правкой `schema.prisma`**, замороженные миграции не тронуты.
5. **Распределение отказов.** Отказ REST по scope или правам (в том числе member без `context:read`) → `SecurityAuditEvent` с `SCOPE_DENIED` или `PERMISSION_DENIED`. Отказ инструмента по правам или неизвестный инструмент → клиентский `tool.denied`, как в docs/02.
6. **Списки.** `GET /clients` показывает только клиентов с `context:read`. `GET /tools` показывает инструменты, право на которые у актора есть хотя бы у одного клиента.
7. **`ATLAS_API_PORT`** (по умолчанию 3100) добавлен для параллельных тестов; привязка остаётся только к 127.0.0.1.
8. **Сверх пакета**, по глобальным правилам пользователя: `CLAUDE.md`, `docs/AI_CONTEXT_MAP.md`, тест бюджета контекста.

**Scope.** Нет write-tools, UI, Agents/Responses-оркестрации, вызовов вендоров, deployment и изменений аккаунтов. Секретов в БД нет: только `secretRef` и digest токена. Локальный `.env` в git не попал.

## Next task

**После ревью — задание 1.4, Mapping workflow.** Нужно:
- явная привязка connection → customer/organization: scoped-сервис, который выдаёт `ResolvedConnection` (scope, connectionId, проверенный `externalTenantId`, без значения секрета);
- интерфейсы candidate и manual-confirm для `EntityLink`, с `resourceType`/`entityKind`.

Проверки: неоднозначные и кросс-клиентские связи отклоняются; конфликт confirmed-связи уходит в quarantine, не теряется.

Файлы: `connectors/contracts.ts`, `packages/graph/resolver.ts`, `docs/03_CONNECTORS_AND_SYNC.md` (раздел Mapping), `prisma/schema.prisma` (`Connection`, `EntityLink`), `tests/sql-invariants.ts`, `tests/pg/`.

Старт: прочитать этот отчёт и раздел Mapping в docs/03. Добавить `resolveConnection(db, actor, scope, system)` поверх `withScope` и тест в `tests/pg/` на чужой клиент и на connection без mapping. Затем candidate-link через `withScope`: политика `EntityLink_scope` уже допускает запись в своём клиенте. Подтверждение — отдельная операция с `confirmedBy`/`confirmedAt`; partial unique `EntityLink_one_confirmed_external` уже в схеме.
