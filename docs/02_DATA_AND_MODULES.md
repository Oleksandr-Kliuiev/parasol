# 02 — Data model, NestJS modules and API

## Ключи и изоляция

`workspaceId` означает ваш MSP/workspace, `clientId` — обслуживаемую организацию. Microsoft tenant ID, Atera customer ID, Huntress organization ID и PowerOffice integration ID — внешние идентификаторы, не `clientId` Atlas.

Почти все дочерние таблицы используют составной ключ `(workspaceId, clientId, id)` и составные foreign keys. Благодаря этому ExternalEntity клиента A нельзя связать с Entity клиента B. UI-фильтр не является границей безопасности. Scoped repository получает scope только из аутентифицированного actor и server-side client resolution.

Изоляция — три слоя, каждый проверяется отдельно:

1. **Составные FK** — запрещают кросс-клиентские *связи* (v1.0).
2. **Scoped repository** (`packages/graph/scoped-db.ts`) — каждое чтение/запись клиентских данных идёт в транзакции, первой командой которой `set_config('app.workspace_id', …, true)` и `set_config('app.client_ids', …, true)` (параметризованный эквивалент `SET LOCAL`). Список клиентов берётся только из memberships актора.
3. **Row-level security** (миграция `202610071200_v1_1_contracts`) — политика каждой таблицы: `workspaceId = app.workspace_id AND clientId = ANY(app.client_ids)`. Все клиенты Vardahei живут в одном workspace, поэтому политика по одному `workspaceId` ничего не защищала бы. Отсутствие или пустой контекст даёт `NULL`/`{}` и запрещает все строки; контекст заканчивается вместе с транзакцией, так что пул соединений ничего не переносит. RLS не применяется к владельцу таблиц и ролям с `BYPASSRLS` — поэтому приложение подключается отдельной ролью (`prisma/roles.sql`, `ATLAS_RUNTIME_DATABASE_URL`), а `assertRuntimeRole()` отказывает в старте, если текущая роль — superuser, `BYPASSRLS`, владеет (напрямую или через членство) **любой** из защищаемых таблиц (`PROTECTED_TABLES`) или если у какой-то защищаемой таблицы RLS выключен (`RLS_NOT_ENABLED`). Миграции и seed выполняются владельцем и RLS обходят — по замыслу.

Политика идентификаторов scope: `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (без запятых — они разделяют список клиентов).

## Actor и права

`Actor { id, workspaceId, memberships: [{ clientId, permissions[] }], workspacePermissions[] }`. Права — на уровне клиента: техник может иметь `context:read` у одного клиента и не иметь у другого. `workspacePermissions` — MSP-уровень, например `security_audit:read`.

Реализация (задание 1.3, миграция `202610071600_stage1_actor_membership`): таблицы `Actor`, `ClientMembership`, `ApiToken`. Словари прав закреплены CHECK (`context:read`, `events:ingest`, с задания 1.4 — `mapping:review`, `connections:manage`; `security_audit:read`); токен хранится только как SHA-256 digest. Аутентификация идёт той же confined runtime-ролью по узким политикам RLS: строка `ApiToken` видна только транзакции, которая уже держит её digest (`app.token_hash`), `Actor` и его memberships — только когда токен назвал актора (`app.actor_id` в его workspace); обычный client scope их не видит; политик записи нет — identities пишет владелец (синтетический seed), пока не появится отдельный administration slice. `packages/auth/prisma-auth.ts` превращает bearer-токен в `Actor`; production IdP (например, OIDC) позже заменит только источник токена, не memberships.

## Таблицы

| Таблица | Назначение / правило |
|---|---|
| Workspace | MSP boundary |
| Client | Локальная организация Atlas; FK к Workspace |
| Entity | Каноническая сущность PERSON/DEVICE |
| Person | Профиль человека; email не уникальный global ID, может отсутствовать |
| Device | Каноническое устройство; nullable assigned Person |
| Connection | Один mapped внешний tenant/customer/organization; только `secretRef` (стабильное имя секрета — ротация значения в vault не трогает строку). `status` DISABLED/FIXTURE/ACTIVE (CHECK); явная привязка `boundBy`/`boundAt`, обязательна для ACTIVE; system/tenant и записанное provenance неизменяемы (trigger) — перепривязка = новая connection |
| ExternalEntity | Внешний объект: connection + resourceType + externalId |
| EntityLink | Link несёт `resourceType`/`entityKind` (составные FK на типизированные строки + CHECK: только agent↔DEVICE, contact↔PERSON); статусы CANDIDATE/CONFIRMED/REJECTED/QUARANTINED; один confirmed на ExternalEntity (partial unique); provenance `createdBy`/`createdAt`, `reviewedBy`/`reviewedAt`, `reasonCode` (код, не текст); `conflictsWithLinkId` — составной FK на link **того же** внешнего объекта |
| RawEvent | Нормализованное evidence; **resourceType — часть идентичности**; `eventKey` + `eventKeyVersion`; статус inbox `RECEIVED/PROCESSED/RETRY/DEAD_LETTER`, `attempts`, `lastErrorCode`; `conflictOfEventKey` — повтор того же ID/revision с другим содержанием хранится отдельной строкой со ссылкой на каноническую; ссылка — составной FK по `(workspaceId, clientId, connectionId, resourceType, externalEventId, revision, conflictOfEventKey)`, т.е. только на событие **того же клиента и той же идентичности**, а trigger требует, чтобы родитель был каноническим (одна каноническая строка на идентичность — partial unique; одинаковое содержание — дубликат по unique с `payloadHash`). Durable inbox (задание 1.6): `nextAttemptAt`, lease `leaseOwner`+`leaseExpiresAt` (вместе или никак; у PROCESSED/DEAD_LETTER нет), `preparedDecision` — результат фазы 1 для повторов финальной транзакции; RETRY/DEAD_LETTER с `lastErrorCode` (CHECK). Ревью B1 (миграция 202610072000): у каждого захвата свой `claimToken`; lease — тройка owner/expiry/token (все или никого); worker меняет событие только пока его токен текущий |
| DecisionRun | Один вызов провайдера: provider, `mode`, **`applied`**, `requestedModel`/`responseModel` (заполняются и при FAILED), promptVersion, inputHash, status, безопасная ошибка, latency/tokens. Один `applied` run на событие (partial unique). Записывается как `applied = false`; флаг ставится в финальной транзакции вместе с observation. CHECK словарей (1.6): `status` OK/FAILED (FAILED — с `safeErrorCode`), `provider` fixture/rules/openai. Задание 1.7 (миграция 202610072200): `configVersion` — версия `config/decisions.json`, под которой сделан run (CHECK формата); `latencyMs`/`inputTokens` неотрицательны (CHECK) |
| ShadowJob | Задача shadow-эксперимента (1.7), одна на событие, ключ `(workspaceId, clientId, eventId)` с составным FK на событие того же клиента; создаётся в финальной транзакции baseline. `status` PENDING/RETRY/DONE/FAILED/SKIPPED; lease — тройка owner/expiry/`claimToken`; завершённая задача без lease и с `finishedAt`; RETRY/FAILED/SKIPPED с `lastErrorCode`; `configVersion` baseline. RLS как у всех клиентских таблиц |
| Observation | `entityId` (разрешённая сущность), `decisionRunId` + константа `decisionApplied = true` (составной FK включает `eventId` **и** `applied`: ссылка возможна только на applied-run своего события, и его нельзя снять с applied — ON UPDATE RESTRICT), `domain`, `severity` + `severityRank` (CHECK), `priority` (CHECK: HIGH/CRITICAL ⇒ URGENT), `route`, `confidence`, `provider`, `promptVersion`, `reasonCodes[]`, lifecycle `status/updatedAt/resolvedAt/resolvedBy`, `legacyClosure` (закрытые до v1.1 строки без автора/времени; выставляется только миграцией — trigger отклоняет INSERT с флагом и UPDATE false→true от любой роли, сброс при reopen разрешён) |
| SyncState | Cursor, last attempt/success по connection/resource; `status` OK/ERROR/UNAVAILABLE (CHECK; ERROR/UNAVAILABLE с кодом); `lastSuccessAt` не позже `lastSyncAt`. Порядок попыток (ревью B3, миграция 202610072000): `attemptSeq` — номер, выданный последней начатой попытке, `recordedSeq` — номер попытки, чей исход записан (CHECK `recordedSeq <= attemptSeq`); исход записывается, только если позже начатая попытка ещё не записана. Номер выдаётся атомарно до чтения и для первого чтения: первая попытка создаёт строку со статусом `PENDING` (попытка начата, исхода нет: без времён, кода и записанного номера; CHECK, миграция 202610072100), в контексте это `MISSING` с `SYNC_NOT_COMPLETED` |
| ResourceSnapshot | Последнее **полное** чтение live-ресурса (alert/ticket/incident) connection: `asOf`, до 100 компактных `SnapshotItem` (CHECK), `itemCount` источника, `truncated`, `contractVersion`; составной FK на SyncState того же scope/connection/resource; RLS по клиенту |
| ToolExecution | Actor, tool, risk, inputHash, status, correlation |
| AuditEvent | Append-only журнал клиента: allowlist полей, без payload, секретов и raw upstream response |
| SecurityAuditEvent | **Append-only журнал workspace** для отказов по scope/правам: `requestedClientId` — текст, не FK (клиент может не существовать или быть вне scope актора); не попадает в журнал чужого клиента |
| Actor | Проверенный актор workspace: `status` ACTIVE/DISABLED, `workspacePermissions[]` (CHECK-словарь) |
| ClientMembership | Права актора на одного клиента: составные FK на `Client` и `Actor` (workspace в каждой связи), `permissions[]` (CHECK-словарь) |
| ApiToken | Bearer-учётка актора: только SHA-256 `tokenHash` (CHECK), `expiresAt`, `revokedAt`; секрет не хранится |
| Approval | Резерв будущего write slice, immutable input/scope |

### Семантика полей Stage 1

- `domain` — категория observation: `DISK_CAPACITY → OPERATIONS`, `SECURITY_INCIDENT → SECURITY`. Конкретный тип события остаётся в `kind` события (`RawEvent.normalized.kind`).
- `priority` — детерминированная срочность из source severity: `HIGH/CRITICAL → URGENT`, иначе `NORMAL`. Независима от `route` и от любого AI-результата. Очередь сортируется по `(severityRank DESC, createdAt DESC, id)`.
- `reasonCodes` — все правила, повлиявшие на результат, в порядке применения (`MODEL_ROUTE`, `LOW_CONFIDENCE`, `UNRESOLVED_DEVICE`, `AMBIGUOUS_DEVICE_LINK`, `SOURCE_URGENCY_FLOOR`, `PROVIDER_UNAVAILABLE_OR_INVALID`, `MODEL_MISMATCH`, …). Ничего не перезаписывается.
- `status` observation: `OPEN → ACKNOWLEDGED → RESOLVED | SUPPRESSED`; `RESOLVED/SUPPRESSED` требуют `resolvedAt` и `resolvedBy` (CHECK), кроме строк с `legacyClosure = true`, которые миграция v1.1 пометила как закрытые до появления этих полей — автор и время не выдумываются. Приложение `legacyClosure` писать не может: trigger `Observation_protect_legacy_closure` (миграция 1.1.2) отклоняет любую установку флага после миграции; reopen сбрасывает его. Повторное открытие и запоздавшие обновления описываются вместе с snapshot/history в 1.5–1.8.
- Конфликт содержания: при повторе того же source ID/revision с другим `payloadHash` каноническое evidence не меняется; новое содержание сохраняется отдельной `RawEvent` со ссылкой `conflictOfEventKey`, получает собственную observation с `HUMAN_REVIEW`, `REVISION_PAYLOAD_CONFLICT` и `priority` по **своей** severity (CRITICAL во втором варианте → URGENT). Сравнение содержимого выполняется до объединения с ожидающей обработкой, поэтому одновременная доставка даёт тот же результат.

Решение задания 1.5: **scoped snapshot persistence** (`ResourceSnapshot`, миграция `202610071800_stage1_resource_snapshots`). Snapshot заменяется только после успешного чтения всех страниц — в одной транзакции с успехом `SyncState`; сбой оставляет прежний snapshot и не двигает `lastSuccessAt`. `ResourceView` в DB-контексте: OK — свежий snapshot после успешного обновления; STALE — snapshot старше окна свежести (alert/incident 15 мин, ticket 30 мин — конфигурация Atlas, `RESOURCE_MAX_AGE_MS`) или последнее обновление не удалось (код ошибки); ERROR — полного чтения ещё не было; MISSING — не настроено или источник не даёт tenant-scoped чтения (`UPSTREAM_TENANT_FILTER_UNAVAILABLE`). Items есть только у OK/STALE; `completeness = COMPLETE` только когда все ресурсы OK. Items компактны: ссылки на источник, документированные статус/severity/priority, ограниченный заголовок; имена, e-mail и телефоны контактов не копируются.

## Entity matching

1. Manual confirmed mappings и согласованные внешние ID.
2. Exact match устойчивых атрибутов в пределах одного клиента; проверьте дубликаты.
3. Email/hostname — evidence, но переиспользование и общие устройства возможны.
4. Вероятностный matching в дальнейшем создаёт только candidate link.
5. Conflicting confirmed links блокируются partial unique index. No automatic cross-client merge.

Workflow (задание 1.4, `packages/graph/mapping.ts`; все решения — вместе с client audit в одной транзакции):

- `registerExternalEntity` — adapter записывает agent/contact под `ResolvedConnection` (идемпотентно по connection + resourceType + externalId; более новое наблюдение обновляет атрибуты, более старое — нет; атрибуты ограничены и хранимы как text).
- `suggestDeviceCandidate` — точное совпадение hostname без учёта регистра **внутри клиента**: одно устройство → CANDIDATE (`HOSTNAME_EXACT`), никогда CONFIRMED; несколько устройств или устройство, уже подтверждённое для другого agent той же connection → `AMBIGUOUS`, link не создаётся, отказ в audit (`mapping.suggestion_ambiguous`).
- `proposeLink` (`mapping:review`) — ручной CANDIDATE; несовместимая пара → `INCOMPATIBLE_LINK`; сущность или объект другого клиента невидимы → `*_NOT_FOUND`.
- `confirmLink` (`mapping:review`) — решения по одному внешнему объекту сериализуются блокировкой его строки; первое подтверждение выигрывает, конфликтующее становится QUARANTINED с указателем на подтверждённую связь (сохраняется, видно в очереди и audit, в разрешении не участвует); проигранная гонка повторяется один раз и решается так же.
- `rejectLink` (`mapping:review`) — отклонение, для CONFIRMED — отзыв (`mapping.link_revoked`); после отзыва quarantined-связь можно подтвердить.
- `listMappingReview` (`mapping:review`) — очередь: сначала QUARANTINED, затем CANDIDATE. HTTP-endpoints для очереди и решений в Stage 1 не добавлены (список endpoints ниже не менялся); видимость — client audit (`GET /clients/:id/audit`) и сервис.

Резолвер (`packages/graph/resolver.ts`) принимает только CONFIRMED link с совпадающим `resourceType` внешнего объекта (`agent` для device-ссылки события) и `entityKind = DEVICE`. Link `contact → Person` с тем же externalId никогда не вернёт «устройство». Две confirmed-ссылки на разные сущности — `CONFLICT`: событие сохраняется, observation получает `HUMAN_REVIEW`, `entityId = null`, `AMBIGUOUS_DEVICE_LINK`, исходную severity и audit. Entity.kind и профиль должны согласоваться; это дополнительная проверка service-layer. Email-совпадение не подтверждает Device↔Person ownership. `Device.personId` — явное назначение, включая отсутствие владельца.

## NestJS target modules

| Модуль | Ответственность | Не должен делать |
|---|---|---|
| AuthModule | Проверенный actor, memberships, permissions | Принимать actor из AI/body |
| DatabaseModule | Prisma lifecycle, `withScope`, runtime-role self-check, scoped repositories | Обходить scope; подключаться владельцем |
| ClientGraphModule | Resolve client/person/device, confirmed mapping, `ClientContextV1` маппер | Вызывать remediations |
| ConnectionsModule | Mapping, secret resolver, health, `ResolvedConnection` | Отправлять секреты в LLM |
| AteraModule | Customer-scoped reads, normalization, source severity mapping | Own ticketing system; выдумывать severity |
| HuntressModule | Organization-scoped reads и incidents | Write actuator |
| SyncModule | Pagination/cursors/reconciliation | Синхронизировать всё каждые 30 сек |
| EventsModule | Durable event inbox, dedup, классы ошибок, worker/outbox | Выполнять внешние действия; терять событие исключением |
| DecisionsModule | Provider + validated advisory routing, applied/shadow runs | Authorization |
| ObservationsModule | Source urgency, priority, evidence, freshness | Скрывать uncertain alerts |
| PolicyModule | Deterministic scope/permission/risk decision | Спрашивать AI о правах |
| ToolsModule | Registry, runtime schemas, gateway | Исполнять неразрешённые tools |
| AuditModule | Transactional append (client) + workspace security audit, scoped read | Хранить keys/raw private payloads; писать отказ в чужой клиентский журнал |

Reference API использует один `AtlasFixtureModule` для компактного запуска (`ATLAS_MODE=fixture`). DB-backed API (`ATLAS_MODE=db`, `apps/api/src/db/`) разбит на DatabaseModule, AuthModule, ClientGraphModule, AuditModule и ToolsModule; бизнес-логика живёт в `packages/` и от HTTP controllers не зависит.

## ClientContextV1 — единый выходной контракт

`packages/core/contracts.ts` → `ClientContextV1`. Его возвращают фикстуры (`fixtures/run-demo.ts`), DB-запрос (`packages/graph/prisma-context.ts` через `context-mapper.ts`) и инструмент `atlas.client.get_context`. Gateway проверяет `contractVersion` и scope результата.

| Поле | Содержание |
|---|---|
| `mode` | `fixture` или `db` |
| `people`, `devices`, `links` | Компактный граф; `links` несут `resourceType` и `entityKind` |
| `observations` | `{ items: ObservationSummary[], counts: по severity для всего OPEN-набора, total, truncated }`; items отсортированы по приоритету, ограничены лимитом |
| `resources` | `ResourceView[]` по connection × ожидаемый resourceType: `status ∈ OK/STALE/ERROR/MISSING/FIXTURE`, `asOf`, `lastSuccessAt`, `safeErrorCode`, `items` (null, если не OK/STALE/FIXTURE), `truncated` |
| `completeness` | `COMPLETE_FIXTURE`, `PARTIAL`, `COMPLETE` |

Правило: недоступный ресурс — это статус, а не `[]` и не `undefined`. `atera.ticket.list` и аналоги возвращают `ResourceView`, никогда не «список тикетов или ничего».

## Stage 1 endpoints

| Endpoint | Контракт |
|---|---|
| GET /clients | Только доступные actor клиенты |
| GET /clients/:id/overview | `ClientContextV1` |
| GET /clients/:id/observations | `ObservationPage`; cursor/page limit, status/severity filters в DB version |
| GET /clients/:id/audit | Scoped client audit; ограниченная пагинация |
| GET /audit/security | Workspace security audit отказов; требует `security_audit:read` |
| GET /tools | Только доступные read tools; authoritative risk metadata |
| POST /tools/execute | Client ID + registered tool + runtime-validated input |

Reference body: `{"clientId":"demo-gasta","tool":"atlas.client.get_context"}`. Для DB version добавьте versioned DTO с `parameters` и request correlation. Не принимайте риск, sideEffect или permission от вызывающей модели.

Аутентификация: `Authorization: Bearer <token>`. В режиме `db` токен разрешается в `Actor` из БД (иначе 401 без деталей); в режиме `fixture` сравнивается с `ATLAS_DEMO_TOKEN`. Клиент из URL разрешается только внутри workspace актора.

HTTP-маппинг ошибок (`AtlasError.kind`): `SCOPE` → 403; `VALIDATION` → 400; `CONTEXT_SCOPE_MISMATCH`, `CONTEXT_CONTRACT_MISMATCH`, `TRANSIENT` → 502; остальное → 500. Отказ по scope до любой выборки пишется в `SecurityAuditEvent` с `requestedClientId`; отказ по инструменту/правам — в клиентский `AuditEvent` (`tool.denied`). `/ai/query`, approval endpoints и write tools пока отсутствуют. Не раскрывайте существование клиентов вне actor scope.

Недопустимый ввод на HTTP-границе (ревью R1): никакой ввод не должен превращать отказ в 500 без записи. Client ID вне политики идентификаторов (URL или тело) — тот же 403, что и для клиента вне scope, с записью `SecurityAuditEvent` (`INVALID_SCOPE_ID`) до любого запроса, RLS-настройки или gateway. Имя инструмента вне синтаксиса реестра (`TOOL_NAME_PATTERN`) — 403 и клиентский `tool.denied` (`INVALID_TOOL_NAME`); scope проверяется раньше, поэтому чужой клиент с плохим именем инструмента остаётся scope-отказом. Структурно неверное тело (лишние поля, не строки, превышение длины) — 400 до любой проверки scope. Непереводимая %-последовательность в пути отклоняется Express (400) до маршрутизации: обработчик не вызывается и клиента, которому можно отказать, нет.

## Audit и будущий approval

SQL запрещает UPDATE/DELETE/TRUNCATE для `AuditEvent` и `SecurityAuditEvent`. Runtime DB-role не владеет таблицами, не имеет DELETE/TRUNCATE и UPDATE на журналы, не отключает triggers и не делает DDL. Это защита от обычного приложения, а не обещание неизменности против администратора БД. Для stronger guarantees позже добавьте внешний sink и tamper-evident chain. Клиентская audit-запись собирается по явному списку полей (`packages/audit/sanitize.ts: auditMetadataAllowlist`), а не через spread объекта scope. Все недоверенные строки audit (`requestedClientId`, значения metadata, тип события, коды) хранятся как ограниченный экранированный текст (`auditText`, ≤ 200 символов): NUL, управляющие символы, DEL и одиночные UTF-16 surrogates — как `\uXXXX`, обратный слэш удваивается. PostgreSQL text/jsonb не принимает NUL и одиночные surrogates, и без этого запись отказа падала бы вместе с ним; экранирование сохраняет различимость (`ghost<NUL>client` → `ghost\u0000client`, буквальный текст `ghost\u0000client` → `ghost\\u0000client`). Значения экранируются один раз, при записи; чтение применяет только allowlist.

Будущий approval связывается с hash канонического JSON: workspace, client, tool/version, validated parameters, actor/request intent. Один approval нельзя переиспользовать, менять input или переносить на другого клиента. Проверяются expiry, approving authority и policy непосредственно перед исполнением; consumption фиксируется атомарно. Current schema/trigger лишь резервируют этот контракт.
