# ASK-REMOTE R-A RC2 repair report (R1–R5)

**Acceptance: PENDING** fresh independent Astra/xhigh review of the new sealed package. R-B/R-C NOT_STARTED; no provider
call, network path, mode change, key, account, admission or deployment. This report SUPERSEDES the inaccurate parts of the
frozen historical `S5ASKREMOTE_RA_IMPLEMENTATION_REPORT.md` (RC1, unchanged): its cap-revision note, its "no restart
inference can refund" / 10 s "in-process proof" claims and its invariant-table row for crash/restart. RC1 evidence stays as is.

| Item | Value |
|---|---|
| Implementer | same native Claude Code session `c369847a-a53f-49c8-8d0f-346ff833a938`, requested `claude-opus-5-5`, effort high; billing per `S5ASKREMOTE_RA_RC2_PREFLIGHT.json` (included subscription; no API/credits/fallback); quota unknown |
| Repair baseline | `verification/stage5/S5ASKREMOTE_RA_RC2_REPAIR_BASELINE.json` sha256 37e80c33…; before any write all 1233 source + 227 built hashes matched, no extra/missing file; review result f86cf8b7…, design seal 1f32029c…, closure 84077251… matched (`/tmp/atlas-stage5/askremote/ra/impl-rc2/prewrite-repair-baseline-proof.FINAL.json`) |
| Scope | only R-A files: the two new R-A migrations (not deployed; earlier migrations frozen), R-A modules/tests/support, RUNBOOK §14, module routing; ten norms, RC1 reports/evidence, root status/brief/baseline/preflight/seals/reviews unchanged (`scope-final.json`) |

## Closures

**R1 — cap increase (P1).** `atlas_ask_remote_policy_revise` refuses (AR009) when either proposed cap exceeds its CURRENT value,
before any fence/policy change, whatever the approval reference, expiry renewal or state change; the policy guard refuses a cap
increase on any write path (AR007), even by the confined definer. There is no budget-increase path; an increase needs the
separately reviewed amendment of 04. Test `ask-remote-policy` "RC2 R1": day +1, month +1, both, new approval reference,
expiry renewal, raise while lowering the other cap, raise with revoke, reactivation that raises, raising back to an earlier cap —
each AR009 with policy, version, fence, counters and history byte-identical; revoke, reactivation+renewal+new reference with
equal caps, lowering, no-op and equal caps succeed; counters never rewritten; definer direct raise AR007. The RC1 ledger cap test
that re-raised caps now uses independently provisioned projects (`freshProject`) for the exact month boundary and asserts that
raising a lowered cap back is refused.

**R2 — readiness surface (P2).** New `packages/graph/ask-remote-surface.ts` (startup) mirrors the provisioning postcondition:
every user object in ANY schema, allowlist anchored to `public."<name>"`, effective table AND column `WITH GRANT OPTION`,
explicit grant options, schema ownership/CREATE (explicit, PUBLIC or inherited) in every schema and explicit schema grants
except on public, sequences, owned relations/types/routines/namespaces, non-shared or SECURITY DEFINER executable routines,
database CREATE and the built-in/PUBLIC escalation rules (pg_init_privs, parameters, languages, types, large objects, FDW,
user mappings, default ACLs, shared dependencies, tablespaces). `ask-remote-role.ts` uses it for `arOwnerViolations` and
public-anchored missing-grant checks; the fence owner/function/policies and roles.sql provisioning checks are unchanged.
Test `ask-remote-roles` "RC2 R2": the two demonstrated cases (fence `UPDATE(version)` and nearby `SELECT(workspaceId)` with
grant option; another schema's CREATE) plus PUBLIC CREATE elsewhere, explicit USAGE elsewhere, schema ownership (roles.sql
also refuses), CREATE on public, allowlisted column/table with grant option, a same-named table in another schema, column
grant elsewhere, PUBLIC SELECT elsewhere, a PUBLIC SECURITY DEFINER routine elsewhere, database CREATE — each fails the focused
facts AND the shared runtime readiness, is restored, and shared readiness (fence + runtime, mode-independent) passes again.

**R3 — expiry while blocked (P1).** `atlas_ask_remote_reserve` re-checks the DB-clock policy expiry after the counter locks
(which may wait) and immediately before RETURN; either raises AR001 so the attempt INSERT and both counter increments are
undone. Test `ask-remote-ledger` "RC2 R3": the owner holds the MONTH counter, reserve blocks (pg_locks, no sleep-based
ordering), the policy expires, the lock is released → AR001, no new attempt, both counters unchanged. No R-B deadline/dispatch
wiring was added; R-B still owns credentials, original deadline, the 4500 ms floor and post-commit conditions.

**R4 — pure time helpers (P2).** `validInstantMs` (safe integer within the ±8.64e15 ms Date range) gates `admissionDecision`
(now and expiry) and every `settle` (creation and now, and now ≥ creation as in SQL); NO_DISPATCH requires
creation ≤ now ≤ creation + 10 s using a BigInt difference. Unit test "RC2 R4": NaN, ±Infinity, invalid Date, fractional,
out-of-range, string/null, reversed chronology for three outcomes, exact window bounds incl. both ends of the range; integer
money results unchanged.

**R5 — no-dispatch claims (P2).** Corrected: routines migration header, budget.ts/AGENTS.md comments, RUNBOOK §14, unit/PG
test names and labels. The SQL TRUSTS the runtime caller's outcome; the 10 s window only bounds how late a zero refund can be
claimed. Retained: the durable-liability/late-claim test (renamed; one 10.2 s wait). Added: the observational limitation test
— a fresh connection settles NO_DISPATCH = 0 inside the window and is accepted. **Mandatory R-B acceptance prerequisite:** a
private, non-reconstructible, in-process dispatch/refund ownership proof; it cannot be inferred from persisted attempt or
correlation IDs, reconnection, elapsed time or missing completion records. No nonce or partial R-B was added.

## Changed paths (relative to the repair baseline)

Existing: `prisma/migrations/202610111010_stage5_ask_remote_state/migration.sql` (guard: no cap increase; comment),
`202610111020_stage5_ask_remote_routines/migration.sql` (R1 cap check, R3 two expiry rechecks, R5 header),
`packages/ask/remote/budget.ts` (R4, R5 comments), `packages/ask/remote/AGENTS.md`, `packages/graph/ask-remote-role.ts` (R2),
`docs/RUNBOOK.md` §14, `tests/ask-remote-budget.test.ts`, `tests/pg/ask-remote-{policy,ledger,roles}.pg.test.ts`,
`tests/support/ask-remote-pg.ts` (`freshProject`). New: `packages/graph/ask-remote-surface.ts`, this report. Built delta:
`dist/packages/ask/remote/budget.js`, `dist/packages/graph/ask-remote-role.js` changed; `ask-remote-surface.js` added;
`dist/operator/*` unchanged. Exact diff: `RA_RC2_DELTAS.diff` (against the hash-verified pre-write snapshot).

## Verification

Focused (logs under `impl-rc2/logs/`): unit 10/10; PG policy 8/8, ledger 10/10, roles 8/8, race 6/6, upgrade 1/1, nonsuper 2/2.
Final ALL14 (`checks/run1/summary.txt`, 2026-10-10T23:25–23:30Z), all exit 0: npm test 368/368 (RC1 367 + 1), schema:validate,
db:generate, typecheck, ui:typecheck, ui:build, api:build, api:smoke, test:pg 651/651 (RC1 647 + 4), db:check:pg17,
db:check:drift PASS, test:ui 73/73, git diff --check, untracked whitespace. Production (`prod-staging/`): fresh copy, `npm ci`
of the unchanged lockfile, generate, build, dev prune, staged dist = repository dist (0 of 228 differ), operator manifest
unchanged, foreign-cwd fixture MOCK/OFF browser/asset checks and DB OFF/MOCK startup smoke passed, token/question absent.

RC2 mutation probes (isolated copies, root unchanged; `mutation/`, `mutation-n12/`): 11 of 12 KILLED — routine cap check,
both cap layers, guard cap check, surface removed, schema CREATE current-schema-only, unanchored allowlist, both expiry
rechecks, expiry instant, creation instant, reversed chronology, both column-grant-option layers. N05 (only the effective
column grant-option term) SURVIVED because the explicit-ACL grant-option term detects the same direct grant (redundant layer);
N12 removing both was killed. The lock-wait test cannot tell which of the two R3 rechecks fires (either suffices). The
18 RC1 mutation proofs remain historical and are not claimed to validate RC2.

Failures/process notes (`FAILURES.md`): the first two focused PG runs used the unmodified RC1 runner before the RC2 runner
existed; N05 survival; a first N12 invocation that applied nothing. Cleanup: metadata before/after identical (six atlas*
databases incl. the four pre-existing `atlas_it_*` not attributed to this work and untouched, 29 atlas* roles, 0 connections).

## Residuals

R-A SQL cannot establish private bearer authentication, no-dispatch continuity, network delivery, provider usage authenticity,
model quality, R-B clocks/drain ownership or an invoice cap. Unknown reserve/settle commits retain liability until a separately
authorized reconciliation. Shared-fence contention with Stage 3 as in RUNBOOK §14. Data/budget admission, R-EVAL, real use and
deployment remain NOT_ADMITTED.

Stop at R-A. Write ownership returned on exit; acceptance PENDING fresh Astra/xhigh.
