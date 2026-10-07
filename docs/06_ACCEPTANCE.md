# 06 — Acceptance and runbook

## Reference pack checks

```sh
npm ci
npm run db:generate && npm run schema:validate
npm test                 # unit + fixture + PGlite (все миграции, SQL-инварианты, RLS) — без сервера
npm run typecheck
npm run api:build && npm run api:smoke
npm run demo
docker compose up -d     # PostgreSQL 17 локально
export ATLAS_PG_ADMIN_URL=postgresql://atlas:atlas_local_only@localhost:5432/atlas
npm run db:check:pg17    # SQL-инварианты и RLS на настоящем PostgreSQL 17 (через pg, без Prisma Client)
npm run test:pg          # Prisma/PostgreSQL integration, DB-mode API, E2E (задание 1.10), ops CLI
npm run db:check:drift   # миграции ↔ schema.prisma: diff должен быть пустым
```

- `DATABASE_URL` задаётся для Prisma commands. Build должен предшествовать `api:smoke` и `test:pg`: HTTP-тесты запускают собранный API из `dist`.
- `db:check:pg17` создаёт временную БД и login-роль на указанном сервере и применяет все миграции. Затем проверяет инварианты и RLS через пул соединений и удаляет всё за собой.
- `test:pg` проходит документированный путь на временной БД каждого файла:
  - владельцем — `prisma migrate deploy`, `prisma/roles.sql` и seed;
  - дальше всё — через runtime-роль.
  Удаляет он тоже всё за собой.
- В `verification/RESULTS.md` записаны фактические результаты — отдельно для fixture/unit, PGlite, PostgreSQL 17 и live.

После `db:deploy` на сохраняемой БД выполните `prisma/roles.sql` владельцем и укажите приложению `ATLAS_RUNTIME_DATABASE_URL` с ролью `atlas_app`. Приложение, подключённое владельцем, обходит RLS: `assertRuntimeRole()` обязан это обнаружить и отказать в старте. Установка, запуск и эксплуатация — `docs/RUNBOOK.md`.

## Upgrade from a populated v1.0 database

Миграция `202610071200_v1_1_contracts` начинается с preflight: если в `Observation.status` или `RawEvent.status` есть значения вне допустимых наборов, она останавливается с понятным сообщением — такие значения отображает человек, а не миграция. Закрытые до v1.1 observations без автора/времени получают `legacyClosure = true`; автор и время не выдумываются. Старые `RawEvent` получают `resourceType = 'legacy-unknown'` и `eventKeyVersion = 'v1'`; `reasonCodes = ARRAY[reasonCode]`. Если где-то применён текст миграции из релиза 1.1.0, не редактируйте историю: выполните `prisma/upgrades/v1_1_0_to_v1_1_1.sql` владельцем в одной транзакции, затем обычный `db:deploy` применит `202610071500_v1_1_2_…` — тест `upgrade path 1.1.0 → 1.1.1 → 1.1.2` доказывает идентичность формы схемы (колонки, ограничения, индексы, политики, триггеры) с чистой установкой.

## Production Stage 1 gates

| Сценарий | Ожидаемый результат |
|---|---|
| Запрос без контекста доступа (runtime role) | Ни одной строки; запись отклонена RLS |
| Клиенты одного workspace | Контекст `c1` не видит `c2` даже без `where clientId` |
| Переиспользование соединения из пула | Контекст предыдущей транзакции не переносится в следующий checkout |
| Запрос без `where: clientId` | Всё равно ограничен RLS допустимыми клиентами |
| Приложение подключено владельцем / BYPASSRLS | Старт отклонён `RUNTIME_ROLE_BYPASSES_RLS` |
| Client graph seeded twice | Один graph, данные не очищаются |
| Atera/Huntress device IDs confirmed | Одна canonical Device, две source references |
| Same IDs in different clients | Данные изолированы; scopes не объединяются |
| Candidate or conflicting identity | No silent merge; visible review |
| Конфликт привязки при CRITICAL событии | Событие сохранено; observation `HUMAN_REVIEW`, `priority URGENT`, `severity CRITICAL`, `entityId null`, `AMBIGUOUS_DEVICE_LINK`, audit записан |
| Alert и ticket с одинаковым ID/revision на одной connection | Два разных события (`resourceType` в ключе и unique) |
| Link `contact → Person` с тем же externalId, что у agent | Не разрешается как устройство |
| Duplicate event, concurrent workers | One persisted observation per revision |
| New revision | Новое evidence; история предыдущего не переписана |
| Same revision, different payloadHash | Conflict retained/reviewed, не потерян |
| Crash after inbox write | Event переработан после restart |
| Crash after DecisionRun | Результат переиспользован или deterministic retry; нет дублирующего observation |
| Transient failure в финальной транзакции | `RETRY` с сохранённым `attempts`; после лимита — `DEAD_LETTER` с причиной, не потеря; провайдер не вызывается повторно; после неудачи нет applied-run, после успеха ровно один |
| Повтор того же ID/revision с другим содержанием (в т.ч. CRITICAL после MEDIUM), последовательно и одновременно | Каноническое evidence не изменено; второе содержание — отдельная observation `HUMAN_REVIEW`/`URGENT` с `REVISION_PAYLOAD_CONFLICT`; ровно один audit конфликта |
| Observation ссылается на DecisionRun с `applied=false`; `applied` снимается с run, на который есть ссылка | Отклонено FK (включает `applied`, ON UPDATE RESTRICT) |
| Сбой записи audit в финальной транзакции | `RETRY`; нет applied-run и observation; после повтора ровно один applied, провайдер не вызывался повторно |
| Конфликтная строка ссылается на событие другого клиента / другой идентичности / на другую конфликтную строку (в т.ч. под runtime-ролью) | Отклонено составным FK / trigger «родитель канонический»; родитель чужого клиента к тому же невидим через RLS |
| `legacyClosure = true` в INSERT или UPDATE false→true (любая роль, в т.ч. вместе с `RESOLVED`) | Отклонено trigger; reopen (true→false) разрешён; обычное закрытие с автором/временем проходит |
| Runtime-роль владеет любой защищаемой таблицей / у таблицы выключен RLS | Старт отклонён `RUNTIME_ROLE_BYPASSES_RLS` / `RLS_NOT_ENABLED` |
| Заполненная v1.0 БД с RESOLVED без автора; с неизвестным статусом | Миграция проходит, строка помечена `legacyClosure`; миграция останавливается на preflight |
| Неожиданная ошибка (баг) после записи события | `DEAD_LETTER` + audit `event.dead_lettered`; событие доступно оператору |
| Observation с `severity=CRITICAL, severityRank=0` или `priority=NORMAL` | Отклонено CHECK |
| Observation ссылается на DecisionRun другого события | Отклонено составным FK |
| Два `applied` DecisionRun на одно событие | Отклонено partial unique |
| 100 новых MEDIUM и один старый CRITICAL | CRITICAL первый в выборке; `counts` по всему набору; `truncated = true` |
| Transaction fails during audit write | Observation/event completion откатываются вместе |
| Connector fails on page 2 | Cursor не помечен complete; lastSuccess не обновлён |
| Huntress resource missing | Explicit missing/error, не `0 incidents` |
| Critical source + model MONITOR | Urgent review/investigation, original severity retained |
| Refusal/timeout/invalid answer в advisory | `HUMAN_REVIEW`, evidence не потеряно; `DecisionRun(FAILED, safeErrorCode, requestedModel)`; applied-run — rules с `HUMAN_REVIEW` |
| Ответ модели с неожиданным идентификатором модели | `MODEL_MISMATCH` в DecisionRun с `requestedModel` и `responseModel`, в `reasonCodes`; `HUMAN_REVIEW` |
| Shadow mode | Baseline зафиксирован до завершения AI-вызова (CRITICAL доступен немедленно); AI run сохранён с `applied=false` и не меняет observation |
| Read tool for forbidden client | Denied before vendor call; `SecurityAuditEvent` с `requestedClientId`; клиентский audit целевого клиента не тронут |
| Клиентский audit | Только allowlist полей; ни `summary`, ни `facts`, ни внешних ID |
| Ресурс без snapshot/sync | `ResourceView.status = MISSING` с кодом, не `[]` и не `undefined` |
| Model supplies actor/risk/credential | Input rejected or ignored by authoritative service |
| Unknown/write tool | Denied, no vendor write call |
| Audit UPDATE/DELETE/TRUNCATE by runtime role | Denied |
| OpenAI disabled | Ingestion/context/read tools работают по rules |

## Матрица приёмки (задание 1.10)

Где доказан каждый gate. Окружения:
- **U** — unit/fixture (Node, без БД);
- **L** — PGlite, `npm test`;
- **P** — настоящий PostgreSQL 17: `test:pg` через runtime-роль и `db:check:pg17`.

Live-окружения ни один gate не проверял: вендоры и Decisions заменены mock transport и scripted fetch.

| Gate | Тесты | Где |
|---|---|---|
| Без контекста — ни строки, запись отклонена; `c1` не видит `c2`; запрос без `where clientId` ограничен RLS | `tests/database.test.ts` (RLS acceptance), `scripts/pg17-check.ts`, `tests/pg/database.pg.test.ts` (withScope) | L, P |
| Контекст не переживает транзакцию при переиспользовании соединения пула | `scripts/pg17-check.ts` (тот же backend PID, отрицательный контроль session `set_config`), `tests/pg/database.pg.test.ts` | P |
| Владелец / BYPASSRLS / владение таблицей / RLS выключен — старт отклонён | `tests/database.test.ts` (runtime-role guard), `pg17-check`, `tests/pg/api.pg.test.ts`, `tests/pg/ops-cli.pg.test.ts` | L, P |
| Graph seeded twice — один graph | `tests/pg/database.pg.test.ts` (seed), `tests/pg/auth.pg.test.ts` (повторный seed, ротация токена) | P |
| Device IDs Atera/Huntress подтверждены — одно Device, ссылки на источники | `tests/pg/e2e.pg.test.ts` (четыре ссылки в контексте), `tests/pg/api.pg.test.ts` | P |
| Те же ID в разных клиентах изолированы; кандидат или конфликт — без слияния, видимое ревью | `tests/pg/mapping.pg.test.ts`, `tests/pg/e2e.pg.test.ts` (очередь ревью → подтверждение оператором) | P |
| Конфликт привязки при CRITICAL — `HUMAN_REVIEW`/`URGENT`/`CRITICAL`, `entityId null`, `AMBIGUOUS_DEVICE_LINK`, audit | `tests/pg/worker-routing.pg.test.ts`, `tests/pipeline.test.ts` | P, U |
| Alert и ticket с одним ID/revision — два события; contact→Person не разрешается как устройство | `tests/pipeline.test.ts`, `tests/sql-invariants.ts`, `tests/pg/mapping.pg.test.ts` | U, L, P |
| Дубликат и конкурентные workers — одно observation на revision; новая revision — новое evidence | `tests/pg/inbox.pg.test.ts`, `tests/pg/worker.pg.test.ts`, `tests/pg/observation-lifecycle.pg.test.ts` | P |
| Тот же ID/revision с другим содержанием (в т.ч. CRITICAL после MEDIUM, конкурентно) — отдельное urgent evidence | `tests/pg/inbox.pg.test.ts`, `tests/pg/worker-routing.pg.test.ts`, `tests/pipeline.test.ts` | P, U |
| Сбой после inbox / после DecisionRun / transient в финальной транзакции / сбой audit — RETRY, без дублей и повторного вызова провайдера | `tests/pg/worker.pg.test.ts`, `tests/pg/worker-recovery.pg.test.ts` (B1, B2, generic plans), `tests/pipeline.test.ts` (audit) | P, U |
| Неожиданная ошибка — `DEAD_LETTER` + audit, событие доступно оператору, явный requeue | `tests/pg/worker.pg.test.ts`, `tests/pg/ops-cli.pg.test.ts` (`inbox`, `requeue`) | P |
| Ограничения схемы (applied-run FK, CHECK severity/priority, partial unique, составные FK, legacyClosure, неизменяемость audit) | `tests/sql-invariants.ts` | L, P |
| Upgrade v1.0 и путь 1.1.0 → 1.1.2 | `tests/database.test.ts` | L |
| 100 новых MEDIUM и старый CRITICAL — CRITICAL первый, counts по всему набору | `tests/pg/api.pg.test.ts`, `tests/sql-invariants.ts` | P, L |
| Сбой на странице 2 / несогласованные страницы — snapshot и lastSuccess не тронуты | `tests/pg/sync.pg.test.ts`, `tests/pg/pagination.pg.test.ts`, `tests/pg/worker-routing.pg.test.ts` | P |
| Ресурс без sync — `MISSING` с кодом, не `[]`; устаревший — `STALE` с `asOf` | `tests/resource-freshness.test.ts`, `tests/pg/sync.pg.test.ts`, `tests/pg/e2e.pg.test.ts` | U, P |
| Critical source + model MONITOR — urgent review, severity источника | `tests/pg/e2e.pg.test.ts`, `tests/pg/decision-advisory.pg.test.ts` | P |
| Advisory: отказ, timeout, неверный ответ, `MODEL_MISMATCH` — `HUMAN_REVIEW`, FAILED run с моделями | `tests/pg/decision-advisory.pg.test.ts`, `tests/decision-guard.test.ts` | P, U |
| Shadow — baseline сразу, AI-run `applied=false`, observation не меняется | `tests/pg/shadow-jobs.pg.test.ts`, `tests/pg/e2e.pg.test.ts` | P |
| Read tool чужого клиента — отказ до чтения, `SecurityAuditEvent`, audit клиента не тронут | `tests/pg/tool-gateway.pg.test.ts`, `tests/pg/api.pg.test.ts`, `tests/pg/e2e.pg.test.ts` | P |
| Клиентский audit — только allowlist | `tests/audit-sanitize.test.ts`, `tests/pg/api.pg.test.ts` | U, P |
| Модель передаёт actor/risk/credential; неизвестный или write tool — отказ | `tests/tool-gateway.test.ts`, `tests/pg/api.pg.test.ts`, `tests/pg/e2e.pg.test.ts` | U, P |
| OpenAI выключен — ingestion, контекст и tools по rules | `tests/pg/ops-cli.pg.test.ts` (`worker-once` с `ATLAS_DECISIONS_MODE=rules`), `tests/pg/worker.pg.test.ts` | P |
| Live-read gate (ниже) | Тот же код с mock transport: `tests/pg/e2e.pg.test.ts`, `tests/pg/ops-cli.pg.test.ts`. **Live не выполнен: нет credentials** | — |

## Live-read onboarding gate

Настроить Atera customer и Huntress organization mapping; проверить разрешения read-only credentials, vendor filters/pagination и поддерживаемые resources; credential хранить в vault. Показать health и bounded read без изменения client data. Decisions live smoke-test выполняется отдельно с compact synthetic input и доступным API key; billing/account access не предполагаются.

Пакет не разрешает создавать или закрывать реальный ticket, reset MFA, revoke sessions, отключать device/user или отправлять клиентам сообщения. Все такие действия принадлежат следующим slices.

Процедура и команды — `docs/RUNBOOK.md`, раздел 5 (`npm run ops -- bind | live-read | decisions-smoke`).

## Operational actions

Конкретные команды — `docs/RUNBOOK.md`, раздел 6.


- Provider degraded: rules/review route + status banner/metadata, ingestion сохраняется.
- Vendor 429: honor retry budget и Retry-After, сохранить pending/retry state.
- Unresolved device: сохранить event/observation с unresolved marker, отправить на mapping review.
- Stale snapshot: показывать последний snapshot с asOf, не утверждать актуальные counts.
- Failed worker job: bounded retry, затем visible dead-letter/review; correlation позволяет найти evidence.
- Rollback: disable provider/connector polling, сохранить БД и audit; не запускать destructive reset.

## Позже: verification write-actions

Для `atera.ticket.create` после API success получить созданную запись по external ID и проверить client, contact, title/status. Для security actions определить реальную observable postcondition: API 200 не доказывает немедленное прекращение всех активных sessions. Эти verify-контракты проектируются в write slice, а не подменяются одним ответом gateway.
