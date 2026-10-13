# Prisma context routing

Read docs/AI_CONTEXT_MAP.md and the current stage workflow first. Schema commands use the prisma directory:
- schema.prisma: generator/datasource and Foundation models.
- m365.prisma: Stage 2 M365 models; reviewed contracts in docs/stage2/02_CONTRACTS.md.
- actions.prisma: Stage 3 action models; reviewed contracts in docs/stage3/03_DATA_AND_CONCURRENCY.md.
- poweroffice.prisma: Stage 4 PowerOffice State/Attempt/Snapshot; reviewed contracts in docs/stage4/03_DATA_AND_CONCURRENCY.md.
- askremote.prisma: Stage 5 ASK-REMOTE R-A policy/allowlist/period counters/attempt ledger; contract docs/stage5/ask/remote/04.
- roles.sql: post-migration role provisioning (runtime, cleanup definer/runner, Stage 3 fence definer); runtime checks in
  packages/graph/runtime-role.ts and packages/graph/fence-role.ts.

Do not load the migration history wholesale. Query one named constraint/function or current migration.
Existing migrations are frozen; changes require new migrations after the accepted checkpoint.
S2-B repair: 202610081300_stage2_m365_directory_retry (M365ResourceState.retryAt, its CHECK/trigger; grant in roles.sql);
202610081400_stage2_m365_directory_budget (attemptsUsed, backfill, CHECK, transition trigger; grant in roles.sql).
Stage 2 SQL invariants: tests/m365-sql-invariants.ts and tests/m365-cleanup-invariants.ts.
S3-A: 202610091000_stage3_action_fence (permissions, fence table/backfill, definer trigger function, auth/Connection/Workspace
triggers) and 202610091100_stage3_action_requests (action tables, scoped FKs, CHECKs, history/lifecycle triggers, FORCE RLS).
Tests: tests/pg/action-*.pg.test.ts. Never inspect FORCE action tables as a non-superuser owner; use the scoped runtime.
S3-B: no migration. roles.sql grants the runtime INSERT on ActionApproval/ActionAttempt and UPDATE only of the request
(state, safeErrorCode, updatedAt, terminalAt) and approval (decision, consumedAt, revokedAt, safeErrorCode) lifecycle
columns; packages/graph/fence-role.ts ACTION_RUNTIME_PRIVILEGES is the matching readiness allowlist.
S4-A: 202610091200_stage4_poweroffice_state (permissions, three tables, scoped FKs, CHECKs, FORCE RLS), 202610091210_stage4_poweroffice_guards
(lifecycle/history/delete guards, SQL aggregate validation, deferred commit constraint triggers; PUBLIC EXECUTE revoked), 202610091220_stage4_poweroffice_cleanup
(confined cleanup routine). roles.sql adds the PowerOffice definer/runner, restrictive three-ID policies and exact runtime column grants;
readiness facts packages/graph/poweroffice-role.ts. Tests: tests/pg/poweroffice-*.pg.test.ts.
S3-C: no migration (all 20 migrations and the lock unchanged). roles.sql adds INSERT on ActionVerification/ActionMockTicket and
UPDATE of exactly the history triggers' mutable columns: request resultTicketId; attempt outcome/claim columns; verification
state/completedAt/safeErrorCode. No DELETE/TRUNCATE; identity, intent, nonce and ticket content stay unwritable.
S5 ASK-REMOTE R-A: 202610111000_stage5_ask_remote_permission (ask:remote vocabulary only), 202610111010_stage5_ask_remote_state
(four tables, scoped FKs, CHECKs, guard + deferred ledger invariant ENABLE ALWAYS, FORCE RLS), 202610111020_stage5_ask_remote_routines
(reserve/settle/pause + owner create/revise/client_set; PUBLIC revoked). roles.sql §4c/§5: eighth role (remote definer), runtime
SELECT-only on RemoteAsk*; readiness packages/graph/ask-remote-role.ts. Tests: tests/pg/ask-remote-*.pg.test.ts.
