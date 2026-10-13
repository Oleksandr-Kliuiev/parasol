# Bounded re-review — S5ASKREMOTE-REVAL-SERVER-RSB-rc2 (RS-B)

Reviewer: native Claude Opus 5.5 (`claude-opus-5-5`). This is the same independent reviewer session that produced
`OPUS_S5ASKREMOTE_REVAL_RSB_RC1.md`, continued for the bounded rc2 re-review that the role policy allows. I have no
implementer history and saw no other verdict. Effort `max` comes from the owner's launch and cannot be verified from inside
the session. Date: 2026-10-11.

Constraints held:
- I made no repository change apart from this report.
- Probes and mutations ran only in `/private/tmp/rsb-review-opus2/copy`, a copy with `node_modules` symlinked; the copy has been deleted.
- I did not stop or modify the native cluster.
- No network, provider or paid call was made.

Scope: the rc1→rc2 delta of 17 files, everything else in the package that the delta newly affects, the closure of rc1
findings F1–F11, and the owner's B1 decision. That decision itself (the FX04 exception) is not mine to overturn; I judged only whether its
implementation is exact, narrow and safe.

## Verdict

Verdict: APPROVE_RS_B

All four required rc1 findings (F1–F4) are closed. I checked each one in code, by re-running the tests, with independent probes
and with mutation tests. The owner's B1 exception is implemented exactly and narrowly. It cannot reach any Ask projection, and with it all 11 fixtures × 5
intents prove ALL_TRUE on PG17 (Docker and native). That meets the 05 RS-B exit criterion. I accept the exact seed mapping
`77d98c70…563b` together with `seed-plan.ts`.

The remaining items are **optional and minor**: untested refusal paths, stale documentation, and test timing fragility under heavy
load. All of them fail closed, so none produces a false positive. They should be fixed before RS-C starts, but they do not block RS-B.

## 1. Artifact identity (recomputed)

- Manifest `verification/stage5/S5ASKREMOTE_REVAL_RSB_RC2_MANIFEST.json` has file sha256
  `b0643fb69ac6bd46d3ee40d82237835233b607038dde940e2967ecc968cc4534`, which **matches**.
- The packageHash `a34d85d18d5c8eb86118a9ecadff1004da07e4f1e12a9e5a8250585b34a93fc2` was recomputed over the 17 changed and 26 added entries. It **matches** whether computed from the manifest
  hashes or from the working-tree files.
- The baseline file is unchanged (`e5227b4f…de4c`). Its changed-entry baselines match, and no file outside the manifest was
  changed, added or removed. The exclusions are RC1/RC2 receipts, `OPUS_S5ASKREMOTE_REVAL_RSB_*` and the gitignored `dist/`, `node_modules/`, `.env` and `*.log`.
- The rc1→rc2 delta is exactly the 17 files listed in the request. Nothing was added or removed.
- `npm run test:pg` rebuilt `dist/` byte-identically (whole-tree fingerprint `7ffbcc7a…aaa` before and after).
- The RC2 receipt log hashes all match `…_RC2_CHECKS.json`, and the RC2 evidence logs are now `.txt`.

## 2. Closure of rc1 findings

| rc1 | Status | Evidence |
|---|---|---|
| **F1** PAUSED gate in FIXTURE_CHECK | **CLOSED** | `fixture-check.ts:51` refuses on s1 and `:86` on s2, both with `POLICY_CHANGED`, before V is spawned or the payload is built. The rc2 test covers s1 ACTIVE. My probe P3 set the policy ACTIVE while V ran (s1 PAUSED, s2 ACTIVE) and got `FAILURE POLICY_CHANGED`. The s2 path itself has no test (N1). |
| **F2** D3 INACTIVE | **CLOSED** | `inventory.ts:111` requires exactly PAUSED. Tests cover INACTIVE for register and ACTIVE→INACTIVE for install (`reval-materialize.pg.test.ts:40-49,82-87`). The RUNBOOK RS-B section is corrected. |
| **F3** negative controls | **CLOSED** | New tests: tampered intent expectations turn only `allFiveIntents` false; a coverage tamper turns `expectedFacts` false; a finance change while V runs turns `financeUnchanged` false; a generation bump after V commits gives `FIXTURE_MISMATCH` (stall hook). My own mutation runs were each **detected**: M1 (always-true intents), M2 (hard-coded `financeUnchanged`), M11 (s2 generation check removed), and M5 (exception matcher ignoring `externalId`). |
| **F4** census false positive (autovacuum) | **CLOSED** | Details below. |
| F5 verifier code outside the declared digests | Open, carried | Recorded in report §6 as an RS-C/RS-D residual, as I recommended (optional). |
| F6 read failures mislabelled | **CLOSED** (functionally) | `fixture-verify.ts:120-125,136-138`. Probe P2: a simulated `57014` gives `REFUSED DEADLINE`, and a JS stall past the phase or idle timeout gives `REFUSED INTERNAL_FAILURE`; neither yields all-false booleans. There is no test (N1). |
| F7 `seedMappingSha256` does not cover the code rules | Open, residual | Accepted as a residual in report §6. |
| F8 visible bgworkers not counted | **CLOSED** | Covered by the same predicate as F4: every type except autovacuum is counted. |
| F9 verifier confinement | **CLOSED** (functionally) | `fixture-verify.ts:95-97` runs the accepted `RUNTIME_ROLE_CHECK_SQL` and `assertConfinedRuntimeRole`. Probe P1: V running as the table owner gets `REFUSED UNAUTHORIZED`. The check costs about 60 ms on Docker. There is no test (N1). |
| F10 stale RUNBOOK | **Partly** | The RS-A paragraph is fixed. The RS-B FX04 paragraph is now stale (N2). |
| F11 gitignored logs | **CLOSED** | RC2 evidence is `.txt` and tracked. |
| **B1** FX04 / "All 11×5" | **RESOLVED** by the owner; implementation verified | See §3. `reval-fixtures` gives 11 × `ALL_TRUE`. The native chain installs FX04. |

F4 evidence:
- `OTHER_WRITER_PREDICATE` (`inventory.ts:74-75`) excludes only `backend_type = 'autovacuum worker'`, or a row whose backend type and user are both NULL. In PostgreSQL, autovacuum workers record no user (`st_userid` is InvalidOid, so `usesysid` is NULL). Client backends, bgworkers and walsenders always carry a user, and so remain counted when their type is hidden.
- A predicate test over 9 synthetic rows covers this.
- I ran 18 parallel `reval-fixtures` runs with diagnostics that log any offending backend: **0/18 failed**. Under the same procedure rc1 failed 2/18. Both rc2 full suites passed every census-dependent test.

## 3. B1: the owner-approved FX04 exception

What was implemented:
- `seed-mapping.json:13-17` adds one `schemaExceptions` entry: FX04 / `readerExcludedLinks` / index 0, the declared CANDIDATE PERSON↔huntress agent link
  `syn-h-agent-0009`, stored with `materializedResourceType` `contact` and the marker `OWNER_APPROVED_2026-10-11_RSB_REVIEW_B1`.
- The pinned digest changed accordingly in `dataset.ts:14`.

Verified properties:
- **Exact.** The exception applies only when fixtureId, list, index and all seven declared link fields are equal
  (`seed-plan.ts:202-204`).
  - A variant with a different `externalId` → `LINK_TYPE_INCOMPATIBLE` (unit test).
  - My mutation that ignores `externalId` was detected.
  - A stale exception (wrong index) refuses, because an unused exception is a mapping error (`:222`).
  - Duplicate entries also refuse: the second one is unused.
- **Narrow.** The decoder (`:91-101`) admits only CANDIDATE, only `readerExcludedLinks`, only a declaration that violates
  `EntityLink_type_compat_check`, and only the single compatible target type. At most four entries are allowed, and each must carry an `OWNER_APPROVED_*` marker.
  - CONFIRMED links (`spec.links`, where `excludedIndex < 0`) can never match, and `LINK_CLASS` forbids CONFIRMED excluded links.
  - The FX02 variant (a CONFIRMED link changed to contact↔DEVICE) stays `PLAN_INVALID`.
- **No leak into projections.** Probe P4 installed FX04 and read it with the accepted reader at the pinned reference:
  - Reader links are `[]`, and neither the source nor `project()` mentions `syn-h-agent-0009` or `contact`.
  - The stored row (CANDIDATE `contact` with `syn-h-agent-0009`) is visible only by direct table read.
  - V proves ALL_TRUE, and the expected entity stays UNRESOLVED.
  - The frozen dataset bytes are unchanged (hash-pinned and statically tested), so every expectation is unchanged.
- **Nothing weakened.** No SQL or constraint changed, and the stored link satisfies the accepted CHECK and FKs.

Residual: non-Ask readers of CANDIDATE links, such as the mapping review queue in `packages/graph/mapping.ts:249` (which requires `mapping:review`,
a permission the designated actor does not hold), would show `contact`. Record the stored-versus-declared difference wherever the fixture
corpus is described, and in the next R-EVAL plan revision (alongside D2 and the FX08 limitation).

## 4. New findings (all optional)

### N1 — P3 — OPTIONAL — Three rc2 refusal paths have no negative test

- Where: `fixture-check.ts:86` (s2 PAUSED), `fixture-verify.ts:95-97` (F9), `:120-125` (F6).
- Evidence: one mutation removed all three. The whole RS-B PG set still passed: Docker 20/20 and native 1/1.
- Report §6 says F6/F9 are proven by "existing + new tests" (`IMPLEMENTATION_REPORT.md:79`), which is inaccurate.
- The behaviour itself is correct (probes P1–P3), but a regression would go unnoticed.
- Fix: add P1-, P2- and P3-shaped tests:
  - V as the table owner → `UNAUTHORIZED`;
  - a source-read SQL timeout → `DEADLINE`;
  - the policy changed to ACTIVE while V runs → `POLICY_CHANGED`.

### N2 — P3 — OPTIONAL (fix before RS-C) — Stale or inaccurate documentation

- `docs/RUNBOOK.md:654-655` still says FX04 is `PLAN_INVALID` and needs a dataset revision. That contradicts rc2, where FX04
  installs through the exception. The RUNBOOK should also say that FX04's excluded link is stored as `contact` under the owner exception.
- `IMPLEMENTATION_BRIEF.md:132` says the exception was "recommended by the reviewer". My rc1 report listed it as the least
  invasive option and explicitly left the decision to the owner.
- `IMPLEMENTATION_REPORT.md:79`: see N1.

### N3 — P3 — OPTIONAL — FIXTURE_CHECK concurrency tests are timing-fragile under load

- Evidence:
  - My first full `npm run test:pg` gave 744/746. One failure was the rc2 F3 finance test ("verifier not observed connected"); the other was an RS-A test, noted below. A second full run gave **746/746**.
  - With six `reval-fixture-check` files in parallel, the rc1 generation-during-V test failed 2–4 of 12, returning `CENSUS_UNAVAILABLE`, `DEADLINE` or `INTERNAL_FAILURE` instead of `FIXTURE_MISMATCH`. This happens with or without the rc2 confinement check, so the test design is inherited from rc1.
- Causes:
  1. These sessions start with `fixture-check` as their first operation, so C's startup shares the 450 ms first-snapshot sub-budget (`FIXTURE_BUDGET.firstReadMs`).
  2. The tests use a 500 ms sleep inside V within V's roughly 800 ms budget, observed by polling `pg_stat_activity` with a new superuser connection every 10 ms.
- Every outcome fails closed; none is a false positive.
- Fix:
  - Begin these sessions with `snapshot`, which absorbs startup.
  - Synchronise through a marker file written by the test verifier entry, as the stall hook already does, instead of polling with new connections; shorten the sleep.
  - In the RUNBOOK, say a first `fixture-check` after launch may return `CENSUS_UNAVAILABLE` or `DEADLINE` under load and can be repeated. This matters because install requires C to be stopped, so fixture-check is normally the first operation of a new session.

### N4 — note, no change required for RS-B

- An RS-A test, `tests/pg/reval-closure.pg.test.ts:136` ("executor lifetime …"), failed once in my first full run (expected
  `DEADLINE`, got `CONTAINMENT_UNCONFIRMED`) and passed twice in isolation and in the second full run.
  RS-B did not change `pause.ts`, `closure.ts` or that test, so this is pre-existing RS-A load sensitivity. Track it in the RS-A or RS-C backlog.
- V's pg client, like RS-A's, has no `'error'` listener. If the server terminates the session asynchronously, for example on the idle-in-transaction
  timeout, the error is unhandled and V can crash before it sends a result. C then reports `FIXTURE_MISMATCH` or `DEADLINE`. This fails closed but the code is misattributed.

## 5. Commands run and results

| Command | Result |
|---|---|
| Identity: manifest, package and baseline recomputation; rc1→rc2 delta (`python3 -I` script, git ls-files) | all match; 17-file delta exactly as stated |
| `npm test` | 520 tests: 511 pass, 8 fail (the same RC5 `CORPUS_IDENTITY_MISMATCH` set as RS-A), 1 skipped (RC5 historical view, environment variable not set); exit 1 (qualified) |
| `npm run typecheck`, `schema:validate`, `db:check:pg17`, `db:check:drift`, `api:smoke` | all pass |
| Focused Docker PG17 `reval-{fixtures,materialize,maintain-cli,fixture-check}` | 20/20; 11 × `ALL_TRUE`; real-clock negative: mismatch for the 9 fixtures with an OK resource, equal for FX04 and FX06; FIXTURE_CHECK 276–307 ms |
| Native `reval-native-rsb` and `reval-native-unix` | 2/2 (FX02 → FX04 via the exception → FX08; FIXTURE_CHECK 266 ms) |
| Full `npm run test:pg` (native descriptor), run 1 | 746 tests: 744 pass, 2 fail (N3, N4) |
| Full PG suite, run 2 | **746/746** |
| 18 parallel `reval-fixtures` runs with census diagnostics (copy) | 0/18 fail (rc1: 2/18) |
| Probes P1–P4 (copy) | owner as V → `UNAUTHORIZED`; SQL timeout → `DEADLINE`, stall → `INTERNAL_FAILURE`; ACTIVE during V → `POLICY_CHANGED`; FX04 leaves no trace in the reader output |
| Mutations M1, M2, M11, M5 (copy) | each detected by at least one test |
| Combined mutation (s2 PAUSED, F9 and F6 removed) | survives (N1) |
| `reval-fixture-check` × 12 under 6-way parallel load, with and without the confinement check | 2/12 and 4/12 timing failures (N3) |

Leftover check: neither PostgreSQL server has new databases or roles. The pre-existing `atlas_it_*` and `atlas_pilot_*` databases date from
2026-10-08 to 2026-10-10 and were left untouched. The native cluster holds only its admin role. The temporary copy has been removed.

## 6. Residuals

Carried from rc1:
- F5: V runs TypeScript sources outside the declared digests, while phase1 will run `dist/`.
- F7: derivation rules live in `seed-plan.ts`, covered by the package hash but not by `seedMappingSha256`.
- D4: the interim census instead of RS-D DRAIN, which forces S and C to stop for every switch.
- D6: the Ask-path clock-isolation tests belong to RS-C.
- `loadedBinding` UNVERIFIED; Docker results are regression evidence and native results are test-fixture evidence, never MEASURED.
- The table owner remains a trust boundary.
- FX08's freshness limitation.
- D2 and the B1 stored-versus-declared difference must be recorded in the next R-EVAL plan revision.

New:
- FIXTURE_CHECK latency rose with the confinement check: 266–440 ms native and 276–367 ms on Docker, still within the 1800 ms budget. Margin on the target platform is unmeasured.
- The first-operation sub-budget (N3).
