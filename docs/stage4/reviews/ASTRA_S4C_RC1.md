# S4-C S4C-rc1 independent acceptance

**Verdict: CHANGES_REQUIRED.** Two required C3 findings remain: the runner can commit cleanup after its original ten-second deadline, and an acquisition timeout is misclassified as readiness failure. Do not advance dependent work or seal S4-C as accepted. The 44 focused tests pass but do not cover these failures.

Review date: 2026-10-10. Scope: unchanged dual-approved MOCK S4-C C1–C4 and relevant R1/R2. LIVE remains DEFERRED_BY_OWNER. This review performed no vendor/account/production operation, deployment, repository edit, build or generator. All database probes used disposable PG17 databases and unique roles through the approved silent wrapper; credentials and raw database errors were not printed. No other current-checkpoint reviewer verdict was consulted.

Reviewer assignment: native `gpt-6-astra`, explicit `xhigh`, fresh independent session, as externally assigned by the orchestrator. The native assignment is external identity evidence; this report's self-description is not response-model telemetry. Independent provider response-model telemetry and attributable quota usage are unavailable. No fallback model, billing route or credits were enabled by this review.

## Exact artifact and preservation

- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`, plus the exact working inventory, not HEAD alone.
- Manifest: `verification/stage4/S4C_RC1_MANIFEST.json`, SHA-256 `a6826075655a54d088672f0577d140a7f0844db79c9b041c408def0058bf3c52`.
- Package hash: `6fec6be8f845f1f46be4201df65d1a8c7d95452bcdc5d19876a5a61485faee9a`.
- Working inventory hash: `2048ea710b092b7cb898a28c3e7d376ac51b529ddfe114064bcfa354946244c8`.
- Source ZIP: `/tmp/atlas-stage4/S4C_RC1_SOURCE.zip`, SHA-256 `86abb90f936ab5c3d8a191f0cee39c8aae750cc7b2e729259793650fd1c326de`. The repository `S4C_RC1_PACKAGE.zip` is byte-identical.
- Architecture package: `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`; all eight normative files independently verified against its manifest.
- S4-B dependency seal SHA-256: `bf0c92fa0ad30a28b4e522b4f9fd6ee4472330c8be9db48f0b55d8dd3792b697`. Its referenced manifest/archive hashes and the design seal's referenced manifest/archive hashes also verified.

Before and after review, all 843 working entries and all 800 ZIP entries matched the frozen manifest and digest rules. Baseline comparison found exactly the declared eight changed and 22 added files, with 813 baseline files unchanged and none removed. Final git inventory contains no undeclared source files; the manifest and its byte-verified package ZIP are the two self-packaging exclusions. The initial extra-file assertion expected only the manifest and was corrected after independently verifying the package ZIP's identical hash; no source drift occurred. The unchanged inventory preserves the recorded 11 Stage2, eight Stage3 and eight Stage4 norms, 24 accepted migration artifacts and 362 prior checkpoint/fixture artifacts. Earlier seals/history remain unchanged.

Evidence: `/tmp/atlas-stage4/astra-s4c-rc1/identity-before.json`, `identity-after.json`, and rerunnable `verify-identity.py`.

## Required findings

### R1 — P1: cleanup can commit after the original ten-second deadline

Location: `packages/poweroffice/maintenance.ts:132`, `:140`, `:143`, `:145` (especially the last budget check and transaction options).

`budget` is captured before acquisition and passed unchanged as Prisma's interactive-transaction timeout, which starts after acquisition. The SQL statement timeout is refreshed before calling the cleanup routine but is not refreshed for COMMIT. The post-routine check only proves that the deadline has not passed when the callback returns. COMMIT then inherits the old, larger statement timeout and the acquisition-shifted Prisma timeout. There is no original-deadline cancellation covering that interval.

Independent actual-PG17 reproduction on the unchanged production code:

1. Publish a synthetic snapshot and age it 25 hours using the accepted trusted fixture.
2. Delay this disposable runner's login by four seconds through a PUBLIC-revoked DB-local login event trigger.
3. Delay the cleanup audit inside the routine by four seconds through a DB-local BEFORE audit trigger.
4. Delay COMMIT by four seconds through a DB-local, PUBLIC-revoked deferred audit constraint trigger; this trigger applies only to `poweroffice.cleanup`.
5. Call the real `admitPowerOfficeCleanup` / `runPowerOfficeCleanup`, then observe committed rows independently.

Observed: `COMPLETED` at **12,120 ms**, snapshot count **1 → 0**, current pointer cleared. Thus deletion and pointer withdrawal committed after the original ten seconds. This is a real transaction/COMMIT probe with no fake client or synthetic thrown timeout. The deferred trigger is only a deterministic test fixture for COMMIT latency, not a claim that this trigger exists in the shipped schema. All test objects were removed in `finally` and the database/roles dropped.

The implementation report's “sub-millisecond window” does not describe this failure: the budget can be extended by seconds. The existing four-second-login plus long-routine test establishes that pool time reduces the routine's statement timeout, but does not exercise COMMIT using that stale timeout.

Required closure: enforce the original remaining budget through COMMIT and actual transaction cancellation, including acquisition and all intervening awaits. Returning a timeout via `Promise.race` while the database can still commit is insufficient. Add a real PG regression for acquisition + routine + commit delays whose sum exceeds ten seconds, require `POWEROFFICE_CLEANUP_TIMEOUT`, and independently prove complete rollback of pointer, snapshots/attempts and cleanup audit, including after the delayed work would have finished. Preserve confined runner privileges, immutable pairing, single-use admission, one-second lock timeout, fixed outcomes and no automatic retry. Demonstrate the positive cleanup path and existing lock/audit/deadlock cases still pass.

### R2 — P2: a runner acquisition timeout becomes RUNTIME_NOT_READY

Location: `packages/poweroffice/maintenance.ts:90–102`.

`timeoutState` checks `error.code` for P2024 but not `PrismaClientInitializationError.errorCode`. A real delayed runner login/acquisition exhausts Prisma's pool wait with `{name:"PrismaClientInitializationError", errorCode:"P2024"}`. The blanket initialization branch therefore maps this timeout to `POWEROFFICE_RUNTIME_NOT_READY`. The CLI consequently treats it as configuration exit 2 instead of operation-timeout exit 1.

Independent wrapper probe: 15-second runner-only login delay, both paired URLs carrying `connect_timeout=30`, original ten-second runner budget. The wrapper returned **POWEROFFICE_RUNTIME_NOT_READY after 10,012 ms**, with domain rows unchanged. A separate minimal Prisma probe, using the same actual login delay and transaction options, exposed only safe structured metadata: `name=PrismaClientInitializationError`, `code=null`, `errorCode=P2024`, elapsed **10,011 ms** on PostgreSQL **17.11**. No message, URL or credential was emitted.

Required closure: distinguish structured acquisition/initialization timeout codes from authentication/configuration failures without parsing or echoing private messages. A real pool/login timeout must map to CLEANUP_TIMEOUT and CLI operation failure; wrong password, role or database pairing must remain RUNTIME_NOT_READY. Add actual-PG timeout coverage and prove no later routine call, commit or audit occurs after cancellation.

Reproductions and outputs for R1/R2: `/tmp/atlas-stage4/astra-s4c-rc1/budget-probes.mjs`, `budget-probes.log`, `login-metadata.mjs`, `login-metadata.log`. Reproduce from the repository with the silent wrapper and `node --experimental-strip-types <absolute-script-path>`; scripts use disposable databases and clean up. Both script commands exited 0 because they record observed behavior; the observations above violate the acceptance contract.

## Independent verification and assessed behavior

Executed against the frozen source, without rebuilding:

`/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test tests/poweroffice-read.test.ts tests/pg/poweroffice-read.pg.test.ts tests/pg/poweroffice-read-auth.pg.test.ts tests/pg/poweroffice-api.pg.test.ts tests/pg/poweroffice-maintenance.pg.test.ts tests/pg/poweroffice-cleanup-budget.pg.test.ts tests/pg/poweroffice-cli.pg.test.ts tests/pg/poweroffice-fence.pg.test.ts`

Result: **44/44 passed** (five unit, 39 actual PostgreSQL), zero failed/cancelled/skipped, 32.945 seconds. Log: `/tmp/atlas-stage4/astra-s4c-rc1/focused-tests.log`. API tests use the already-built artifact supplied with checkpoint evidence; this review did not rebuild it. `git diff --check` passed. The two behavioral probes and the structured-metadata probe above are additional independent evidence, not included in 44.

Read code and tests substantiate the all-of single-membership gate, last-State-lock token-expiry recheck, one workspace denial, failed audit rollback, no State initialization, binding refusal before Snapshot selection, DB-clock expiry and first-match precedence. Dedicated DTOs rebuild their fields and status reads do not select financial payload. API routes bypass legacy Actor/Gateway dispatch, return no-store and synthetic envelopes for exercised paths, and cover each precedence row. Actual CLI journeys, strict argument handling, Gateway exclusion, privacy captures and positive network-trap controls passed.

Maintenance admission is private and single-use, checks current maintain authority, and pairs the runner to the runtime's actual URL and observed database/routine/role facts. Actual confinement, wrong-target/role/password cases, ACTIVE BUSY, missing-State no-op, disabled-source purge, sibling isolation, the 1000 deletion bound, morePending, retained sequence/history, audit failure and lock timeout passed. No additional required finding was established in these areas. Acceptance remains blocked by R1/R2 rather than overridden by these passing checks.

The implementer's eleven required checks are separate evidence. I inspected their recorded outcomes and bounded log summaries: all exit 0; 213/213 unit/PGlite, 549/549 PG17, schema validation/generation, typecheck, API build/smoke, version, drift and whitespace checks. No broad suite was rerun merely to repeat unchanged evidence. Existing Stage1/2/3 regression and accepted S4-A/B schema/role coverage are supported by that full run and byte-preserved dependencies, not newly claimed as independent review runs.

## Qualifications and residual risks

- The cleanup deadlock tests construct a State/fence cycle with a real Connection UPDATE and exercise both PostgreSQL victims. They are valid conflict/rollback evidence, not proof of a natural FK cycle in cleanup. The cleanup routine inserts no PowerOffice row and takes no Connection KEY SHARE lock; natural orderings are covered separately. Its bounded DB-local disposable-runner `deadlock_timeout` setting is not shared ACL tampering and is reset/dropped.
- The existing four-second-login positive control is valid, and the less-than-13-second assertion distinguishes its tested routine timeout from a reset window of at least 14 seconds. Neither establishes COMMIT coverage; R1 supplies the missing counterexample.
- The network preload and process captures support the exercised MOCK paths. They do not establish live transport or accounting correctness. No production operational readiness follows.
- Existing documented per-read audit writes, workspace-fence blocking and retained-attempt cap remain operational limitations. They do not justify extending the required cleanup deadline.

Return both findings to the original cohesive Opus session for fixes. Re-freeze the corrected artifact and obtain explicit Astra/xhigh acceptance of the critical deadline/cancellation changes and nearby regressions before dependent work. This report does not amend the approved architecture or grant LIVE access.
