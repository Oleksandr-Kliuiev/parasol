# 03 — Connectors, sync and event pipeline

## Нормативный интерфейс

См. `connectors/contracts.ts`: AtlasConnector предоставляет system, healthCheck, sync и resolveExternalEntity. Адаптер получает `ResolvedConnection` — scope, connectionId и **уже проверенный `externalTenantId`** (mapped customer/organization), по которому обязан фильтровать upstream-запрос. Передача этого параметра не заменяет проверку принадлежности в ConnectionsModule, которая его и выдала; tenant ID из request body или AI-вывода адаптер не принимает. SecretResolver получает secretRef и тот же `ResolvedConnection`; `secretRef` — стабильное имя секрета, ротация значения происходит в vault без изменения строк `Connection`. Никакие auth credentials не сериализуются в контекст AI.

В файлах normalizer.ts используются **synthetic Atlas DTOs**. Они не являются Atera/Huntress webhook schemas. Перед live coding надо открыть account/vendor documentation, проверить реальные payloads, pagination, filter semantics и ограничения API. Ни одного vendor URL или write endpoint пакет не выдумывает. Нормализатор переносит **severity источника** по задокументированному маппингу и никогда не выводит её из порога Atlas (например, «диск ≥ 98 % ⇒ HIGH»): порог — политика, живёт в versioned config, а не в адаптере.

Каждое нормализованное событие несёт `resourceType` самого объекта (`alert`, `ticket`, `incident`) и `externalDevice: { resourceType: 'agent', externalId }` — ссылку на устройство, если источник её даёт.

## Mapping

| Atlas | Atera | Huntress |
|---|---|---|
| Client | Customer ID | Organization ID |
| Device | Agent ID | Agent ID |
| Person | Contact ID при наличии | Только подтверждённые данные; hostname не доказывает пользователя |
| Connection | Customer mapping + vault ref | Organization mapping + vault ref |

Уникальность внешнего объекта — connection + resourceType + externalId. Для MSP-wide credential connection хранит явный client filter: read all tenants followed by post-filter недостаточен для изоляции. Предпочитайте vendor-supported customer/organization filtering. Если его нет, изолируйте connection/job и не допускайте данные чужих клиентов в API/AI context.

Реализация (задание 1.4, `packages/connections/connections.ts`):

- `bindConnection` (`connections:manage` на клиенте) — явная привязка клиента к customer/organization с `boundBy`/`boundAt`; новая привязка — `DISABLED`, чтение начинается после активации с health check (1.5). Tenant принадлежит одному клиенту workspace (unique): повторная привязка → `TENANT_ALREADY_BOUND` (CONFLICT) с записью в audit, ничего не перезаписывается. В audit нет tenant ID и secretRef; secretRef — только ссылка `vault://…` (`env://`, `fixture://` локально), не credential.
- `resolveConnection(…, 'sync' | 'read')` — единственный источник `ResolvedConnection`: scoped-чтение через runtime-роль, статус FIXTURE/ACTIVE, tenant из БД; объект заморожен. Adapter, SecretResolver и mapping-сервисы первым делом вызывают `assertResolvedConnection`: скопированный или собранный вручную объект (например, с tenant ID из запроса или AI) отклоняется `CONNECTION_NOT_RESOLVED`.

## Live resources первой версии

| Atera | Huntress |
|---|---|
| customers, agents, active alerts, open tickets | organizations, agents, incident reports |

Signals/escalations/remediations можно добавить после отдельной проверки фактического API/MCP contract. Huntress в этой Stage 1 — только источник evidence. M365/PowerOffice directories содержат scope notes для следующих slices.

## Read adapters (задание 1.5)

Контракты и их статус проверки — `connectors/CONTRACTS.md`: Huntress сверен с официальным API reference; Atera — по OpenAPI-экспорту v3 из публичного репозитория, **не сверен с аккаунтом** (документация вендора за логином), до активации live-connection нужен чек-лист из того же файла.

- Huntress (`connectors/huntress/`): incidents `status=sent` и agents с серверным фильтром `organization_id`, Basic-аутентификация, `limit=100`, `page_token`, не более 20 страниц; health check — `GET /v1/organizations/{id}`.
- Atera (`connectors/atera/`): открытые tickets с `customerId`, agents по `/agents/customer/{id}`, Bearer-аутентификация, 50 на страницу, не более 40 страниц; health check — `GET /api/v3/customers/{id}`. **Alerts не читаются**: у `GET /api/v3/alerts` нет фильтра по клиенту, а условие 5 docs/01 требует ограничивать сам upstream-запрос; ресурс записывается как `UNAVAILABLE` с `UPSTREAM_TENANT_FILTER_UNAVAILABLE`.
- Каждая запись проверяется повторно: запись другого tenant проваливает всё чтение (`UPSTREAM_SCOPE_MISMATCH`). DTO валидируются при чтении; расхождение — `UPSTREAM_CONTRACT_MISMATCH` (PERMANENT, только имя поля). Ошибки HTTP классифицируются без URL, заголовков, секрета и тела (`connectors/http.ts`): 401/403 и 4xx — PERMANENT, 429 — TRANSIENT с Retry-After, 5xx/сеть/timeout — TRANSIENT.
- Severity — документированные шкалы источников без порогов Atlas: Huntress `low/high/critical → LOW/HIGH/CRITICAL`; Atera alerts `Information/Warning/Critical → INFO/MEDIUM/CRITICAL` (закреплено для будущего чтения alerts).
- Активация (`packages/sync/activation.ts`, `connections:manage`): health check против привязанного tenant с credential из `secretRef`; OK → ACTIVE (audit), иначе остаётся DISABLED с причиной в audit. Credential разрешается только для ACTIVE connection (и DISABLED во время своей активации); FIXTURE-connection вендора не вызывает никогда. `EnvSecretResolver` поддерживает `env://` (локально и для live smoke), `vault://` в Stage 1 не настроен.
- Синхронизация (`packages/sync/snapshots.ts`, `events:ingest`): `syncConnection` — сначала identities (agents → `registerExternalEntity` → matcher предлагает CANDIDATE), затем каждый ресурс через `syncResource` (порядок шагов — ниже). Расписание, lease и durable event inbox — задание 1.6.

## Sync-порядок

1. Проверить connection status и mapping.
2. Разрешить credential в памяти по secretRef.
3. Получить страницу в customer/organization scope.
4. Validate vendor DTO → normalize → upsert external entities/events.
5. Transaction: сохранить страницу и новый cursor только после успешной записи.
6. После всех страниц обновить lastSuccessAt. Failure не обновляет success timestamp.
7. Reconciliation сопоставляет актуальное состояние с локальным snapshot. Отсутствие записи на неполной странице не означает deletion/resolution.

Не предполагайте, что любой resource поддерживает delta cursor или webhooks. При отсутствии используйте bounded polling с overlap watermark и durable dedup. Интервалы задаются connection/resource config и лимитами vendor, не произвольной частотой 30 секунд.

## Event inbox и worker

```mermaid
flowchart TD
  I["Verified ingress or poll"] --> V["Resolve connection and validate"]
  V --> E["Durable event inbox"]
  E --> W["Claim with lease"]
  W --> D["Rules and Decisions"]
  D --> T["Observation + audit transaction"]
  T --> F["Fresh context"]
  W --> R["Retry / visible failure"]
  R --> W
```

Webhook acknowledgement только после durable write. Подпись/секрет проверяются по реально поддержанному vendor protocol; запроса с неподтверждённым источником недостаточно для создания scoped event. ClientId/connectionId из body сами по себе не удостоверяют клиента.

Event key (`eventKeyVersion = v2`): SHA256(JSON array of `v2`/workspace/client/source/connection/**resourceType**/externalEventId/revision). Alert `123` и ticket `123` одной connection — разные события; уникальный индекс `RawEvent` включает `resourceType`. `payloadHash` — SHA256 канонического JSON нормализованного события без `receivedAt`. Если vendor не имеет revision, adapter определяет стабильный source update timestamp или canonical content hash. Правило версионируется: смена формулы — новая версия ключа, не тихая замена. При повторе ID/revision с новым payloadHash каноническое содержание сохраняется; новое содержание записывается **отдельным** событием с ключом `conflictEventKey(canonicalKey, payloadHash)` и ссылкой `conflictOfEventKey`, фиксируется audit `event.revision_conflict`, а observation этого варианта получает `HUMAN_REVIEW`, `REVISION_PAYLOAD_CONFLICT` и срочность по своей severity. Одинаковое конфликтное содержание, доставленное повторно, — дубликат. Сравнение hash идёт до объединения с in-flight обработкой канонического события.

### Классы ошибок после durable-записи

Подтверждение приёма — только после надёжной записи события. Дальше ни одна ошибка не теряет событие; класс ошибки (`AtlasError.kind`) определяет исход:

| Класс | Примеры | Обработка |
|---|---|---|
| `CONFLICT` | `AMBIGUOUS_DEVICE_LINK`, противоречивые данные | Observation создаётся: `HUMAN_REVIEW`, `entityId = null`, исходная severity/priority, причина в `reasonCodes`, audit |
| `TRANSIENT` | сеть, 429/5xx, недоступная БД | Статус `RETRY`, `attempts` сохраняются, bounded retry с backoff; при исчерпании — dead letter |
| `PERMANENT` / неизвестная ошибка | неисправимые данные, баг | Статус `DEAD_LETTER` с `lastErrorCode`, audit `event.dead_lettered`, видимая очередь оператора |
| `SCOPE` / `VALIDATION` | чужой клиент, malformed DTO | Отказ **до** записи; для актора — security audit / client audit |

Сбой advisory-провайдера — не ошибка pipeline: он даёт `DecisionRun(status=FAILED, safeErrorCode, requestedModel/responseModel)` и applied-run с `HUMAN_REVIEW` (контракт docs/04). Dead letter не переобрабатывается неявно; возврат в очередь — явное действие оператора с audit.

### Две фазы обработки

Фаза 1 — один раз на событие: разрешение устройства, получение решения, запись `DecisionRun` как **не применённых**. Фаза 2 — повторяемая целиком: observation, флаг `applied`, audit и завершение inbox в одной транзакции; в reference-коде порядок — durable write (`commitHook`), затем `audit.append`, и только после обоих публикуются applied/observation/inbox, так что сбой записи audit тоже не оставляет применённого решения. Повтор фазы 2 после `TRANSIENT`-ошибки не вызывает провайдера снова и не создаёт второго applied-run. Reference-pipeline реализует это через сохранённое `PreparedDecision`; durable-версия хранит его в `DecisionRun`/`RawEvent`.

Worker использует DB claim/lease или SELECT FOR UPDATE SKIP LOCKED. Unique keys обеспечивают один observation при гонке нескольких workers. Decision call выполняется вне длинной DB transaction; результат сохраняется как DecisionRun (`applied` — тот, чей маршрут использован; shadow-результат AI — `applied = false`). В shadow-режиме baseline фиксируется **не дожидаясь** AI: observation на rules создаётся сразу, AI-вызов идёт отдельной фоновой задачей (в durable-версии — отдельная job того же worker), его результат привязывается к событию как non-applied run и никогда не меняет applied baseline. Финальная transaction атомарно создаёт Observation (с `entityId` и `decisionRunId`), AuditEvent, event status и outbox, если используется. Recovery должен повторно применить сохранённое решение, а не зависеть от старого process memory. Reference-pipeline (`packages/events/pipeline.ts`) воспроизводит этот порядок в памяти; `commitHook` — stand-in финальной транзакции для тестов RETRY/DEAD_LETTER.

Retry: transient network/429/5xx с Retry-After/backoff и лимитом попыток. Malformed DTO → quarantine/review, а не бесконечные retries. Refusal → visible review. Logs содержат safeErrorCode и correlation, но не токены и upstream response body.

### Реализация (задание 1.6)

- Inbox (`packages/events/inbox.ts`): событие сохраняется до любой обработки; `storeEvent` — дубликат (тот же eventKey и payloadHash) ничего не меняет, другое содержание — отдельная строка с `conflictOfEventKey` и audit `event.revision_conflict`; каноническая строка не перезаписывается. Принимаются только события выданной `ResolvedConnection` (workspace, client, connection, system совпадают). `listInbox` (context:read) показывает ожидающие, RETRY и DEAD_LETTER; `requeueDeadLetter` (events:ingest) — явное действие с audit `event.requeued`.
- Источник событий Stage 1 — полное чтение открытого набора инцидентов Huntress (`status=sent`, ограничено числом страниц; дельта-курсор по времени в Stage 1 не используется): `syncResource` в одной транзакции заменяет snapshot и складывает события чтения в inbox. Повторное чтение — дубликаты; изменившийся `updated_at` — новая ревизия, новое evidence. Atera alerts не читаются (решение владельца, connectors/CONTRACTS.md); tickets в Stage 1 не являются событиями.
- Worker (`packages/events/worker.ts`): `claimEvents` — `FOR UPDATE SKIP LOCKED` + lease, попытка считается при захвате; фаза 1 (`prepareEvent`) — разрешение устройства по CONFIRMED-связям, решение через общий `packages/events/decision.ts` (тот же код, что у reference pipeline), DecisionRun как не применённые вместе с `preparedDecision`; фаза 2 — applied, Observation, audit `observation.created` и PROCESSED в одной транзакции под блокировкой строки события. Падение после фазы 1 — lease истекает, другой worker завершает с сохранённым решением без нового вызова провайдера. TRANSIENT → RETRY с backoff до `maxAttempts`, затем DEAD_LETTER; PERMANENT и неизвестные ошибки (в т.ч. повреждённый сохранённый payload) → DEAD_LETTER сразу; обе ветки — с audit.
- QUARANTINED-связь агента события — неразрешённый конфликт привязки: CONFLICT → `HUMAN_REVIEW`, `entityId = null`, `AMBIGUOUS_DEVICE_LINK`, исходная severity и priority.
- Shadow: базовое решение применяется сразу, AI-run записывается после фиксации как не применённый (лучшее усилие, наблюдение не меняет); отдельная job, бюджет, circuit-breaker и телеметрия — задание 1.7. Outbox в Stage 1 не используется (нет исходящих действий). Жизненный цикл observation по ревизиям одного инцидента — задание 1.8.

## Freshness и context

Каждый resource имеет fetchedAt/asOf, lastSuccessAt, status, source ID. `0 incidents` допустимо только после успешного полного чтения ресурса; ERROR/MISSING/STALE — отдельное состояние. Failure одного connector не скрывает evidence другого. Не смешивайте stale counts со свежими без метки.

Context bounded: top active observations, counts, source references и compact device/person mapping. Детали запрашиваются read-tool по конкретному source ID. Нет причины передавать модели весь client inventory или 200 tools.
