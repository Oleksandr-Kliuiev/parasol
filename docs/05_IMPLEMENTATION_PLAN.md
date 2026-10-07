# 05 — Implementation plan: 1.1–1.10

Работать небольшими reviewable commits. Первые задачи сохраняют reference behaviour, затем заменяют memory implementation на PostgreSQL. Не объявлять Stage 1 завершённой по одному fixture demo. Контракты v1.1 (`packages/core/contracts.ts`, три миграции) — исходная точка; не возвращайтесь к плоским правам, `reasonCode` в единственном числе или контексту без статусов ресурсов.

| Task | Результат | Проверка | Зависит от |
|---|---|---|---|
| 1.1 Baseline | Existing repo map, pinned dependencies, local commands, scope DTO (`Actor` с memberships, `ClientContextV1`) | Reference tests + API build | — |
| 1.2 Database | Apply **all three** reviewed migrations (`foundation` + `v1_1_contracts` + `v1_1_2_conflict_scope_and_legacy_guard`; заполненную v1.0 БД — через preflight из docs/06; БД с текстом 1.1.0 — через `prisma/upgrades/v1_1_0_to_v1_1_1.sql`, затем `db:deploy`), runtime role по `prisma/roles.sql`, seed graph, `withScope` repository, `assertRuntimeRole` при старте (владение любой защищаемой таблицей, выключенный RLS), `SecurityAuditEvent` sink | PostgreSQL migration + cross-client FK + repeat seed + `npm run db:check:pg17` (RLS: без контекста отказ; клиенты одного workspace изолированы; контекст не переживает транзакцию/переиспользование соединения; запрос без `where clientId` ограничен) | 1.1 |
| 1.3 Client Graph/API | DB-backed `getClientContext` → `ClientContextV1` через `context-mapper`, confirmed mappings, auth actor/membership с правами per-client, приоритетная выборка observations (`severityRank DESC, createdAt DESC, id`) со счётчиками по всему набору и `truncated`, `GET /audit/security` | Gasta graph read; forbidden other client → 403 + `SecurityAuditEvent`; no secret fields; ресурсы со статусом `MISSING`, не `[]` | 1.2 |
| 1.4 Mapping workflow | Explicit connection→customer/org binding (`ResolvedConnection`), candidate/manual-confirm interfaces, `resourceType`/`entityKind` в ссылках | Ambiguity and cross-client links rejected; conflicting confirmed link → quarantine, не потеря | 1.3 |
| 1.5 Read adapters | Real Atera/Huntress DTOs, filtering по `externalTenantId`, pagination, normalized snapshots, **source severity по задокументированному маппингу** (порог диска — в config) | Recorded/redacted fixtures + scoped mock HTTP + optional live read smoke; `ResourceView` со статусами OK/STALE/ERROR | 1.4 |
| 1.6 Persistent sync/events | Incremental sync, inbox/lease/outbox, durable dedup по `eventKey v2` (с `resourceType`), две фазы (решение сохраняется до commit, applied ставится в финальной транзакции), классы ошибок CONFLICT/TRANSIENT/PERMANENT → review/retry/dead-letter, конфликт содержания как отдельное evidence (`conflictOfEventKey`) | Two workers, duplicate revision, restart, partial page failure, dead-letter visible, ambiguous link quarantined with CRITICAL retained, retry финального commit без повторного вызова провайдера и без второго applied run, CRITICAL-повтор с другим содержанием виден в urgent review | 1.5 |
| 1.7 Decision Layer | Rules baseline + fixture + OpenAI shadow (`applied=false`, **неблокирующий**: baseline фиксируется до результата AI, AI — отдельная job), `DecisionConfig` из versioned config, модель/allowlist из конфигурации, `MODEL_MISMATCH` с requested/response model в DecisionRun и метриках, advisory-сбой → HUMAN_REVIEW, переключение в `rules` при outage (circuit-breaker), telemetry, budget/retry | Timeout/refusal/schema drift/unknown model/urgency floor; один applied run на событие; CRITICAL baseline доступен, пока shadow-вызов не завершён | 1.6 |
| 1.8 Observations/context | Atomic observation/audit, `entityId`/`decisionRunId`/`priority`/`reasonCodes`, freshness, partial/error states, lifecycle статусов | Missing resource ≠ zero; source links retained; старый CRITICAL не вытесняется новыми MEDIUM | 1.7 |
| 1.9 Tool Gateway | Registry runtime schemas, deterministic policy, read tools возвращают `ResourceView`, scope-denial → security audit до любого чтения, маппинг `AtlasError.kind` → HTTP | Malformed input/forbidden client/unknown write tool; отказ по scope виден администратору, не клиенту | 1.8 |
| 1.10 Acceptance | End-to-end tests, RUNBOOK, dated verification (PGlite / PostgreSQL 17 / live — раздельно) and handoff | All Stage 1 gates pass or named live gate remains blocked | 1.9 |

## Checkpoint A — after 1.3

Докажите persisted Gasta→Kari→device graph и scoped DB context через confined runtime role (не владельцем). Provide commit hash, commands, actual results, schema deltas and open issues. DB context может быть PARTIAL до adapters; не заменяйте отсутствующие live snapshots фикстурами без метки — ресурс со статусом `MISSING` и есть честный ответ.

## Checkpoint B — after 1.6

Покажите scoped Atera/Huntress evidence, durable event processing, restart recovery, retry/dead-letter и quarantine конфликтов привязки. Connection health и freshness должны отражать ошибку конкретного ресурса. Нельзя принимать webhook metadata за authenticated identity.

## Checkpoint C — after 1.10

Покажите полный context, shadow Decisions (applied vs non-applied runs) и read tools с audit. Добавьте разницу между fixture tests, PGlite, PostgreSQL 17 integration и real live-read validation. Если live credentials отсутствуют, завершите весь mock/recorded work и обозначьте ровно этот blocker. Не объявляйте production-ready.

## What the reference already proves

Synthetic linking с проверкой типа ресурса и вида сущности, per-process dedup с `resourceType` в идентичности, конфликт содержания как отдельное urgent evidence (последовательно и конкурентно), quarantine конфликтов привязки, RETRY/DEAD_LETTER без потери события и без повторного вызова провайдера, route validation, advisory-сбой → HUMAN_REVIEW с FAILED DecisionRun и моделями, неблокирующий shadow с applied/non-applied runs, source urgency floor и `priority`, allowlist клиентского audit, workspace security audit отказов, read-only gateway поверх `ClientContextV1` (fixture и DB-shaped), NestJS fixture auth, SQL invariants всех миграций, upgrade заполненной v1.0 и путь 1.1.0→1.1.1→1.1.2 с идентичной формой схемы, пять приёмочных проверок RLS и guard runtime-роли в PGlite **и** на PostgreSQL 17 (`scripts/pg17-check.ts`). Всё это уже можно запускать.

## What still needs implementation

Production auth/membership, durable DB pipeline/worker, real adapters and snapshot repository, true freshness/reconciliation, provider budget/retry/circuit-breaker и telemetry, full audit transactions/retention, Prisma Client integration (generate/seed/`prisma-context` против PostgreSQL) и PostgreSQL deployment integration. Reference seed/query не являются полной DB-backed API.

## Suggested commits

`foundation/schema-and-scope`, `foundation/rls-and-runtime-role`, `foundation/client-graph`, `connectors/scoped-read-adapters`, `events/durable-ingestion`, `decisions/shadow-provider`, `observations/context`, `tools/read-gateway`, `foundation/acceptance`.

Не создавайте новое хранилище/репозиторий без необходимости. В существующем проекте используйте текущие conventions после проверки. Структура `apps/web` пока резерв, не задание создать frontend.
