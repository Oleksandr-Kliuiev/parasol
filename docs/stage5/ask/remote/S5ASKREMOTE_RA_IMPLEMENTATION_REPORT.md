# ASK-REMOTE R-A implementation report

**Acceptance: PENDING** fresh independent Astra/xhigh actual-code review. Design approval (S5ASKREMOTE-DESIGN-rc2) is not
code acceptance. R-B/R-C NOT_STARTED; no provider adapter, network path, mode change, key, account, admission or deployment.

| Item | Value |
|---|---|
| Implementer | native Claude Code, requested `claude-opus-5-5`, effort high; session `c369847a-a53f-49c8-8d0f-346ff833a938` (fresh); billing per preflight (included subscription, no API/credits/fallback); quota attribution unknown; actual-message-model verification is the coordinator's stream evidence |
| Brief / baseline | `S5ASKREMOTE_RA_IMPLEMENTATION_BRIEF.md` sha256 7d715af3…; baseline `verification/stage5/S5ASKREMOTE_RA_IMPLEMENTATION_BASELINE.json` sha256 565318ee… (HEAD 916a4d6, branch planning/stage2-m365) |
| Pre-write proof | all 1205 source + 224 built hashes matched, no extra/missing files; brief, preflight, design seal 1f32029c… and closure 84077251… matched (`/tmp/atlas-stage5/askremote/ra/impl/prewrite-baseline-proof.FINAL.json`) |
| Architecture | ten-file RC2 package 9c92327f… unchanged (hash-verified at the end) |
| Write window | ownership 2026-10-10T22:15Z → returned at exit; sole writer; no parallel writer/formatter; mutations ran only in isolated copies |

## Deltas

New files:
- `prisma/migrations/202610111000_stage5_ask_remote_permission` — latest ClientMembership CHECK re-created with all 13 accepted
  values + `ask:remote`; no row changed or granted.
- `prisma/migrations/202610111010_stage5_ask_remote_state` — RemoteAskPolicy (one row/workspace, unique admissionId and
  projectIdentity, BIGINT policyVersion, fixed profile/EU/SYNTHETIC/reserve, caps ≤ 2,000,000/10,000,000 micro-USD, expiry ≤ 168 h
  after the latest revision, TOMBSTONE ⇔ max bigint), RemoteAskClientAdmission (ADMITTED/REMOVED, never deleted, stamped
  changedAtPolicyVersion), RemoteAskPeriodCounter (DAY/MONTH UTC, charged ≥ 0 and ≤ cap limit), RemoteAskAttempt (server UUID,
  captured admission/version/profile/price/rates 275/825, original dayStart/monthStart derived from createdAt AT TIME ZONE 'UTC',
  EGRESS_COMMITTED → SETTLED|UNKNOWN with exact accounted/token CHECKs). Scoped composite FKs (workspace in every reference,
  RESTRICT); FORCE RLS with exactly one PUBLIC workspace policy each. One invoker guard `atlas_ask_remote_guard` (writer must be
  the remote routine owner; no DELETE/TRUNCATE; immutable identities; policy +1 only; TOMBSTONE terminal; allowlist change carries
  the advanced version; attempts settle once) and a DEFERRABLE INITIALLY DEFERRED ledger check `atlas_ask_remote_ledger_check`
  (every touched counter = sum of accounted of its period attempts, AR010). All triggers ENABLE ALWAYS; PUBLIC revoked.
- `prisma/migrations/202610111020_stage5_ask_remote_routines` — SECURITY DEFINER, `search_path = pg_catalog, pg_temp`,
  qualified objects, no dynamic SQL, PUBLIC revoked: runtime `reserve` (scope args = settings → fence FOR SHARE + epoch check →
  policy FOR SHARE → consent tuple first (AR002) → active/expiry (DB clock)/profile/price/reserve/client (AR001) → unique-safe
  MONTH/DAY counter creation → MONTH FOR UPDATE → DAY FOR UPDATE → both `charged+300000 ≤ cap` (AR003) → attempt INSERT → both
  counters +300000), runtime `settle` (period keys read unlocked → MONTH → DAY → attempt FOR UPDATE; identity client/correlation/
  state; USAGE_VERIFIED ceil cost, NO_DISPATCH 0 only ≤ 10 s after the attempt, other outcomes keep the reserve as UNKNOWN; refund
  to the ORIGINAL periods; never fence/policy), runtime `pause` (fence FOR UPDATE +1 → policy +1 PAUSED; non-active no-op; never
  activates); owner-only `policy_create` (INACTIVE v1, once), `policy_revise` (expected version, all material fields, identical
  revision = no-op, ACTIVE needs future expiry) and `client_set` — all fence FIRST FOR UPDATE then policy, fence +1 and
  policyVersion exactly +1 per material mutation, max → TOMBSTONE atomically (AR008 after).
- `prisma/askremote.prisma` (four models), `packages/graph/ask-remote-role.ts` (focused readiness: tables/RLS/policy/CHECK/FKs,
  triggers, routine set/config/owner/no PUBLIC, owner attributes/memberships/ownership/exact privileges incl. fence columns,
  exact EXECUTE ACLs, runtime SELECT-only/no grant options), `packages/ask/remote/{AGENTS.md,budget.ts,ledger-sql.ts}` (pure
  BigInt transitions; fixed statements, validated parameters, SQLSTATE AR001–AR010 mapping).
- Tests: `tests/ask-remote-budget.test.ts`; `tests/pg/ask-remote-{policy,ledger,race,roles,upgrade,nonsuper}.pg.test.ts`;
  support `tests/support/ask-remote-pg.ts`, `ask-remote-child.ts` (test-only process for the multi-process race),
  `roles-s5askb.sql` (byte-exact accepted roles.sql, sha256 9e35dd9e…, recovered from the accepted ASK-B source archive and
  matched against the baseline record).

Changed existing files (why):
- `prisma/roles.sql` 474→646 lines (<700): header doc; eighth role `atlas_ask_remote_definer` set inside the DO block (printed
  status row unchanged); accepted 7-role distinctness check kept verbatim + separate remote distinctness check; routine-presence
  check (exactly 8 `atlas_ask_remote_*`); role loop includes the remote role (NOLOGIN, owner-only non-INHERIT membership);
  runtime REVOKE INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on the four tables AFTER generic and default grants;
  §4c reset + exact allowlist + fence SELECT(workspaceId,version)/UPDATE(version) + ownership transfer/ACL reset of the 8 routines
  + runtime/owner EXECUTE; §5 routine/table postcondition and complete capability-surface postcondition for the remote role.
  Existing fence definer, both fence policies, PowerOffice/M365 blocks unchanged. Not split: provisioning is one psql
  transaction rendered as one script by tests; splitting would change the production procedure.
- `prisma/schema.prisma`: back-relations only (Workspace, Client, Actor).
- `packages/graph/runtime-role.ts`: four tables in PROTECTED_TABLES; ASK-REMOTE CTEs/columns/problems in the shared check.
- `tests/support/roles-sql.ts`, `pg-harness.ts`: eighth role name (optional, derived atlas_app_*→atlas_rem_* for callers that
  predate it), teardown, `remoteRole`, accepted pre-remote text reader/renderer.
- `tests/context-mapper.test.ts`: the eight new facts in the confined fixture and as fail-closed cases (additive).
- `tests/pg/action-upgrade-s3b.pg.test.ts`, `action-upgrade-s3c.pg.test.ts`: their exact list of migrations after Stage 3 (last
  extended at S4-A) now also names the three R-A migrations; still exact (see F8).
- Routing only: `prisma/AGENTS.md`, `packages/ask/AGENTS.md`, `tests/pg/AGENTS.md`, `docs/AI_CONTEXT_MAP.md`; RUNBOOK §14.
No app/API/operator/service/compiler/planner/connector/script, dependency, lockfile, tsconfig, old migration, norm, root
AGENTS/workflow/status/brief/baseline/preflight change (`scope-final.json`). Exact deltas: `RA_DELTAS.diff` (baseline copies
hash-verified).

## Invariants and their evidence

| Requirement | Evidence (all real PG17, nonsuperuser runtime; nonsuperuser owner in ask-remote-nonsuper) |
|---|---|
| Vocabulary preserved, nothing granted | policy test 1; upgrade test (CHECK grows, memberships/fences/counts/privileges identical, 0 `ask:remote`) |
| Singleton immutable policy/admission/project; no DELETE/recreate | policy tests 2–3 (AR009 second create/shared project/admission; owner direct DML AR007; definer identity UPDATE 42501, version skip/rewind AR007) |
| policyVersion +1 with fence +1 per material mutation; no-op unchanged; revoke/reactivate monotonic | policy tests 4–6 (11 field changes, allowlist admit/remove/re-admit, pause) |
| Max bigint tombstone | policy test 7 (aged to max−2; reaching max via allowlist change → TOMBSTONE; reserve AR001; revise/client_set AR008; pause no-op; recreate AR009) |
| Stale consent refused before reserve despite newer fence | policy test 6 (current fence captured, old tuple → AR002, ledger unchanged) |
| Foreign workspace/client/actor/admission/attempt/project | ledger tests 3–4 (AR001/AR004/AR005/AR006), FORCE RLS on all four tables, race scenarios per project |
| Two-session/process races, absent counters | race tests 1–3 (pg_locks orderings; 5 OS processes → exactly 3 admitted at the month cap) |
| Rollback, duplicate settlement, no negative spend, invariant | ledger tests 3–4, 8 (AR006, 23514, AR010), race storm (no deadlock, counters = Σ accounted ≤ cap) |
| UTC periods, session TimeZone, late settlement | ledger tests 2 (Kiritimati/Pago_Pago), 6 (aged attempt refunds 2020 periods only) |
| Unknown/crash/restart: no reset/replay; no restart no-dispatch | ledger test 5 (connection closed after commit; 10.2 s wait; NO_DISPATCH AR006; UNKNOWN terminal) |
| Lower cap below spend pauses admission; revision cannot reset budget | ledger test 7 |
| Confinement negatives + restore | roles tests (stray PUBLIC definer/invoker/trigger routine; missing/extra owner/fence grants; runtime table/column DML, grant option, owner routine, default-grant replay; membership/INHERIT/LOGIN/ownership; RLS/policy/trigger/FK/CHECK drift; reprovision idempotent; name collision) |
| Existing fence/runtime readiness in OFF/MOCK | roles test 1; full suite; production DB-mode smoke (staged dist from cwd /, `ATLAS_ASK_MODE=off` and `mock`: started, /clients 200, capabilities 404/200) |

## Verification

Focused runs and failures are logged under `/tmp/atlas-stage5/askremote/ra/impl/logs/`. Final ALL14 (`checks/run1/summary.txt`,
2026-10-10T22:51–22:56Z): npm test 367/367 (358 established + 9); schema:validate; db:generate; typecheck; ui:typecheck; ui:build;
api:build; api:smoke; test:pg 647/647 (616 established + 31); db:check:pg17; db:check:drift (PASS); test:ui 73/73; git diff --check;
untracked whitespace — all exit 0. Production (`prod-staging/`): fresh copy, `npm ci` of the unchanged lockfile, generate,
build, dev prune (same package set as the accepted ASK-B run), staged dist = repository dist (0 of 227 differ), served from cwd /
in MOCK and OFF with the accepted browser workflow checks, token/question absent from logs, DB-mode readiness smoke passed.
Built delta versus baseline: `dist/packages/graph/runtime-role.js` changed; `ask-remote-role.js`, `ask/remote/{budget,ledger-sql}.js`
added; all `dist/operator/*` unchanged.

Mutation probes (`mutation/mutation-results.json`, each in an isolated copy, root hashes identical before/after): 18/18 killed —
stale consent, day cap, month cap, duplicate refund, cross-scope settle, refund to current period, allowlist skipped, no-dispatch
window, runtime DML not revoked (roles.sql postcondition refuses), runtime EXECUTE revise, guard PUBLIC, ledger check no-op, guard
writer check, readiness blind to runtime grants, PROTECTED_TABLES omission, cost without ceil, tombstone not terminal, pause
without fence (killed by the fence +1 assertion; the race test alone does not detect it because policy row locks still serialize).

Preserved failures (`FAILURES.md`): F1 PL/pgSQL CASE-in-IF parse; F2 readiness alias shadowing; F3/F5 tests expecting the
guard where column grants/row CHECK refuse first (stronger layer; both asserted now); F4/F7 test bugs (RLS expectation, constant
ORDER BY); F6 missing ROLLBACK after expected roles.sql refusals; F8 first full PG17 run 643/647 (`logs/test-pg-1.FAILED.log`):
exact post-Stage-3 migration lists, and my edit of the accepted "seven different roles" line — reverted to the accepted text.

## Decisions to review, residuals

- DB backstops beyond the literal text, all conservative: guard admits writes only from the remote routine owner (no owner
  direct DML); deferred counter = Σ accounted invariant; NO_DISPATCH settle-0 limited to 10 s after the attempt (original 8 s +
  2 s settlement clock), so no later/restart inference can refund; reserve maps FK/duplicate-correlation failures to AR004.
- Pause-by-owner is `policy_revise(... 'PAUSED')` (reason OWNER); runtime pause reasons MODEL_MISMATCH/USAGE_INVALID/UPSTREAM_AUTH.
- Caps may be set anywhere in [0, proposed limit] by an owner revision (with a new owner-approval reference and version); a
  later revision may raise within the limits. If "lower only" must be relative to the previous revision, that is a one-line
  routine change.
- Bounded shared-fence contention with Stage 3 (RUNBOOK §14): revisions/pause take the workspace fence FOR UPDATE, wait for
  FOR SHARE holders and invalidate in-flight Ask/Stage 3 final admissions of that workspace; settlement never takes it.
- Unknown commit outcomes of reserve/settle retain liability until a separately authorized reconciliation; the ledger is not an
  invoice/tax/other-usage cap; provider-side limits and account/EU/retention facts are unverified (R-EVAL NOT_ADMITTED).
- `prisma/roles.sql` is 646 lines (under the 700 cap); readiness is focused (complete built-in surface lives in roles.sql §5).

Stop at R-A. Write ownership returned on exit; required fixes stay in this session; acceptance PENDING Astra/xhigh.
