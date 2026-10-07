# Atlas implementation instructions

The user has authorized preparing and implementing Atlas Foundation according to this pack. Do the useful authorized work without repeatedly asking whether to continue. Deployment, account modifications and outbound messages are outside this Stage 1 request.

Read START_HERE_RU.md, docs/01_STAGE_1_SPEC.md and docs/05_IMPLEMENTATION_PLAN.md first. Read detailed documents only when the current task needs them. Do not load every file into each prompt.

- Treat this package as a reference and plan, not a production completion report.
- If an existing repo is present, inspect its AGENTS.md and current architecture, create a branch, and map the pack to it. Preserve existing features and data.
- Do not add UI, Agents/Responses orchestration, automatic remediation, write-actions, vector databases or a graph database to Stage 1.
- Enforce workspace/client/connection scope before all reads and calls. The model cannot supply actor authority, credentials, risk or client permissions.
- Keep confirmed links separate from candidates. Similar names or hostnames alone never prove identity.
- Route errors/refusals/uncertainty to visible review. Source HIGH/CRITICAL stays urgent regardless of AI output.
- Do not send raw records, free-text tickets, credentials, names or emails to Decisions in this first slice. Expand its evidence contract only with a reviewed redaction design.
- Keep dependency versions pinned. Prisma schema here intentionally uses 6.19 syntax. Do not silently migrate to the current major version.
- Synthetic normalizer inputs are Atlas DTOs, not verified vendor webhook contracts.
- In production, persist event deduplication and observation/audit transactions; the in-memory map is only a test reference.
- Run relevant tests, typecheck, migration validation and API build. Test PostgreSQL before claiming the DB-backed stage complete.
- Record blockers, remaining tasks and verification honestly in CHECKPOINT_REPORT.md. Never describe mock transport as live API verification.
- Keep secrets out of git and artifacts. Use secret references in the DB.
- v1.1 contracts are the baseline: Actor with per-client memberships, `ClientContextV1` with resource statuses, `reasonCodes[]`, `priority`, `resourceType` in event identity and links, `AtlasError{code, kind}`. Do not reintroduce flat permissions, a single `reasonCode`, or a context whose missing resource looks like an empty list.
- A stored event is never lost to an exception: CONFLICT → visible HUMAN_REVIEW with source severity, TRANSIENT → bounded RETRY, PERMANENT/unknown → DEAD_LETTER with audit. Provider failure is a FAILED DecisionRun plus rules fallback, never a dropped event.
- Client audit records are built from an explicit allowlist; never spread an event or any payload into an audit row. Scope denials go to the workspace SecurityAuditEvent with the requested client ID as text, never into a client's audit.
- Run client data access through `withScope` (set_config … true inside the transaction) as the confined runtime role from `prisma/roles.sql`. Never connect the API or worker as the table owner; `assertRuntimeRole` must fail in that case. Migrations and the synthetic seed are the only owner operations.
- Model name and allowed response models come from configuration; a mismatch is `MODEL_MISMATCH` in DecisionRun, not a generic failure. Shadow AI runs are stored with `applied = false`; the observation references the applied run only.
- Source severity comes from the source's documented mapping; disk or other thresholds are Atlas configuration, not normalizer logic.
- Decide once, commit atomically: DecisionRuns are written as `applied = false`; the applied flag, the observation, the audit row and the inbox completion change in one final transaction. A retry of that transaction reuses the stored decision and never calls the provider again. Shadow never blocks the baseline. In advisory mode a provider failure is HUMAN_REVIEW, not a silent rules route; a sustained outage is handled by switching the mode to `rules`.
- Same source ID/revision with different content is a separate evidence row linked by `conflictOfEventKey`, routed to urgent review with its own severity; the canonical row is never overwritten.
- Add schema changes as new migrations. `202610070001_foundation`, `202610071200_v1_1_contracts` (revised once in 1.1.1 before any known deployment) and `202610071500_v1_1_2_conflict_scope_and_legacy_guard` are frozen — a database that applied the 1.1.0 text uses `prisma/upgrades/v1_1_0_to_v1_1_1.sql` and then `db:deploy`. Unknown status values in a populated database stop the migration on purpose.
- Every cross-row link carries the scope: a foreign key on a global key alone (eventKey, id) is a defect even when RLS hides the parent. Migration-only markers (`legacyClosure`) are protected by triggers, not comments.

Proceed through tasks 1.1–1.10; stop at the explicit checkpoints for a reviewable report, not at every routine implementation decision.
