# 07 — Sources and architecture decisions

Проверено 7 октября 2026. Ниже перечислены source-backed API facts; остальная архитектура — решения Atlas, не требования vendors.

| Источник | Что использовано |
|---|---|
| [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions) | Typed choices, threshold evaluation, multiple independent questions |
| [OpenAI Decisions API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create) | Endpoint, input/questions, answer/refusal schema, `probabilities[{value, probability}]`, поле `model` в ответе |
| [PostgreSQL: Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) | Политики не действуют на владельца таблиц и роли с BYPASSRLS; `FORCE` не используется, роль приложения отделена |
| [PostgreSQL: SET / set_config](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET) | `set_config(name, value, is_local = true)` действует до конца транзакции — основа scoped-db |
| [OpenAI API changelog](https://developers.openai.com/api/docs/changelog) | Beta release context on 6 Oct 2026 |
| [NestJS Modules](https://docs.nestjs.com/modules) | Module/controller/provider separation |
| [Prisma relational modeling](https://www.prisma.io/docs/orm/data-modeling/relational-databases) | Explicit relations; current documentation uses a newer major API than this pin |
| [Atera API documentation](https://support.atera.com/hc/en-us/articles/219083397-Using-the-Atera-API) | API integration and account-controlled permissions; live schemas require validation |
| [Huntress REST API overview](https://support.huntress.io/hc/en-us/articles/4780697192851-Huntress-REST-API-Overview) | Read integration resource baseline; account-specific contract to be checked |

## ADR-001 — PostgreSQL owns Client Graph

Canonical identity and explicit cross-system links live in relational tables with scoped foreign keys. No separate graph DB/vector DB in V1. PostgreSQL is also the source of truth for event dedup and audit transactions.

## ADR-002 — Provider-neutral DecisionProvider

Use an interface with fixture/rules/OpenAI implementations. Keep beta API outside persistence/policy logic. Initial OpenAI task is a single bounded route classification; heavy agent orchestration is a later slice.

## ADR-003 — Read-only Stage 1

All registered Stage 1 tools have risk 0 and sideEffect NONE. Ticket creation is the first write slice after the foundation. Risk metadata is authoritative registry data, not AI output.

## ADR-004 — Source urgency and uncertainty

Source HIGH/CRITICAL sets a deterministic urgency minimum. Review is a visible outcome, never event deletion. AI route quality must be measured in shadow mode before queue control.

## ADR-005 — Stable, pinned build baseline

Prisma 6.19.0 is intentional so `schema.prisma` and included migration/client APIs agree. Current Prisma documentation has a different major contract API; do not combine its commands with this baseline. NestJS 11.1.6 and TypeScript 5.9.3 are similarly pinned. Upgrade only in a separate change with migration/typecheck/integration evidence.

## ADR-006 — Fixture and production remain explicit

Reference CLI/API is fixture-only and loopback-bound. DB context is initially partial. No live Atera/Huntress/OpenAI smoke-test is claimed. A future agent implements durable DB behaviour from the task list and reports which gates were actually executed.

## ADR-007 — Compact decision evidence

The first input excludes free text and identifiers. This sacrifices detailed semantics in return for a bounded, inspectable task. Adding ticket descriptions or raw incident text requires explicit field/redaction design and new evaluations.

## ADR-008 — Row-level security as defense in depth

Composite foreign keys stop cross-client links; they do not stop a cross-client read from a query that forgot its scope. Every client-scoped table carries `workspaceId`/`clientId`, so RLS policies keyed on a per-transaction context (`app.workspace_id`, `app.client_ids`) are cheap. Policies are scoped by client, not workspace alone, because all Vardahei clients share one workspace. Policies are not FORCEd: migrations and the synthetic seed run as owner; the application runs as a separate role without BYPASSRLS (`prisma/roles.sql`) and refuses to start otherwise. Context is set with `set_config(..., true)` inside the transaction and nothing else; a session-level setting would leak through the connection pool (demonstrated as a negative control in `scripts/pg17-check.ts`).

## ADR-009 — Identity includes the resource type

`eventKey` (version `v2`) and the `RawEvent` unique index include `resourceType`; `ExternalLink` carries `resourceType` and `entityKind`, and the resolver matches on both. Vendor IDs are unique per object type, not per account; the v1.0 identity could collide alert `123` with ticket `123` and resolve a contact as a device.

## ADR-010 — Stored events are never lost to an exception

After the durable write, errors are classified (`AtlasError.kind`): CONFLICT → visible HUMAN_REVIEW observation with source severity; TRANSIENT → bounded RETRY with persisted attempts; PERMANENT or unknown → DEAD_LETTER with a safe code and audit. Provider failures are not pipeline failures: they become a FAILED DecisionRun and a rules fallback. v1.0 threw on an ambiguous link and dropped the event.

## ADR-011 — Denials are workspace-level security audit

`AuditEvent` requires a client; a scope denial has no legitimate client scope (the actor may not be a member, the client may not exist). Denials go to `SecurityAuditEvent` keyed by workspace with `requestedClientId` as plain text, readable by MSP administrators (`security_audit:read`), never into the target client's log.

## ADR-012 — Explainable observations and one output contract

`Observation` references the resolved `entityId` and the applied `decisionRunId` (composite FK includes `eventId`; partial unique index keeps one applied run per event), carries `domain` (`DISK_CAPACITY → OPERATIONS`, `SECURITY_INCIDENT → SECURITY`), deterministic `priority`, `severityRank` under a CHECK, and `reasonCodes[]` instead of one overwritten code. Fixtures, DB query and tools share `ClientContextV1`; an unavailable resource is a status, never an empty list. Source severity comes from the source; Atlas thresholds are configuration.
