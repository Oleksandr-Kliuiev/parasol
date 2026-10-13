# PostgreSQL test context routing

Start with docs/AI_CONTEXT_MAP.md and the named acceptance case, then read only its test and small support module.
Stage 2 S2-A: m365-scope, m365-schema, m365-upgrade, m365-permissions, m365-disable, m365-privileges,
m365-routine-acl, m365-nonsuper, and roles-output. Shared setup: ../support/pg-harness.ts and m365-fixtures.ts.
Stage 2 S2-B: m365-activation, m365-directory, m365-directory-retry, m365-order, m365-windows, m365-window-recovery,
m365-window-publication, m365-window-limits, m365-retry-upgrade, m365-directory-budget, m365-budget-upgrade,
m365-signin-outcomes, m365-sync-denial
(mock Graph via ../support/m365-graph-mock.ts and m365-signin-mock.ts; setup ../support/m365-pg.ts).
Stage 2 S2-C: correlation, correlation-negative, correlation-provenance, correlation-pages, correlation-expiry and correlation-cursor-bounds (deliberate waits),
m365-reads, m365-tools, m365-api, m365-cli-sync, m365-cli-read, m365-privacy-retention, m365-cleanup-target (two databases), m365-e2e
(setup ../support/correlation-fixtures.ts; actual CLI via ../support/m365-cli.ts + the test-only m365-fetch-preload.ts).
Stage 3 S3-A: action-fence (A5/A6), action-nonsuper (non-superuser owner, missing fence, provisioning count), action-requests
(A2/A3, denials), action-signers (signer snapshot/epoch proof, A1, A4, collision), action-compat (R1 owner paths with healthy
and missing fence), action-upgrade (R2 from the accepted Stage 2); setup ../support/action-fixtures.ts.
Stage 3 S3-B: action-approvals (B1 denials, B2 stored preview/replay/caps, B5 revoke/cancel/reject), action-guard (B3/B5
invalidation, DB clock after locks, terminal audit rollback, version drift), action-reserve (B4 atomic reservation, permit,
FIFO fence orderings incl. m365-disable, deadlock/cancel, exact grants/readiness), action-upgrade-s3b (accepted S3-A
roles.sql → current); setup ../support/action-approval.ts (deliberate waits only for DB-clock expiry).
Stage 3 S3-C: action-execute (C1/C2/C3/C8, network trap), action-verify (C4/C5, budget, direct SQL, lock order, same-fact
retries), action-late (C6 orderings; one concurrent 15 s create/read deadline wait), action-recovery (one 35 s DB-clock wait for
all crash/claim scenarios), action-cli (actual CLI journey, reconciliation, one 35 s wait), action-upgrade-s3c (accepted S3-B
roles.sql → current), action-exec-nonsuper; setup ../support/action-exec.ts (TEST-ONLY port wrapper/faults, audit fault).
S3-C RC2 repair: action-port-cancel (R1, real built-in port; pool wait, blocked SQL, real 15 s), action-replay (R2 stable fact identity).
Stage 4 S4-A: poweroffice-schema (CHECK truth, scoped FKs), poweroffice-history (identity/lifecycle/delete guards, 1000 cap),
poweroffice-commit (deferred invariants at COMMIT), poweroffice-aggregate-sql (shared corpus parity), poweroffice-roles (exact grants,
readiness tamper), poweroffice-locks (RLS incl. restrictive definer policy, lock matrix), poweroffice-cleanup (confined runner routine),
poweroffice-authority (A4), poweroffice-generic (no generic path), poweroffice-upgrade (accepted S3-C → S4-A), poweroffice-nonsuper;
RC1 repair: poweroffice-deadline (actual DB-clock deadline at statement and COMMIT), poweroffice-binding (paired binding CHECK, upgrade);
setup ../support/poweroffice-fixtures.ts + poweroffice-history.ts (TEST-ONLY writers; superuser-only aging in replica mode).
Stage 4 S4-C: poweroffice-read (C2 precedence rows), poweroffice-read-auth (C1 all-of/denials/expiry/audit failure/concurrency),
poweroffice-api (actual HTTP rows, envelopes, Gateway exclusion, network trap), poweroffice-maintenance (C3 admission/capability/runner
config/bounds), poweroffice-cleanup-budget (lock 1 s, original 10 s incl. slow login, audit failure, Connection UPDATE orders and deadlock
victims; ~35 s), poweroffice-cli (C4 actual CLI journey + privacy), poweroffice-fence (R1 fence/readiness); RC2: poweroffice-cleanup-deadline (Astra
S4C-rc1 R1/R2: login+routine+COMMIT over budget, COMMIT-only, slow login, CLI exit 1; ~75 s); RC3: poweroffice-cleanup-inherited
(Astra S4C-rc2 R1: inherited role/database/startup transaction_timeout, stricter/looser inherited values; ~56 s); RC4:
poweroffice-cleanup-phases (Astra S4C-rc3 F1/F2: pg_settings lock during setup, watchdog CancelRequest with server timers off,
idle effective-timer timeout vs early termination; ~27 s); RC5: poweroffice-cleanup-classification (Astra S4C-rc4 F1/F2:
early generic transport loss before the timer, genuine idle timer, early admin termination, known SQLSTATEs in the window; ~55 s); setup ../support/poweroffice-read.ts,
poweroffice-process.ts + the test-only preload poweroffice-net-trap.ts.
Stage 5 ASK-A: ask-http (actual processes: OFF/MOCK, raw boundary, aliases, parser goldens, logs), ask-source (cited answers,
injected plans, source validation/caps, privacy), ask-authority (Q2 barriers, rebinding, post-INSERT rollback, shared fence lock),
ask-budget (Q6 owners, planners, deadline, rolling), ask-physical (rc2: sequential-lock phase bounds, disconnect barriers), ask-helper-boundary (rc3: held
digest-setting return inside currentToken; terminal/original/phase deadline); setup ../support/ask-pg.ts (in-process DB API from dist with test planner).
Stage 5 ASK-REMOTE R-A: ask-remote-policy (vocabulary, singleton/immutable policy, +1 versions with the fence, no-op, allowlist,
revoke/reactivate, stale consent before reserve, max-bigint tombstone), ask-remote-ledger (reserve/settle exactly once, UTC periods
and session TimeZone, unknown/crash/restart, late original-period settlement, caps, ledger invariant, runtime DML denial; one 10 s
wait), ask-remote-race (two-session lock-wait orderings, five-process last month dollar, storm, fence-first pause, settlement without
fence), ask-remote-roles (confinement probes + restore), ask-remote-upgrade (accepted baseline → R-A), ask-remote-nonsuper;
setup ../support/ask-remote-pg.ts, child ../support/ask-remote-child.ts, accepted roles text ../support/roles-s5askb.sql.
Stage 5 ASK-REMOTE R-B (scripted in-process provider seam only, never network): ask-remote-journey (compiled API remote V2,
MOCK-equal local facts, all-of permission, consent before reserve), ask-remote-upstream (non-200/fault codes, durable pause,
real day cap), ask-remote-egress (floor inside the routine via real lock waits + insert probe, post-INSERT expiry,
linearization, commit latency/terminal/unknown COMMIT via a test-only deferred trigger), ask-remote-floor (direct
reserve_floor + confinement), ask-remote-settle (drain, post-egress revocation, settlement failure, late success, ignored
abort/disconnect owners), ask-remote-process (compiled process, production seams, network trap); setup ../support/ask-remote-api.ts.
R-B RC2: ask-remote-rc2 (Astra RC1 R1 exact 4500/4499 after secret resolution; R2 401/403 oversized/stalled bodies through
the actual direct transport + ../support/ask-remote-http-fake.ts → durable pause).
These tests use disposable databases and unique roles; never run them against a persistent tenant database.
Do not print environment values, connection URLs or credentials. Keep synthetic data and cleanup in finally/after.
Preserve existing Stage 1 journeys; use focused tests during edits and the required suite at checkpoints.
