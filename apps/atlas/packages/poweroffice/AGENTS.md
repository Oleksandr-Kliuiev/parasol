# Stage 4 PowerOffice MOCK — context routing

Design: docs/stage4/AGENTS.md, README.md, then the relevant 01–06 section and IMPLEMENTATION_HANDOFF.md. Status:
docs/stage4/IMPLEMENTATION_STATUS.md. Synthetic FIXTURE connections only; no vendor HTTP, token, OAuth or secret resolution.

S4-A (foundation) — entry files by concern:
- contracts.ts: permissions per operation, fixed error codes, attempt outcome codes, currencies, bounds, synthetic binding patterns.
- money.ts / calendar.ts: canonical 2-decimal BigInt minor units; Gregorian dates, exact UTC instants, Europe/Oslo business date.
- dto.ts: strict whitelist readers (plain data objects, read once, frozen copies) and header/invoice/page validation.
- export.ts: cross-page complete-export rules (identity, contiguity, full pages, duplicates, counts, bytes); poisoned on first failure.
- aggregate.ts: SummaryBuilder (exact grouped aggregation) and validateSummary (same shape/order/bounds as the SQL snapshot guard).
- audit.ts: the six-key PowerOffice audit metadata factory (never counts/amounts/dates/source IDs).
- binding.ts: fixed synthetic binding check and plain scoped Connection read. locks.ts: State SHARE/UPDATE, Attempt UPDATE, State init.
- authority.ts: private bearer credential; fence → readiness → re-auth → one-membership all-of → workspace denial → scope →
  operation locks → DB clock + token/actor/rights again after ALL locks. Shared token lookup: ../auth/transaction-token.ts.
Database: prisma/poweroffice.prisma; migrations 202610091200 (tables/FKs/CHECKs/RLS/permissions), 202610091210 (guards, aggregate
validation, deferred commit invariants), 202610091220 (bounded cleanup routine); prisma/roles.sql (runtime grants, PowerOffice
definer/runner, restrictive three-ID policies); readiness facts ../graph/poweroffice-role.ts.
Tests: tests/poweroffice-*.test.ts (pure) and tests/pg/poweroffice-*.pg.test.ts (support: tests/support/poweroffice-*.ts).
RC1 repair: the original claim deadline is enforced with the actual DB clock (PO007 → POWEROFFICE_DEADLINE) at the statement
and at COMMIT; Connection_poweroffice_binding_check makes the full synthetic pair a DB invariant the cleanup relies on; the
maintenance roles' complete routine surface is part of readiness/provisioning; ExportAccumulator.dispose() is terminal.
Commit invariants are DEFERRED constraint triggers evaluated with the committing role's RLS: keep the transaction's
workspace/client scope set until COMMIT after any PowerOffice write (a narrowed scope makes the State invisible and the
commit fails closed). The SECURITY DEFINER cleanup routine fires them itself (SET CONSTRAINTS … IMMEDIATE) as the definer.

S4-B (synthetic sync/publication/recovery; still no public read, API, CLI, maintenance admission or scheduler):
- composition.ts: default DISABLED, exact MOCK only, refused source/credential/clock variables; WeakMap-held built-in port;
  testFaultComposition is a private in-process TEST seam (built-in pages pass through a fault), never env/flag/file selected.
- ../../connectors/poweroffice/contract.ts + builtin.ts: Atlas-normalized port; deterministic synthetic export, private
  sessions, one call per ordinal, cancellation before/between chunks/after work, deadline timer; no network/secret/file.
- capabilities.ts: WeakMap claim (credential, exact identity, original monotonic deadlines) and failure continuation (no
  credential); stable HMAC fact audit IDs. rows.ts: State/Attempt/Snapshot/audit statements, one DB clock after the locks.
- admission.ts: mode → authority(sync) → binding refusal before State init → State/Attempt locks → monotonic anchor → BUSY
  (even expired) / SYNC_LIMIT → ACTIVE claim + STARTED audit; never retried. page.ts: fresh authority per page (no writes).
- pass.ts: serial pages, min(now+10 s, original read deadline), abort/late-inert, ExportAccumulator; disposes on every exit.
- publication.ts: same fact + allocated IDs; identical SUCCEEDED receipt no-op (also after the deadline); changed fact
  PUBLICATION_CONFLICT; only authority.ts isKnownRollback (actual 40P01/40001, private WeakSet mark) re-runs, max 3 in total.
- failure.ts: owned still-ACTIVE claim → FAILED before the original deadline, no caller authority; NO_OP/EXPIRED otherwise.
- recovery.ts: fresh recover authority, no port/State init; NO_ACTIVE_ATTEMPT / RECOVERY_NOT_DUE / ABANDONED (closeout binding).
- sync.ts: thin orchestration; closes the claim privately only for positive source/authority/binding stops.
FK residual: Stage 4 INSERTs take KEY SHARE on Connection/Actor after the fence; a direct mutator holding the tuple
exclusively deadlocks with them (PG picks the first waiter) — fixed DB_CONFLICT at admission, known-rollback re-run at
publication, never a Connection row lock (tests/pg/poweroffice-fk-victims.pg.test.ts). A plain non-key UPDATE does not.
S4-C (dedicated reads, API/CLI, maintenance admission and runner wrapper; implemented, Astra acceptance PENDING):
- read-contracts.ts: 04 first-match precedence (decideRead), exact 11-field summary / status DTOs rebuilt and validated on output.
- read.ts: fence SHARE → plain Connection → State SHARE (never initialized) → re-auth after ALL locks; NOT_FOUND without audit;
  UNAVAILABLE decided from Connection + State pointer BEFORE any Snapshot read; expiry/age in SQL on one DB clock; atomic READ audit.
- maintenance.ts: openPowerOfficeRuntime pairs Prisma+URL privately; admitPowerOfficeCleanup (maintain rights, closeout binding,
  pairing facts) → private single-use capability; runPowerOfficeCleanup: runner confinement/pairing (runner-role.ts), GUCs, routine.
- runner-transaction.ts (RC3, Astra S4C-rc1 R1/R2 + S4C-rc2 R1): ONE original 10 s budget from before acquisition on ONE explicit
  `pg` connection (never a pool). BEFORE BEGIN on that session: inherited timeouts read, then transaction_timeout (remaining −
  250 ms), statement_timeout and lock_timeout 1000 ms (each only lowered to a stricter inherited value) set as SESSION settings
  and verified in pg_settings (source session), so BEGIN arms exactly that timer even when role/database/startup settings
  carry another value (an in-transaction set cannot replace an armed timer — the RC2 defect); setup ≤ 250 ms or fail closed.
  Structured-only failure classification (own timers, SQLSTATE; P1000/28xxx = RUNTIME_NOT_READY).
- RC4 (Astra S4C-rc3 F1/F2; phase map in docs/stage4/S4C_RC4_IMPLEMENTATION_REPORT.md): a deadline watchdog armed before connect
  sends the backend's protocol CancelRequest (runner-cancel.ts; cancel key only, no privilege) at the original deadline for ANY
  in-flight statement, then destroys the socket after 2 s; the first setup read is relation-free current_setting(); the
  classifier keeps the effective (stricter) server deadline armed at BEGIN and the session's first structured terminal cause.
- RC5 (Astra S4C-rc4 F1/F2): FIRST-cause classification — the first session terminal event (time, budget left, SQLSTATE if any)
  or the caught failure, evidence fixed before ROLLBACK; known SQLSTATEs never relabelled by clocks; only codeless causes use
  the watchdog / effective-deadline / original-window timers at the time they were observed (S4C_RC5_IMPLEMENTATION_REPORT.md §2).
- Entry points: apps/api/src/db/poweroffice.ts (route-specific bearer dispatch, synthetic envelopes, no-store) and
  ../ops/poweroffice.ts (strict CLI, dispatched by scripts/ops.ts before the legacy parser). No Gateway tool exists.
