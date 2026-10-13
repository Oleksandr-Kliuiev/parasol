# S4-C S4C-rc5 bounded independent acceptance

**Verdict: ACCEPTED — MOCK S4-C. Required findings remaining: 0.** RC4-F1 and RC4-F2 are closed on the exact artifact below. The cancellation/deadline regressions remain closed, and the unchanged C1/C2/C4 scope retains the independent RC4 assessment. LIVE remains **DEFERRED_BY_OWNER**. This is implementation acceptance, not deployment or production admission.

Review date: 2026-10-10. Bounded re-review in the original independent `/root/astra_s4c_rc4` session, retaining the explicitly assigned **gpt-6-astra / actual effective xhigh**; no effort change is claimed. The original RC4 assessment used fresh context. RC5 changes classification and recorded failure evidence, preserving the approved timers, cancellation, authority and public contracts, so a bounded continuation is appropriate. No new critical invariant scope was found.

Native assignment record `/tmp/atlas-stage4/S4C_RC5_REVIEW_ASSIGNMENT.json` SHA-256 `2833bb97b73a95fccf669160629fc2142649672dd7c107ae2b44ba488e347b83` records the retained assignment. This report's self-description is not response-model telemetry; independent provider response-model telemetry and attributable subscription quota remain unavailable. No fallback, API billing or usage credits were enabled.

## Accepted identity

- HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, **plus the exact frozen dirty inventory**.
- Manifest `verification/stage4/S4C_RC5_MANIFEST.json`, SHA-256 `e82261f28bb2855c3a0acb87b9a71351eade9f2a4f93354ae39eb68ebb1058e7`.
- Package hash `fa688a1a1f7161fc013e2c7ff63cba1b603c92c35d5cd68d02d446a600c99ae9`.
- Working inventory hash `c55014378905f036b65d4f15bbe7be552b10e3642259a48f7a876e9d111d1cd8`.
- Source archive `/tmp/atlas-stage4/S4C_RC5_SOURCE.zip`, SHA-256 `1cdf3ca1a211bf6c2befc2d9a015cc4da1b594946752b4007602db38dfce8003`; repository `verification/stage4/S4C_RC5_PACKAGE.zip` is byte-identical.
- Accepted S4-B seal SHA-256 `bf0c92fa0ad30a28b4e522b4f9fd6ee4472330c8be9db48f0b55d8dd3792b697`; accepted design seal SHA-256 `b37061ad1d673aa3ca05cefd049faeafdc98cd8d88d319921d5a8e44375305ad`.
- Unchanged eight-file architecture package `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`.

Before/after verification checked all **889 inventory files**, all **842 source/archive entries**, both aggregate hashes, complete working-tree path inventory with only the current manifest/archive self-exclusions, S4C baseline and exact RC4 deltas, accepted S4-B manifest/archive/review hashes and preserved dependency files. The eight architecture files are byte-exact. The preserved 11 Stage2/eight Stage3/eight Stage4 normative files, 24 migration artifacts and 362 prior checkpoint/fixture artifacts remain unchanged. Verification logs: `/tmp/atlas-stage4/astra-s4c-rc5/inventory-{before,after}.log`; verifier `verify.py` in the same directory. The last verification occurred after all independent database work.

The only changed production source is `packages/poweroffice/runner-transaction.ts`, SHA-256 `99177f2933f222c29b5bfcfb693f654e3b1475b119d24d9326ed9e5d081c2362`. Inspection of its RC4→RC5 diff confirms classification/evidence capture only: first terminal event and observation time, failure context fixed before rollback, known-state precedence, connect classification, and watchdog fire time as evidence. CancelRequest bytes/endpoint/backstop behavior, original budget, timeout installation, BEGIN anchor, stricter inheritance, lock cap, maintenance body, pairing, confinement, admission, roles/schema and dependencies are unchanged.

## Finding closure

**RC4-F1 — CLOSED.** The first session terminal event is now retained even without a SQLSTATE, including its monotonic observation time and budget remaining. Classification compares that event with the failing operation's observation and uses the earlier evidence. The catch captures context before rollback, so rollback/close cannot rewrite the cause.

The original reviewer `/tmp/atlas-stage4/astra-s4c-rc4/early-transport-probe.mjs` was rerun **unchanged** on RC5. Actual socket loss was observed at **9 ms**, with no SQLSTATE; the independent database observer verified the backend was already gone before the stricter one-second timer. Callback failure at **1,519 ms** now returns **POWEROFFICE_CLEANUP_FAILED**, as required. The new repository PG regression separately reproduced an event at **12 ms**, zero backends at approximately 100 ms, and FAILED at **1,519 ms**. Genuine one-second idle timeout remains TIMEOUT; early administrative termination remains FAILED.

**RC4-F2 — CLOSED.** Known SQLSTATEs are classified before clock inference. Timeout states remain TIMEOUT, 40P01/40001 remain DB_CONFLICT, and other known states remain CLEANUP_FAILED at any remaining budget. Connect-phase known authentication/database/refusal states retain RUNTIME_NOT_READY. Only causes without a code use the original deadline window, effective timer or watchdog inference.

The original `early-terminal-probe.mjs` was rerun **unchanged**: 57P01/42501/PO010 at zero budget all now return FAILED; its real administrative-termination control at 8 ms, resumed at 1,519 ms, remains FAILED with zero backends. The old probe's obsolete `expired`/`serverDue` context fields are ignored by RC5, so this probe establishes the direct known-state precedence; the new context is separately tested in the boundary matrix and actual helper tests.

Independent repository unit execution passed the **251/250/0 ms** matrix for query states and session-terminal states, genuine timeout/conflict/initialization codes, early generic events, later secondary events, equal-time structured preference and connect readiness. Actual PG statements raising 22012/42501/PO010 with **140–149 ms** remaining returned FAILED; 40P01 returned conflict and 55P03 timeout. These helper tests deliberately disable their transaction timer to reach the classification window; they do not claim that production disables timers.

An additional reviewer-authored `first-cause-matrix.mjs` passed **10/10 assertions**, checking context captured before elapsed rollback time, early generic terminal evidence before a later coded error/watchdog, known terminal states before secondary errors, and the exact effective-deadline boundary. No message-text parsing or raw error exposure was added.

## Independent verification and retained scope

One focused command used `/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test` with absolute repository paths for:

- `tests/poweroffice-{runner-phases,runner,read}.test.ts`;
- `tests/pg/poweroffice-{cleanup-classification,cleanup-phases,cleanup-deadline,cleanup-inherited,cleanup-budget}.pg.test.ts`.

**38/38 passed: 15 unit + 23 PG17**, zero failed/cancelled/skipped, **75.490 seconds**. Log `/tmp/atlas-stage4/astra-s4c-rc5/targeted.log`. The three original reviewer probes were invoked unchanged through the same wrapper without `--test`; their RC5 logs are `early-transport.log`, `early-terminal.log` and `login-boundary.log`. The additional pure matrix ran with `node --experimental-strip-types`; log `first-cause-matrix.log`. `git diff --check` passed.

The focused run re-established:

- actual admitted setup-lock cancellation at **1,030 ms**, while the catalog lock remained held until 10.5 seconds; no backend/domain/audit effect then or after release, with successful positive cleanup;
- watchdog protocol cancellation at **10,010 ms** despite the test-only body disabling all server timers; no remaining backend;
- default and inherited role/database/startup login+routine+deferred-COMMIT deadline cases, COMMIT-only delay, complete rollback and delayed observation with no late audit/commit; within-budget success;
- stricter inherited timers, lock cap, slow/default login, wrong-password readiness, actual CLI timeout exit 1, audit failure, confinement/pairing and both constructed Connection-update deadlock victims.

Unchanged API/read/CLI/maintenance files retain the RC4 independent inspection and **64/64** passing tests recorded in `docs/stage4/reviews/ASTRA_S4C_RC4.md` (SHA-256 `fa564a6531245b695dfe3c7e96a2aced48c2d0d8b7c4821e90b1e73a70e555e1`). That earlier report's only required findings were the now-closed F1/F2. Its evidence supports C1/C2/C4: private current bearer authority and all-of/last-lock checks, exact DTOs and read precedence, expiry/audit atomicity, synthetic/no-store HTTP, Gateway exclusion, strict CLI, single-use admission, scoped bounded purge, privacy and the narrow database endpoint allowance in the network trap. Those unchanged suites were not redundantly repeated here.

The RC5 implementer record `S4C_RC5_IMPLEMENTATION_EVIDENCE.json` SHA-256 `14818b5885e5278b1cb89a778063e8a881b2d0cc122da7c85dea866658f4ea85` reports all **11 required checks passing**, including **223/223 unit/PGlite and 565/565 PG**, schema validation/generation, typecheck, API build/smoke, PG17, drift and whitespace. Log files and count summaries were inspected; their hashes are recorded in reviewer `checked-implementer-logs.json`. These remain implementer evidence, not reviewer execution. The original native Opus5.5/high session `02752ee0-ea51-4249-b089-d6aba4205d5d` is retained in the receipt, with actual-message-model evidence and subscription routing. Failed earlier attempts and the partially incompatible RC4 unit negative control are disclosed; closure does not depend on that unit negative control.

## Qualifications and stopping point

The unchanged login-boundary probe returned TIMEOUT at **1,008 ms** for its configured one-second connect timeout, never entered the application body, observed the three-second server login trigger still sleeping, then observed zero backends. The RC4 nonblocking boundary remains: pre-BackendKeyData server login code cannot be cancelled by this application connection, but no application transaction/routine follows its closed socket. This acceptance does not require broader server privileges or promise termination of arbitrary server-admin login code.

Unchanged qualifications also remain: an uncoded loss first observed at a timer boundary can be indistinguishable from a coincident transport failure; PostgreSQL's atomic commit point and a lost COMMIT acknowledgement can leave an unknown outcome, with no automatic retry; CancelRequest carries the backend cancellation key to the same paired endpoint and has a two-second socket backstop; PostgreSQL 17 is required. JavaScript network traps do not cover Prisma's native engine as operating-system egress control. Per-read audit cost, workspace-fence waits, retention cap and constructed-deadlock qualifications remain. MOCK does not verify live vendor/accounting semantics or production readiness.

One **nonblocking editorial inconsistency** remains in the old introductory comment at `runner-transaction.ts:25-30`: it still says “any failure” in the original window and “first structured” event. The executable classifier, focused documentation and RC5 decision table correctly implement the now-accepted rule: first observed terminal evidence, and clock inference only for uncoded causes. This is not a remaining behavior/acceptance finding; no post-freeze source edit was made.

The reviewer made no repository edits, builds/generators, role-surface changes, vendor/account/deployment or production operations. Database tests used only approved disposable PG17 resources; scripts/report/logs remain in the assigned `/tmp` locations. No secrets, URLs, cancellation keys or raw database errors were printed. No seal or status file was written. Acceptance is tied to the exact RC5 identity above; later substantive changes require appropriate renewed review. LIVE remains deferred.
