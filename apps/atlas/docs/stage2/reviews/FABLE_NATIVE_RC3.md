# Независимое архитектурное ревью — Atlas Stage 2 (M365 Correlation)

**Дата:** 2026-10-08
**Пакет:** `docs/stage2/REVIEW_MANIFEST.json`, версия **1.0-rc3**, baseline `916a4d6`
**SHA-256 пакета (из манифеста):** `d42923ce7b8131dcf320a997ad5239beb30669276c2c1fc4f3e9f326cc4e1276`
**Ревьюер:** запрошенное ревью Fable 5.1; проверка транспорта/модели фиксируется оркестратором отдельно, самоидентификация доказательством не является.
**Вердикт: REQUEST_CHANGES** (три обязательных finding: два P2, один P3). Архитектура в целом состоятельна; замечания касаются однозначности правила «текущего» directory, отсутствующей операции disable/revoke и размещения ролей/grants относительно порядка деплоя Stage 1.

## Scope

Прочитаны `AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `prompts/REVIEW_STAGE_2.md` и все 11 нормативных файлов манифеста. `REVIEW_STATUS.md`, `docs/stage2/reviews/*` и отчёты исправлений не открывались. Код Stage 1 инспектирован точечно для проверки допущений совместимости. Ревью относится только к дизайну Stage 2 и последовательности roadmap; оно не одобряет код, live-интеграции, production readiness или детальную архитектуру Stages 3–9.

## Проверенные допущения совместимости

Подтверждено в коде Stage 1:

- `System` уже содержит `microsoft365` (`packages/core/contracts.ts:2`); `ResourceType` его не содержит, расширение нужно, как и описано.
- CHECK пар EntityLink `('agent','DEVICE'),('contact','PERSON')` в `202610071700:75-76`; расширение новой миграцией реализуемо. Partial unique «один CONFIRMED на external entity» не запрещает несколько m365_device на один DEVICE, поэтому правило AMBIGUOUS в 02 §4 необходимо и корректно.
- `Observation → RawEvent` FK составной (`schema.prisma:315`); `normalized.externalDevice {resourceType:'agent', externalId}` формируется Huntress-нормализатором (`connectors/huntress/normalizer.ts:11`). Путь правила 1 из 02 §4 существует.
- RLS-политики без `TO`-клаузы и без `FORCE` (`202610071200:138-181`): SECURITY DEFINER роль, не владеющая таблицами, действительно будет ограничена RLS; требование 02 §6 реализуемо.
- `roles.sql:25` выдаёт `ALTER DEFAULT PRIVILEGES ... UPDATE` на будущие таблицы; предупреждение 02 §3 про явное ограничение UPDATE верно.
- `ToolDefinition.permission` единственное (`registry.ts:21`), policy проверяет одно право (`tool-policy.ts:26,32`), `executeTool` не принимает registry (`gateway.ts:40-44`). Переход на `permissions[]` и инъекция составного registry обоснованы. `TOOL_NAME_PATTERN` принимает оба новых имени.
- Activation-purpose выдача существует (`connections.ts:54-63`), но хранится в WeakMap без версии/срока; расширение lifecycleVersion/one-use реализуемо.
- Clamp Retry-After на 3600 с действительно есть (`connectors/http.ts:19`); указание 03 §6 не переиспользовать его корректно.
- Prisma 6.19 pinned; `isolationLevel: RepeatableRead` в interactive transaction поддерживается.

## Обязательные findings

### F1 (P2) — неоднозначность «fresh published directory generation» ломает детерминизм resolution

**Файл/раздел:** `02_CONTRACTS.md` §3 (строки 102–104), §5 («Directory failure independently makes resolution unresolved/stale»), §6 (24h); `03_CONNECTOR_SYNC.md` §3 (freshness 60m).

**Сценарий отказа.** §3 допускает использование CONFIRMED link только если объект присутствует в «current fresh published directory generation». «Fresh» определено в 03 §3 как ≤60 минут, а §6 говорит, что DTO скрывается лишь после 24 часов. Два допустимых прочтения: (а) после 60 минут link непригоден → `DIRECTORY_OBJECT_NOT_CURRENT`; поскольку scheduler в Stage 2 отсутствует, корреляция почти всегда будет UNRESOLVED, пока оператор вручную не перечитает directory перед каждым чтением; (б) link пригоден до 24 часов, а 60 минут лишь помечают ресурс STALE. Реализации по (а) и (б) дают противоположные ответы на один и тот же запрос; тесты C2/C4b нельзя написать однозначно, а в варианте (а) продукт практически неработоспособен без Stage 7.

**Исправление.** Явно определить: link пригоден, если объект есть в активной опубликованной генерации не старше directory payload retention (24h); возраст >60m даёт `resources[].status=STALE` и reason code вида `DIRECTORY_STALE` в `resolution.reasonCodes`, не меняя статус RESOLVED; возраст >24h → UNRESOLVED с `DIRECTORY_EXPIRED`/`MISSING`. Заменить слово «fresh» в §3 на точный термин.

**Тест.** `correlation-negative`/`correlation-pages`: генерация возрастом 61m → RESOLVED + STALE; 24h+1m → UNRESOLVED; объект отсутствует в активной генерации → `DIRECTORY_OBJECT_NOT_CURRENT`.

### F2 (P2) — fence на disable/revoke описан, но операции disable/revoke не существует и не запланировано

**Файл/раздел:** `02_CONTRACTS.md` §1 («bind/disable/revoke/activation increments it», «revoke uses the same Connection fence»), §3; `03_CONNECTOR_SYNC.md` §2; `05_ACCEPTANCE.md` B1, C5b; `04_IMPLEMENTATION_PLAN.md` (задачи 2.2–2.4).

**Сценарий отказа.** В Stage 1 есть только bind (→DISABLED) и activate (→ACTIVE): `Connection_status_check` допускает DISABLED/FIXTURE/ACTIVE (`202610071700:34`), операций disable/revoke в `packages/connections`, `packages/ops` и CLI нет. План не содержит задачи их добавить, не определены права, audit event, порядок блокировок и инвалидация token cache/capabilities. Реализатор либо проверит fence через owner-SQL (обход production-пути, без инкремента lifecycleVersion), либо добавит операцию без ревью. Практическое следствие: при компрометации client secret M365 оператор не может отключить connection средствами Atlas, а ключевое свойство безопасности («stale capability не публикует после revoke») не покрыто реальным кодом.

**Исправление.** Добавить в 02 §1 и в задачу 2.3/2.4 сервис и CLI `connection-disable` (или `m365-disable`): право `connections:manage`, блокировка строки Connection в общем порядке, ACTIVE→DISABLED, `lifecycleVersion+1`, инвалидация выданных capabilities и token cache этого connection, audit `connection.disabled` (только локальные ID). Указать, что «revoke» в тексте означает именно эту операцию (или добавить статус REVOKED с CHECK).

**Тест.** `m365-activation.pg` и `m365-privacy-retention.pg`: disable во время in-flight публикации → публикация отклонена, pointer не изменён; повторный probe по старой capability → отказ; cleanup после disable работает.

### F3 (P3) — роли и grants «в новых миграциях» несовместимы с порядком деплоя и harness Stage 1

**Файл/раздел:** `02_CONTRACTS.md` §3 («least-privilege grants are required» в миграциях), §6 (NOLOGIN definer role, EXECUTE-only runner); `04_IMPLEMENTATION_PLAN.md` задача 2.2 («New migrations for … maintenance role»), раздел Required checks.

**Сценарий отказа.** В Stage 1 роли создаются вне миграций: `roles.sql` применяется после `migrate deploy` (`tests/support/pg-harness.ts:72-74`), harness подставляет уникальное имя роли на каждую throwaway-БД и проверяет форму файла (`pg-harness.ts:35-40`); `db:check:drift` прогоняет миграции в shadow-БД того же кластера (`scripts/schema-drift-check.ts:21-25`); PGlite-тесты создают собственную роль. Роли в PostgreSQL кластерные. Миграция с `CREATE ROLE atlas_m365_maint` упадёт на второй throwaway/shadow БД («role already exists»), а `REVOKE … FROM atlas_app` упадёт на свежем деплое и в PGlite, где `atlas_app` ещё не существует. Обязательные проверки `test:pg`, `db:check:drift` и `npm test` не пройдут при буквальном следовании плану.

**Исправление.** Зафиксировать в 02 §3/§6 и 04 задаче 2.2: миграции создают только таблицы, CHECK/FK/RLS, триггеры и саму routine (владелец — owner миграций); `prisma/roles.sql` (расширенный; `renderRolesSql` harness обновить под вторую роль/пароль) создаёт NOLOGIN definer-роль и runner-роль, выполняет `ALTER FUNCTION … OWNER TO`, выдаёт EXECUTE и снимает UPDATE/DELETE с новых таблиц. Либо явно потребовать идемпотентные DO-блоки с проверкой `pg_roles`.

**Тест.** Двойной прогон `test:pg` на одном кластере, `db:check:drift`, `tests/database.test.ts` (PGlite); `db:check:pg17` проверяет владельца routine и отсутствие BYPASSRLS.

## Необязательные замечания

- **Cursor integrity (02 §5).** Cursor несёт fingerprint и срок; текст не требует подписи. Серверная пересверка fingerprint и прав на каждой странице закрывает риск, но явное требование HMAC или server-side cursor упростит аргументацию C4/C4a.
- **«Credential version» в ключе token cache (03 §2).** В Stage 1 такой колонки нет; `secretRef` не защищён триггером immutability. Определить версию как `secretRef + lifecycleVersion` или добавить колонку.
- **Graph `$filter` с `lt` для signIns (03 §1).** Документация демонстрирует `ge`/`le`; поддержку `lt` на `createdDateTime` зафиксировать в recorded contract и L2, чтобы границы `[from, to)` не смещались на `le`.
- **Лимит directory 20 000 строк (03 §4).** Tenant крупнее лимита никогда не публикуется; это осознанное ограничение, но его стоит вынести в README/RUNBOOK как известное ограничение первого среза.
- **FIXTURE M365 connection в db-режиме.** `READABLE_STATUSES` Stage 1 включает FIXTURE, а 02 §1 требует ACTIVE для корреляции. Уточнить, отклоняет ли `resolveConnection` для M365 FIXTURE в db-режиме или отражает это через `mode`.
- **`auditMetadataAllowlist`** (`packages/audit/sanitize.ts:10`) — фиксированный список ключей; новые ключи (generationId, attemptId, counts, ruleVersion) нужно добавлять явно — упомянуть в задачах 2.2/2.9.
- **Scheduler отсутствует намеренно.** После исправления F1 стоит прямо записать в RUNBOOK, что без Stage 7 directory и окна входов обновляются только операторскими pass-ами.

## Ограничения ревью

- Доступны только Read/Glob/Grep: хеши файлов и пакета **не пересчитывались** (принята проверка оркестратора); код, тесты, миграции и Prisma **не запускались**; live tenant не вызывался.
- Один grep по `externalDevice` вернул отдельные строки из `docs/stage2/reviews/*`; эти файлы не открывались, их выводы не использовались, вердикт сформирован до и независимо от них.
- Факты Microsoft Graph (06) приняты по тексту пакета без обращения к Microsoft Learn.
- Ревью различает дизайн (предмет этого отчёта), реализацию (S2-A/B/C), live-интеграцию (S2-LIVE) и production readiness (Stage 7); одобрение после исправлений потребует повторного ревью нового hash.
