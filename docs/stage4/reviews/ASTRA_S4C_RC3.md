# S4-C S4C-rc3 independent actual-code acceptance

**Verdict: CHANGES_REQUIRED.** The previous late-COMMIT counterexamples are repaired, but C3 still has an unbounded initial setup query. A second timeout-classification defect affects an idle gap under a stricter inherited timer. Both findings below require closure before acceptance. LIVE remains **DEFERRED_BY_OWNER**.

Review date: 2026-10-10. This fresh reviewer was explicitly assigned native **gpt-6-astra / xhigh** for the critical cancellation changes. Native assignment is external identity evidence; this report's self-description is not response-model telemetry. Independent response-model telemetry and attributable subscription quota are unavailable. No fallback, API billing route or credits were enabled. No other current-artifact verdict was consulted; the RC1/RC2 findings were treated as repair requirements.

The review made no repository edits, builds, generators, formatters, vendor/account/deployment or production operations. All database probes used the approved silent wrapper, disposable PG17 databases and unique roles. The catalog-lock probes take an uncommitted lock only in their disposable database and release it in `finally`; they change no catalog content or shared ACL. No credentials, URLs or raw exception messages were printed. Reports, scripts and logs are confined to the assigned `/tmp/atlas-stage4` destinations.

**Exact artifact and preservation**

- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`, plus the frozen dirty inventory.
- Manifest: `verification/stage4/S4C_RC3_MANIFEST.json`, SHA-256 `4ff0b6c4c46f37577e9b3b6a534c63d0be885e9c53fdadd618c923945210ea87`.
- Package hash: `be28fd52cfa597fbad5cbd04e8d79a72e4aff5ea81e0a2f3c560bafeda828542`.
- Working inventory hash: `5488f60c9592166fe7205c1c4a60ddab818191b479c608fdfbd64ed8dbbb838e`.
- Source archive: `/tmp/atlas-stage4/S4C_RC3_SOURCE.zip`, SHA-256 `b54814a4887bd9e605f834fa051c50b5004d8853c6681b8741608561848659c3`; repository `S4C_RC3_PACKAGE.zip` is byte-identical.
- Accepted S4-B dependency seal: SHA-256 `bf0c92fa0ad30a28b4e522b4f9fd6ee4472330c8be9db48f0b55d8dd3792b697`.
- Accepted design seal: SHA-256 `b37061ad1d673aa3ca05cefd049faeafdc98cd8d88d319921d5a8e44375305ad`.
- Unchanged eight-file architecture package: `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`.

All **867 working inventory entries** and **822 source archive entries**, both aggregate hash rules, and every archive member were verified before and after review. The enumerated Git working inventory has exactly the manifest and its verified package copy as additional self-packaging files. The S4-B and design seals and their referenced manifests/archives verify; all eight current architecture files match their approved hashes. Baseline and RC2 deltas match the declared changes/additions exactly, with no removals. All pre-existing Prisma artifacts are unchanged; the declared deltas preserve accepted migrations, normative documents and prior checkpoint/fixture history. The manifest records 11 Stage2, eight Stage3 and eight Stage4 normative artifacts, 24 migration artifacts and 362 prior checkpoint/fixture artifacts preserved. Evidence: `/tmp/atlas-stage4/astra-s4c-rc3/verify.py`, `identity-before.log`, `identity-after.log`.

The runtime dependency repair is correct: independent structural comparison with the frozen RC2 archive verifies that `package.json` only moves `pg` **8.23.1** into runtime dependencies; the lockfile only changes the root classification and removes `dev: true` from exactly 13 runtime-tree entries. No package was added/removed and no version, resolved URL or integrity changed. `@types/pg` remains a development dependency. Packaging-install/typecheck/unit/maintenance evidence is supplemental implementer evidence, not an independent installation performed by this reviewer.

**Required finding RC3-F1 — P2: the initial settings query has no cancellation deadline**

Location: `packages/poweroffice/runner-transaction.ts:127–128`, with the delayed check at lines 131–132 and the post-BEGIN guard at line 144.

The first `SELECT … FROM pg_catalog.pg_settings` runs after `connect()` but before this code installs any session timeout. With the ordinary zero inherited timeouts it can wait indefinitely on a relation lock. The original monotonic budget and the 250 ms setup guard are only examined after awaited work returns; neither cancels this query. Consequently the operation and server backend can remain active after ten seconds. This violates the approved whole-transaction/setup/lock bound even though the later check prevents cleanup mutations.

Independent reproduction through the **actual private admission and cleanup wrapper** on the frozen source:

1. Create the standard disposable database/roles, publish a synthetic snapshot and age it into cleanup eligibility.
2. Obtain a real `admitPowerOfficeCleanup` capability before introducing the lock.
3. In another owner connection in this disposable database, `BEGIN; LOCK TABLE pg_catalog.pg_settings IN ACCESS EXCLUSIVE MODE` without committing.
4. Invoke the real `runPowerOfficeCleanup` with its properly paired confined runner; independently observe its promise, backend and committed domain rows after the original deadline.

At **13,506 ms** the promise was still unresolved. `pg_stat_activity` independently showed one runner backend **active**, waiting on a **relation lock**, with its query identified as the initial `pg_catalog.pg_settings` read. Domain state still matched the before-image. After the observer released the lock, cleanup finally returned **POWEROFFICE_CLEANUP_TIMEOUT at 13,521 ms**. Pointer, snapshots and attempts remained unchanged; there were **zero cleanup audits** and **zero runner backends after release**. A preceding helper probe independently remained active at 11,511 ms and returned only after release at 11,524 ms.

This is a server query visibly left working/waiting after the deadline, not a lost acknowledgement or PostgreSQL's brief atomic commit interrupt window. It does not establish a late domain commit; the downstream fail-closed guard works.

Required repair: cover the **initial settings read and every subsequent connection/setup await** with actual cancellation anchored to the original pre-acquisition budget. Preserve the same connection, stricter inherited policies, pairing/confinement, no retry, and acknowledged-commit semantics. A timer that merely rejects a client promise while a backend remains active is insufficient. Do not move or reset the original deadline. Add a real-wrapper regression that holds this lock beyond ten seconds: the wrapper must terminate/refuse within the bound and the observer must see no working runner backend while the lock is still held; recheck unchanged rows/audits after releasing it and after any delayed work could have ended. Retain all default/inherited and positive-commit controls.

Evidence: `/tmp/atlas-stage4/astra-s4c-rc3/admitted-setup-lock.mjs` (SHA-256 `235a2afd3fdeca3a8e3cd7686eeaab83b9ff0df8d8a95b39acdc54551cb0972c`) and `admitted-setup-lock.log`; earlier `setup-lock-probe.mjs` / `setup-lock-probe.log`. These diagnostic scripts exit zero when the observed counterexample is established; exit zero is not acceptance.

**Required finding RC3-F2 — P2: a known stricter idle transaction timeout maps to CLEANUP_FAILED**

Location: `packages/poweroffice/runner-transaction.ts:114`, effective timer selection at lines 133–134, and failure classification at line 160 / `runnerFailure` lines 68–77.

The helper honors a shorter inherited transaction timeout at the server, but classification only knows the original ten-second budget. If the server terminates the session during an idle gap, a later query can reject with a generic driver error rather than SQLSTATE 25P04. With the original budget still well above 250 ms, `runnerFailure` returns CLEANUP_FAILED even though the effective server deadline caused the rollback. The no-op session `error` handler also retains no terminal cause when one is available. The comment that a server termination always surfaces on a pending query is insufficient for idle termination.

Independent **helper-level** probe, with no source patch: set `transaction_timeout = '1s'` only for the disposable runner in its disposable database; call the real `runBoundedTransaction` with a new original budget, perform `bounded.statement()` / `SELECT 1`, deliberately await 1.5 seconds in its callback, then request another bounded statement. Result: **POWEROFFICE_CLEANUP_FAILED at 1,512 ms**, with **zero remaining backends**. Repeated runs agree. A direct `pg` control under the same inherited setting confirms that both the idle session error and the subsequent rejection are generic `Error` objects with no structured code. Therefore this report does **not** claim that a SQLSTATE was necessarily discarded; it verifies that the helper loses the usable effective-deadline context.

This probe intentionally introduces an idle gap through the helper callback; it does not claim that today's public maintenance body explicitly sleeps. The helper expressly promises cancellation and fixed timeout classification while idle between statements, and a scheduling pause can expose this path. Server rollback is correct; the result code is wrong.

Required repair: preserve the effective earlier deadline and any structured session terminal cause, and classify a positively identified idle timeout as **POWEROFFICE_CLEANUP_TIMEOUT** without parsing raw messages or blanket-classifying every early disconnect as timeout. Add this real PG17 idle regression plus a non-timeout connection-failure control, while preserving wrong-password readiness and conflict classification. Keep callback work/commit inert after cancellation.

Evidence: `/tmp/atlas-stage4/astra-s4c-rc3/idle-timeout.mjs` (SHA-256 `de6c8c3b3013064c3643301c1a442a5a026a5d5033a793a868f4341e186a9bde`) and final `idle-timeout-structured.log`. Earlier observation logs are retained separately.

**Previous findings and nearby acceptance cases**

The specific RC1/RC2 **late-COMMIT R1 counterexamples are closed on the tested paths**. Reading inherited values, setting and verifying SESSION values on one dedicated connection before BEGIN correctly supplies the initial transaction timer. The default 4+4+4 second case and role/database/startup inherited 30-second variants now time out with complete pointer/snapshot/attempt/audit rollback, delayed observation and no remaining working backend. A within-budget commit succeeds. Stricter inherited transaction settings and the one-second lock cap work during active SQL. The new RC3-F1 setup gap means the overall C3 deadline contract is still not closed.

The original **RC1 R2 acquisition classification remains closed**: tests cover structured initialization codes, actual long login/default connect-timeout behavior, actual CLI timeout exit 1 and wrong-password readiness. The new idle classification finding is a distinct path.

Actual-code inspection and independent checks support the nearby C1/C2/C4 behavior: private bearer authority; one-membership all-of permissions; re-authentication after the last lock; no client-existence probe; no financial DTO before successful audit commit; DB-clock expiry and first-match read precedence; strict DTO projection; HTTP synthetic envelopes/no-store and 503 UNAVAILABLE; Gateway exclusion; strict CLI arguments and single-use admission; paired URL options and actual database identity; confined runner; ACTIVE refusal, no-State no-op, disabled purge, sibling isolation, preserved sequence/history and 1000-row bound; audit/lock rollback and both constructed deadlock victims. No additional required defect was established in these areas.

The revised test-only network trap was inspected critically: the CLI passes the paired runtime URL's exact hostname and effective port; only a matching direct socket target and that hostname's DNS lookup are allowed. Other fetch/socket entry points remain trapped. The positive self-control now runs with the same DB allowance and proves other fetch/net/socket targets are still recorded. The API retains the trap without a DB socket allowance. This is appropriately narrow for the new Node `pg` connection. As before, Prisma's native engine is outside these JavaScript hooks; the tests do not claim general operating-system network isolation or LIVE transport evidence.

**Independent verification**

Commands used the prefix `/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test` and absolute test paths under `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1/`:

- `tests/pg/poweroffice-cleanup-inherited.pg.test.ts` and `tests/pg/poweroffice-cleanup-deadline.pg.test.ts`: **9/9 passed**, zero failed/cancelled/skipped, 74.902 seconds. Log: `/tmp/atlas-stage4/astra-s4c-rc3/deadline-inherited.log`.
- `tests/poweroffice-read.test.ts`, `tests/poweroffice-runner.test.ts`, and `tests/pg/poweroffice-{maintenance,cleanup-budget,cli,api,read-auth,read,fence}.pg.test.ts`: **48/48 passed**, zero failed/cancelled/skipped, 32.007 seconds. Log: `/tmp/atlas-stage4/astra-s4c-rc3/nearby-tests.log`.

Total independent existing tests: **57/57 = nine unit and 48 PG17 tests**. The API tests use the already-built checkpoint artifact; no reviewer rebuild occurred. The new reviewer counterexamples are separate from those 57 passes. Their commands replace `--test <paths>` with the corresponding absolute `.mjs` path under `/tmp/atlas-stage4/astra-s4c-rc3/`. `git diff --check` passed. Identity checks passed before and after all probes/tests.

The implementer's required eleven-check record reports all exits zero, with log summaries independently inspected at **217/217 unit/PGlite and 558/558 PG**. This includes schema validation/generation, typecheck, API build/smoke, PG17, drift and whitespace; these remain implementer verification evidence. The dependency-classification supplement records offline production installation/import, typecheck, 217 unit tests and six maintenance PG tests on the final package, with unchanged dependency versions/source. The recorded Opus repair and packaging receipts retain the same session `02752ee0-ea51-4249-b089-d6aba4205d5d`, requested/observed `claude-opus-5-5`, high, native Anthropic subscription. No full unchanged suite was redundantly rerun by this reviewer.

**Residual qualifications and stopping point**

PostgreSQL can defer interrupts briefly at its atomic commit point, and a lost COMMIT acknowledgement can leave an unknown outcome. These qualifications do not cover a query still waiting on a catalog lock 3.5 seconds after the explicit deadline. There is no automatic retry. Existing per-read audit cost, workspace-fence blocking, retention cap and constructed-deadlock qualifications remain. MOCK evidence does not establish vendor/accounting semantics or production readiness.

Return RC3-F1 and RC3-F2 to the original cohesive Opus session. A repaired cancellation artifact requires renewed fresh explicit Astra/xhigh review and exact identity verification. Do not self-seal, advance dependent work, deploy or infer LIVE authorization from this report.
