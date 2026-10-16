# S4-C implementation report — dedicated reads, API/CLI and bounded maintenance

Status: **IMPLEMENTED — PENDING fresh independent GPT-6 Astra/xhigh acceptance.** Not self-accepted. LIVE remains
**DEFERRED_BY_OWNER**; synthetic MOCK evidence establishes no vendor, accounting, completeness or production readiness.
Implementer: native Claude Code `claude-opus-5-5`, effort high, one cohesive session, no subagents (session/provider identity is
captured separately by the launcher). Brief: `S4C_IMPLEMENTATION_BRIEF.md`.

## Baseline and scope

- Baseline verified before any edit: HEAD `916a4d69…`, branch `planning/stage2-m365`, all 821 files of
  `verification/stage4/S4C_BASELINE.json` hash-identical. Architecture package, migrations, roles.sql, seals, status files,
  historical evidence and unrelated dirty work untouched (no migration, schema, role or shared-contract change).
- New: `packages/poweroffice/{read-contracts,read,maintenance,runner-role}.ts`, `packages/ops/poweroffice.ts`,
  `apps/api/src/db/poweroffice.ts`; tests `tests/poweroffice-read.test.ts`,
  `tests/pg/poweroffice-{read,read-auth,api,maintenance,cleanup-budget,cli,fence}.pg.test.ts`; support
  `tests/support/poweroffice-{read,process,net-trap}.ts`; this report.
- Minimal edits: `apps/api/src/db/app.module.ts` (imports PowerOfficeModule), `scripts/ops.ts` (dedicated dispatch before the
  legacy parser/Actor authentication + header lines), `.env.example` (runner reference), `docs/RUNBOOK.md` §10,
  `docs/AI_CONTEXT_MAP.md` (one row), `packages/poweroffice/AGENTS.md` (S4-C list), `tests/pg/AGENTS.md` (routing).
- Existing accepted helpers reused unchanged: `withPowerOfficeAuthority`, binding/locks/rows/composition/sync/recovery,
  readiness CTEs (`graph/poweroffice-role.ts`, `poweroffice-surface.ts`), `m365/maintenance.ts runnerUrlFor` (same-target URL
  comparison), `fence-errors.ts`. No helper was modified. Largest new file 186 lines.

## Behaviour (C1–C4)

**Reads (`read.ts`, `read-contracts.ts`).** Mode first; then one authority transaction (operation read): fence FOR SHARE →
readiness → current all-of `context:read`+`poweroffice:read` on one membership (else exactly one workspace denial) → plain scoped
Connection → State FOR SHARE (never initialized) → token/expiry/ACTIVE actor/rights after ALL locks. Unknown/invisible/
non-PowerOffice → `POWEROFFICE_NOT_FOUND`, no audit. UNAVAILABLE (CONNECTION_UNAVAILABLE / BINDING_CHANGED) is decided from the
Connection and State pointer before any Snapshot read. Snapshot expiry (`clock ≥ expiresAt`) and age (`> 15 min` from asOf) are
computed in SQL against one DB clock read after the locks; an expired payload is not even selected. 04 precedence is a pure
first-match function. The summary DTO has exactly 02's 11 fields; the status DTO omits summary/amounts and adds local
`lastAttemptId`, `lastAttemptSequence`, `lastSuccessAt`. Both are rebuilt field by field, validated against exact whitelists
(stored aggregate re-validated) and frozen before the atomic `poweroffice.{status,summary}.read` audit (six-key metadata:
connectionId, outcome READ, snapshotId when shown, safeErrorCode). Audit failure → `POWEROFFICE_AUDIT_FAILED`, no payload.
asOf/expiresAt/businessDate are non-null only with a visible snapshot (FRESH/STALE).

**HTTP (`apps/api/src/db/poweroffice.ts`).** Route-specific dispatch without ApiTokenGuard/Actor/Gateway/ToolExecution: bearer →
opaque PowerOffice credential → read service. 401 missing/malformed/unknown/expired, 403 scope/permission, 404 not found,
400 any query parameter, 409 conflict codes, 503 mode/readiness and the UNAVAILABLE DTO, 200 other precedence rows,
500 audit failure/unexpected. Every response `Cache-Control: no-store`, `synthetic:true`; nothing is logged.

**CLI (`packages/ops/poweroffice.ts`).** `poweroffice-status|summary|sync|recover|cleanup --client C --connection N` only, each
once; token only from `ATLAS_OPERATOR_TOKEN`; dispatched before the legacy parser. Exit 0 success (UNAVAILABLE read → 1),
1 operation failure, 2 usage/configuration (`INVALID_ARGUMENTS`, DISABLED, MODE_UNSUPPORTED, RUNTIME_NOT_READY,
AUTHENTICATION_FAILED). Any runtime self-check failure or unreachable runtime is `POWEROFFICE_RUNTIME_NOT_READY`.

**Maintenance (`maintenance.ts`, `runner-role.ts`).** `openPowerOfficeRuntime` pairs Prisma and URL privately.
`admitPowerOfficeCleanup`: mode → authority(maintain, fence FOR UPDATE) → closeout binding (DISABLED/advanced lifecycle allowed)
→ pairing facts (database, postmaster start, routine OID, sole EXECUTE grantee) → private single-use WeakMap capability.
`runPowerOfficeCleanup`: runner URL from `ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF=env://NAME`, full same-target comparison,
runtime URL with runner credentials; one original monotonic 10 s budget started before client/pool acquisition
(`maxWait`=remaining), `statement_timeout`=min(10 s, remaining) and `lock_timeout` 1000 ms before any lock, runner confinement +
pairing check inside the transaction, singleton GUCs, statement_timeout re-set to remaining before the routine, pre-COMMIT
budget check. Timeouts (57014/55P03/P2028/P2024/budget) → `CLEANUP_TIMEOUT`; 40P01/40001 → `DB_CONFLICT`; routine BUSY →
`SYNC_BUSY`; init/confinement/pairing → `RUNTIME_NOT_READY`; everything else (PO010, audit) → `CLEANUP_FAILED`. No retry/loop.
Counts reach only the trusted CLI; the routine's audit stays six-key without counts.

## Evidence by case (all on actual PostgreSQL 17, disposable DBs/unique roles)

- C1: `poweroffice-read-auth` (split/context-only/poOnly/admin/foreign/unknown/malformed clients — one workspace denial each, no
  client audit/State/ledger; revoked/expired/unknown/disabled/forged credential — nothing written; last-lock expiry while
  waiting on State; actual read and denial audit failures), `poweroffice-api` (every envelope over real HTTP, Gateway list/execute
  exclusion equal to an unknown tool, no ledger row, ClientContextV1 unchanged), `poweroffice-read.test.ts` (whitelists).
- C2: `poweroffice-read` one case per 04 row; success→failure→ACTIVE→success and success→ABANDONED→ACTIVE→success; ERROR
  with ACTIVE; read-time expiry before purge; publish→purge→EXPIRED with lastCompleted SUCCEEDED and lastSuccessAt retained
  (handoff 2); purged→failure/ACTIVE stays EXPIRED; known empty `{0,[]}`; UNAVAILABLE outranks EXPIRED; reads change no domain
  row; `poweroffice-read-auth` concurrent read/publication coherence; HTTP status per row in `poweroffice-api` (handoff 5).
- C3: `poweroffice-maintenance` (maintain all-of denials, NOT_FOUND/unbound, unforgeable single-use capability, completion
  after revocation, 10 runner misconfigurations incl. other DB/port/query/runtime/owner/Stage 2 runner/wrong password —
  RUNTIME_NOT_READY, zero effects, no URL in errors; BUSY even 40 days expired; NO_STATE no-op; disabled-source purge; sibling
  same-client connection untouched; 1003 attempts → 1000 + morePending, then 2; sequence kept; audit without counts),
  `poweroffice-cleanup-budget` (runner facts positive/negative controls; lock wait → TIMEOUT ≈1 s; actual routine audit failure;
  statement cancelled at the original budget ≈10 s; with a real ~4 s runner login delay still ≈10 s, positive control of the
  delay; real Connection UPDATE orders; deadlock with each side as victim), `poweroffice-fence` (R1 healthy/missing fence,
  readiness tamper, runner privilege granted after admission caught by the runner-side check).
- C4: `poweroffice-cli` actual `scripts/ops.ts` processes: status MISSING → sync → summary FRESH (exact aggregate) → crashed
  claim (BUSY, RECOVERY_NOT_DUE, cleanup BUSY) → recover ABANDONED → STALE/DEADLINE with previous summary → NO_ACTIVE_ATTEMPT →
  sync FRESH → expiry EXPIRED → cleanup purge → status EXPIRED/SUCCEEDED; refusals; privacy capture of every stdout/stderr,
  audit row, denial and Stage 1 telemetry/Decisions/observation/raw/snapshot/entity/ledger table counts; network trap empty for
  all CLI and API processes with a positive self-control.
- Handoff obligations: 1 restrictive definer isolation — accepted S4-A `poweroffice-locks` + new sibling test; 2 above;
  3 deferred commit guards unchanged (no SQL change); 4 Connection UPDATE vs cleanup below; 5 above; 6 replay unchanged (S4-B);
  7 no seed/bind CLI (grammar test refuses `poweroffice-seed`); 8 audit `outcome` comment unchanged in `audit.ts`.

## Checks

Focused runs during implementation: unit 5/5; PG read 9/9, read-auth 5/5, maintenance 6/6, cleanup-budget 7/7, api 6/6,
cli 3/3, fence 3/3. Full required run `/tmp/atlas-stage4/s4c-tools/checks.sh rc1-final`, logs
`/tmp/atlas-stage4/s4c-checks/rc1-final/`: all 11 exit 0 (start 09:44:31Z, end
09:47:26Z): npm test **213/213** (208 accepted + 5 new), schema:validate, db:generate, typecheck, api:build, api:smoke,
test:pg **549/549** (510 accepted + 39 new; 151 s), db:check:pg17, db:check:drift, git diff --check, untracked-whitespace.
The report itself was completed after the run (documentation only); diff/whitespace checks were re-run on it.

## Failed runs and repairs (preserved honestly)

1. read: fixture set DISABLED without a lifecycle bump (installed trigger refuses) → fixture corrected.
2. read-auth: an already-past token expiry violates `ApiToken_expiry_check` → real 200 ms expiry and wait.
3. cli: owner as runtime returned UNEXPECTED_ERROR (self-check raises RUNTIME_ROLE_BYPASSES_RLS, not only NOT_CONFINED) → any
   runtime self-check failure now maps to `POWEROFFICE_RUNTIME_NOT_READY` (code fix, test unchanged).
4. api: trap control used the ESM named `net.connect` binding (not patched) → control uses the module default object.
5. cleanup-budget: first run hung (>300 s, killed) because the TEST admitted cleanup (fence FOR UPDATE) while its own mutator
   held the fence until the admission returned → admission now precedes the mutator. Timing bounds then widened for parallel
   test:pg load (≤13 s; a reset budget would be ≥14 s) and the 15-minute boundary margin moved to 30 s.

## Qualifications and residual risks

- No natural deadlock exists between a Connection UPDATE and cleanup: the routine takes no Connection tuple/KEY SHARE lock and
  inserts no PowerOffice row. Natural orders are tested (UPDATE holding the fence → cleanup lock timeout, zero effects; cleanup
  holding the fence → UPDATE waits and commits after). The deadlock cases use a CONSTRUCTED cycle (an owner transaction holds the
  State row, then UPDATEs the Connection). Victim selection: session `deadlock_timeout` for the mutator; for the cleanup-victim case
  a committed `ALTER ROLE <disposable PO runner> IN DATABASE <disposable db> SET deadlock_timeout='600ms'`, RESET in finally
  (a pg_db_role_setting row scoped to a per-test role and database, both dropped afterwards; not an ACL change).
- Pool-acquisition evidence uses a test-only PG17 `login` event trigger (owner-created, PUBLIC-revoked function, delays only the
  disposable runner role) dropped in finally. Other DB-local test objects (audit fault/slow triggers) are PUBLIC-revoked and dropped.
- Prisma's interactive-transaction `timeout` starts after acquisition, so it is only a backstop; the original budget is enforced by
  `maxWait`=remaining, per-statement `statement_timeout`=remaining and JS checks between statements and before COMMIT (a residual
  sub-millisecond window between the last check and COMMIT).
- Reads and cleanup admission use the accepted authority transaction, which has no `lock_timeout`: they wait for a held fence (an
  explicit cleanup may hold it up to 10 s; documented in RUNBOOK §10 with the per-read audit row and the 1000-attempt cap).
- Interpretations within 02/03 (no new codes): configuration/pairing/runner confinement → `POWEROFFICE_RUNTIME_NOT_READY`; cleanup
  deadlock → `POWEROFFICE_DB_CONFLICT`; cleanup BUSY → `POWEROFFICE_SYNC_BUSY`; HTTP 500 for `POWEROFFICE_AUDIT_FAILED`/
  `UNEXPECTED_ERROR`; CLI exit 1 for an UNAVAILABLE read; NOT_FOUND reads unaudited, UNAVAILABLE reads audited. HTTP 409 is mapped
  but no read path produces it in tests.
- The runner-side pairing check compares database name, postmaster start time, routine OID and grantee name with the admission's
  observation; together with the URL comparison it proves the same server/database without printing URLs.
- No architecture contradiction found; nothing outside the brief's scope was changed.
