# S4-C S4C-rc2 independent acceptance

**Verdict: CHANGES_REQUIRED.** A required P1 deadline finding remains: cleanup can still commit after the original ten seconds when the runner inherits a nonzero PostgreSQL `transaction_timeout`. R2 acquisition-timeout classification is closed. Do not seal or advance dependent work on this artifact.

Review date: 2026-10-10. Scope: actual code and evidence for MOCK S4-C C1–C4, including the critical R1/R2 repairs and nearby regressions. LIVE remains DEFERRED_BY_OWNER. This fresh reviewer was explicitly assigned native `gpt-6-astra` with effective **xhigh** effort. Native assignment is external identity evidence; this report's self-description is not response-model telemetry. Independent provider response-model telemetry and attributable subscription usage are unavailable. No fallback, API billing route or credits were enabled.

This review made no repository changes, builds, generators, deployment, vendor/account or production operations. Database checks used only the approved silent wrapper, disposable PG17 databases and unique roles. No credentials, URLs or raw errors were printed. No other current-artifact verdict was consulted; the RC1 report was read only as prior repair requirements.

## Exact identity and preservation

- HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, plus the exact dirty working inventory.
- Manifest `verification/stage4/S4C_RC2_MANIFEST.json`, SHA-256 `9f73345345adf45fd7a5ab0a11053178cf81a68bb9900d62b57705a1d033cd64`.
- Package hash `21f0872e28409a5e29674b41d6f41da6b76ea4783a8d3a4cfee37381b9cf3cd1`.
- Working inventory hash `0d435382b8caeda59c01e5c5a370b435f42fe93d6cbf235250f2977d7c53f77a`.
- Source ZIP `/tmp/atlas-stage4/S4C_RC2_SOURCE.zip`, SHA-256 `953f6c08973176cbb60306873e000f21b667fb51f6c103c74a4c25f157773347`; repository `S4C_RC2_PACKAGE.zip` is byte-identical.
- S4-B accepted dependency seal SHA-256 `bf0c92fa0ad30a28b4e522b4f9fd6ee4472330c8be9db48f0b55d8dd3792b697`.
- Architecture package `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec` remains unchanged.

Before and after review, all **856 working entries** and **812 archive entries** matched their hashes and the manifest digest rules. The dependency/design seals, their referenced manifests and archives, and all eight architecture norms independently verified. No undeclared source files or removals exist; only the manifest and its verified package ZIP are self-packaging exclusions. Baseline comparison verifies eight changed, 35 added and 813 unchanged files. Exact RC1 inventory comparison verifies six changed, 13 added and 837 unchanged files; the six changed files match `previousReviewedArtifact.delta`, with no removal. The sole changed production file is `maintenance.ts`; the new production module is `runner-transaction.ts`. Admission, runner pairing/confinement, CLI, roles and migrations are unchanged from RC1.

The inventory preserves the recorded 11 Stage2, eight Stage3 and eight Stage4 normative files, 24 accepted migration artifacts and 362 prior checkpoint/fixture artifacts. Evidence: `/tmp/atlas-stage4/astra-s4c-rc2/verify-identity.py`, `identity-before.json`, `identity-after.json`.

## Required finding: R1 remains open — P1 inherited timer bypasses the deadline

Location: `packages/poweroffice/runner-transaction.ts:89–97`, especially the anchor at lines 95–96 and transaction backstop at line 109.

The first post-BEGIN statement assumes that assigning `transaction_timeout` arms a new timer. If a role/database/session/startup setting already supplies a positive value, PostgreSQL arms that timer at BEGIN. Assigning a smaller positive value inside the transaction changes the GUC but **does not replace the active timer**. The 250 ms round-trip guard cannot detect this. The pre-COMMIT check occurs before deferred COMMIT work, and Prisma's acquisition-shifted timeout plus two-second backstop permits the late commit.

This behavior follows PostgreSQL 17's `assign_transaction_timeout` implementation, which enables the timer only when none is active. [PostgreSQL 17 source](https://raw.githubusercontent.com/postgres/postgres/REL_17_STABLE/src/backend/tcop/postgres.c). The public configuration interface permits transaction timeout defaults; zero is merely the default, not an invariant guaranteed by this application. [PostgreSQL 17 timeout documentation](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-TRANSACTION-TIMEOUT).

Independent reproduction on the exact frozen RC2 production code:

1. Create the usual disposable database/roles and publish/age a synthetic snapshot using the accepted fixture.
2. Set `transaction_timeout = '30s'` only for the disposable runner in its disposable database with `ALTER ROLE … IN DATABASE … SET`; a separate connection verifies `SHOW transaction_timeout` returns `30s`.
3. Install the same PUBLIC-revoked, database-local test delays as the RC1 counterexample: four-second runner login, four-second cleanup-audit routine delay, four-second deferred cleanup-audit COMMIT delay.
4. Invoke the real private maintenance admission and runner wrapper, then observe committed state from another connection.

Observed first run: **COMPLETED at 12,125 ms**, snapshot count **1 → 0**, pointer cleared. This is committed data after the original deadline, not a late error delivery or PostgreSQL's atomic commit interrupt window. The runner still passes the unchanged confinement and same-target checks. No application code, clock override, installed migration or shared ACL was changed. The DB-scoped role setting is reset and all test objects/database/roles are removed in `finally`.

Reproducer `/tmp/atlas-stage4/astra-s4c-rc2/inherited-timeout.mjs`; first output `inherited-timeout.log`. The repeat returned COMPLETED at **12,097 ms**; after at least **14,097 ms**, independent observation still found zero snapshots, the cleared pointer, **one committed cleanup audit**, and zero working runner backends (`inherited-timeout-delayed.log`). These scripts record outcomes and exit zero; zero is not acceptance of the observed behavior.

Required closure:

- Establish and verify the timer's initial state before BEGIN, or otherwise safely handle an already-active timer before any cleanup effects. Cover inherited role, database, session and connection-startup options; do not assume the PostgreSQL default or that reading back the new GUC proves the live timer was re-armed. A fail-closed configuration refusal is preferable to an unbounded transaction. If using startup configuration, its precedence, connection reuse and exact effective settings must be proven through the actual Prisma transport.
- Preserve the original monotonic budget from before acquisition across any added connection/setup work, and actual server cancellation through routine, idle gaps and COMMIT. No deadline reset, no Promise.race return while a transaction can still commit, and no automatic retry.
- Preserve full same-target URL comparison including every query option, private runtime/runner pairing, actual database identity checks, execute-only runner confinement, one-second lock timeout and single-use admission. Do not gain cancellation by granting the runner broader database authority or allowing arbitrary caller startup/SQL options.
- Add a real PG17 regression with inherited 30-second transaction timeout and the 4+4+4 second delays, including database/startup variants as applicable to the solution. Require timeout with complete pointer/snapshot/attempt/audit rollback, or explicit safe refusal before effects; independently inspect after all delayed work would have ended and prove no remaining working runner session. Retain zero/default-timeout, below-budget successful COMMIT, long acquisition, wrong password/role/target, lock/audit and both deadlock-victim controls.
- Correct the module/runbook/report claim that the first statement always arms the intended deadline. Freeze the corrected artifact and obtain a fresh explicit Astra/xhigh review because this repairs a critical cancellation invariant.

## RC1 closure assessment and independent checks

**R2 closed on this artifact.** The wrapper reads structured initialization `errorCode` as well as `code`, maps the actual P2024 acquisition timeout to CLEANUP_TIMEOUT and CLI exit 1, and preserves authentication/role/target failures as RUNTIME_NOT_READY. It never parses or echoes raw messages. The actual short-login P1001 case is covered. Its same-target-admission rationale supports treating this runner acquisition failure as operational timeout; P1001 is not universal proof of a timeout in arbitrary database code and this classification must remain confined to this paired wrapper.

**R1 partially repaired, not closed.** With default timeout settings, the unmodified RC1 reproducer now returns CLEANUP_TIMEOUT at **10,012 ms** for acquisition, with unchanged state, and **9,761 ms** for 4+4+4 second COMMIT latency, with the snapshot and pointer retained. The new independent inherited-setting counterexample above prevents acceptance.

Independently executed, without rebuilding:

```
/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test tests/poweroffice-read.test.ts tests/poweroffice-runner.test.ts tests/pg/poweroffice-read.pg.test.ts tests/pg/poweroffice-read-auth.pg.test.ts tests/pg/poweroffice-api.pg.test.ts tests/pg/poweroffice-maintenance.pg.test.ts tests/pg/poweroffice-cleanup-budget.pg.test.ts tests/pg/poweroffice-cleanup-deadline.pg.test.ts tests/pg/poweroffice-cli.pg.test.ts tests/pg/poweroffice-fence.pg.test.ts
```

**53/53 passed**: nine unit and 44 actual PostgreSQL tests, zero failed/cancelled/skipped, **76.398 seconds**. Log: `/tmp/atlas-stage4/astra-s4c-rc2/focused-tests.log`. API tests use the already-built checkpoint artifact. The five new deadline tests include delayed observation and no remaining working runner backend for their default-setting timeout cases. `git diff --check` passed. Original independent scripts were run unchanged through the same wrapper with an absolute path; output `original-budget-probes.log`. The inherited-setting probe is additional evidence, not part of 53.

Actual-code inspection and these checks support unchanged read authority/precedence, strict DTOs and safe audit-before-return behavior; HTTP no-store/synthetic/error rows and Gateway exclusion; actual CLI privacy/network controls; private single-use maintenance admission; same-target runner pairing; confinement, ACTIVE refusal, missing-State no-op, disabled purge, sibling isolation, 1000-row bound/history preservation; audit/lock rollback and both constructed deadlock victims. No additional required finding was established in C1/C2/C4 or these C3 areas.

The implementer's eleven required checks are separate evidence, not independent reviewer runs. Their structured record and bounded log summaries report all exits zero: **217/217 unit/PGlite**, **554/554 PostgreSQL**, schema validation/generation, typecheck, API build/smoke, PG17, drift and whitespace. The reported negative-control correction is properly disclosed; the first relative-path control is invalid and is not relied upon here. No broad unchanged suite was repeated.

## Residual qualifications

PostgreSQL can briefly defer interrupts at its atomic commit point; that qualification does not cover the reproduced seconds-long deferred-trigger commit. Lost commit acknowledgment can leave an unknown outcome even with a correct deadline; no automatic retry exists. The documented per-read audit write, workspace-fence blocking, attempt-retention cap and constructed deadlock-test qualification remain. MOCK network/privacy checks do not establish live transport, accounting semantics or production readiness.

Return this required finding to the original cohesive Opus session. R2 is closed, but S4-C remains unaccepted until R1 is fully repaired and the exact replacement artifact independently accepted. Architecture, pairing/confinement and LIVE gates are not weakened by this report.
