# ASK-A S5ASKA-rc2 independent acceptance

**CHANGES_REQUIRED. R1, R3 and R4 are closed on this artifact; R2 is only partially closed.** The original five failures now pass, but a new actual-helper boundary probe establishes that a token SELECT can still start after terminal state. A nearby fixture async seam also appends new memory audits after terminal. ASK-B must not advance on this artifact.

Fresh native review explicitly assigned `gpt-6-astra`, effective effort `xhigh`. The named native assignment establishes runtime selection. Underlying provider response-model telemetry and attributable usage are not exposed to this reviewer; neither is claimed observed. This is actual-code acceptance, not implementation self-acceptance. No product repair, original-checkout write, API/credit use, remote inference, deployment or dependent work was performed.

## Exact reviewed identity

Repository `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch `planning/stage2-m365`, including its frozen dirty/untracked inventory.

- Package `S5ASKA-rc2`: `6bc4f1c656f7149e22422ba41d3a8cc495fc22ebb902f8104f8b8a1aad788115`.
- Manifest `verification/stage5/S5ASKA_RC2_MANIFEST.json`: `486955ec76b9d9524fd28504beadb0730bf629b7b82a3f3a809b660d20dab1d4`.
- Source archive `/tmp/atlas-stage5/S5ASKA_RC2_SOURCE.zip`: `fc1f10acffae4e61fd91609a5e988dc5d5516c9216851fab3ac35ab974e82b47`.
- Review brief `/tmp/atlas-stage5/astra-s5aska-rc2/BRIEF.txt`: `03473221388af5dc14f2b797fa5b14ca0cf547681c2d362ef110d9ff56a240cc`.
- Current implementation evidence: `3d8918bfd04536183079f69ef8aad7420d028202977c9b048dedb8cb538de891`.
- Immutable six-file Ask design package: `a9e43a42655ddfea64577d9640fa5778bbf9acf2bd979abdb55e53459a4ab13a`; approved seal `90b5ad7c598f5b89a193bfd7035efe1539bc13feaf0d9338d7fc7b49425e2c15`.

Before and after assessment, the verifier confirms the exact current path set, 1113 working files, 215 built files and 1054 archive members. I inspected the verifier and independently checked unique/sorted/safe manifest paths, archive-to-working hash correspondence, computed baseline delta (11 changed, 48 added, 0 removed), all extracted bytes, and all rebuilt bytes. The isolated build reproduces all 215 files. All 33 operator built files and 82 protected operator/browser/schema/dependency source files match the pre-ASK-A baseline. No original source, build or dependency was modified.

## Required findings: R2 remains open

**R2a — [P1] The reused token helper still starts SQL after terminal at an internal await.** Relevant new caller: `packages/ask/authority.ts:147`; the same pattern occurs at lines 108, 115 and 122. `packages/ask/phase.ts:48` wraps `currentToken` as one statement, while accepted `packages/auth/transaction-token.ts:19–23` performs three separately awaited SQL calls. The runner checks only before and after the whole helper. If disconnect/terminal state occurs during the initial digest-setting await, the helper proceeds to its ApiToken SELECT without consulting the run or phase.

Independent reproduction on confined PostgreSQL 17.11 uses current unmodified product bytes and a transaction-client response-delivery seam: execute the digest-setting SQL normally, hold only its successful await return, mark the run terminal, then release the return while ApiToken is independently locked. The next SELECT physically reaches PostgreSQL and waits on that lock: `tokenSelectAfterTerminal:1`, `physicallyBlockedAfterTerminal:true`, `heldOwners:1`. Releasing the lock produces `AskStopped` and exactly one owner release. This is a real SQL observation with an injected delivery delay, not a claim that `set_config` itself waits on a table lock, nor an observed ordinary HTTP timing race. It demonstrates the missing guard at an actual helper await. Necessary token-setting cleanup alone would not be this finding; the new SELECT is authentication work.

Required closure: keep accepted shared authentication semantics/visibility intact and ensure every actual statement made by the reused helper passes Ask's run/absolute-phase boundary before it starts and after awaited work returns. Re-bound statement timeouts at actual statement boundaries. Necessary rollback/cleanup must still drain under the same owner. Apply to private authentication and all fenced/final token checks, without silently relaxing the normative rule or widening shared auth. Add the delayed digest-setting-return regression (terminal and original/phase deadline variants) and require zero new token SELECTs, no subsequent actor/source/charge/audit/phase, and exactly-once physical drain. The fact that `set_config` has no table lock does not remove its asynchronous delivery boundary. Basis: 03 before/after-await and no-new-work rules; original R2 closure; Q6.

Evidence: `source/review-token-boundary.test.ts`, `independent-token-boundary.log` (**0/1 pass; concrete assertion failure**).

**R2b — [P2] Fixture denial/finalization appends a new memory audit after an unchecked demo await.** `packages/ask/fixture.ts:93` and `:113` check the run before `await options.demo()` but append immediately afterward. A deferred-demo port probe starts denial/finalization, ends the run while the demo promise is pending, then resolves it. Denial appends one `ask.scope_denied`; publish appends one completion audit and returns success. The outer service can suppress delivery afterward, but cannot undo the new append.

This is classified as **required closure of R2**, under 03's universal after-await/no-new-audit rule and Q6, including the fixture path. Its evidence is an injected asynchronous demo dependency, not a reproduction of normal fixture HTTP scheduling; the production demo usually settles before requests. No DB authority violation or delivered late answer is claimed. Required closure: retrieve the demo, then check terminal/original deadline before either append; review the neighboring admission await before charging/starting source work. Add deferred-demo denial and completion regressions that require no append after terminal/deadline while preserving normal fixture audits and owner settlement.

Evidence: `source/review-fixture-boundary.test.ts`, `independent-fixture-boundary.log` (**0/2 pass**, observed denial count 1 and completion count 1 instead of 0).

## Closure of the original failures

| Finding | Independent result |
|---|---|
| R1 whole-private-phase deadline/owner | Closed for the reported sequential-lock failure. Original ApiToken→Actor probe now fails publicly with ASK_DEADLINE at 2003 ms, with no remaining Actor wait at 2.2 s. Current real-PG auth/admit/publish barriers independently report public failure at 2001/2002/2002 ms; owner release at 2009/2011/2013 ms, after sampled runtime work drains. Final-audit FK wait rolls back the row; exactly-once recovery passes. The original 8 s deadline remains unchanged. Internal-helper no-new-work coverage is the remaining R2a finding. |
| R2 Observation→Entity after disconnect | The original reproduction is fixed: `newEntityRead:false`. Packaged HTTP/PG Observation→Entity, ApiToken→Actor and phase2-fence→audit barriers pass; no extra admission/audit and exactly-once drain. This does not close the distinct internal awaits above. |
| R3 whole original snapshots | Closed. Original UNAVAILABLE malformed snapshot gives 503 ASK_SOURCE_INVALID and zero audits; 4.5 MB valid-shaped original gives 413 ASK_TOO_LARGE. Current PG regressions additionally cover PENDING and UNAVAILABLE malformed/wrong-source/oversized and valid snapshots; valid missing/null behavior and projection remain intact. Snapshot→SyncState FK prevents an unjoined orphan snapshot. No planner/completion audit on rejected source. |
| R4 undecodable client paths | Closed. Original path returns 401 without a valid credential, then 403 with a valid credential/body and exactly one workspace denial. Fixture/DB tests preserve syntax/type/size→auth→semantics→scope precedence across malformed percent spellings and synchronous HEAD/OPTIONS404. The private raw client ID, not rewritten router parameters, supplies scope. |

No premature owner release was observed. Real lock-wait tests show statement cancellation/transaction drain before release; callback/transaction promise tests cover selected driver orderings. Neither a phase timer nor promise settlement alone proves every possible engine/pool/network cleanup behavior. The owner is not released by the phase timer and remains held in the newly failing token-boundary probe.

## Independent verification and preserved evidence

All work ran in `/tmp/atlas-stage5/astra-s5aska-rc2`; PostgreSQL commands used only the silent wrapper with an explicit isolated working directory. All test databases were dropped by their completed cleanup hooks; no review process remained running at completion.

- Isolated `npm run api:build`: pass; 215/215 built hashes equal the frozen artifact, including 33/33 operator files.
- Ask unit suite: **37/37**. Current repair report's “unit 36” is stale; full total 317 is correct.
- Full unit/PGlite suite: **317/317**, including context budget. Logs `independent-all-units-3.log` and `independent-ask-units.log`.
- Actual confined PostgreSQL Ask suite: **41/41** on PostgreSQL 17.11. `independent-ask-pg.log`. Reviewed Q1–Q6/Q9 and backend Q8 paths: parser/DTO/default OFF, provisional+actor ownership/rate, two shared-fence phases/captured identity+epoch, post-audit expiry/deadline rollback, unknown commit fail-closed handling, source/coverage/focus eligibility, exact compiler matrix/independent urgency, privacy and no business/action writes. The new R2 findings qualify otherwise-green coverage.
- Exact unchanged original rc1 hostile probe: **5/5**, `independent-original-hostile-2.log`. File copied byte-for-byte to `source/review-hostile.test.ts`.
- New independent helper probes: token boundary **1 failure**, fixture boundaries **2 failures**, described above; no product repair attempted.
- Independent negative control removes only the phase run-terminal check in the isolated copy, rebuilds and runs the original disconnect reproduction. It fails with `newEntityRead:true` and an assertion (not merely a harness timeout). Source restored to SHA256 `48d9d9281cd44c88f744a75b92bbd59ccb238319e293e93319fb7008bb1bc7fd`; rebuild succeeds and all 1054 package/215 built files again match. See `independent-negative.py`, `independent-negative-run.log`, `independent-negative-restoration.json`, `restored-artifact-verification.json`.
- Independently verified hashes/lengths of **56** durable supplemental files, all **14** bound implementer check logs, and final summaries **317/317 unit, 610/610 PG, 50 browser**. These are inspected implementer evidence, not a claim that I reran the whole 610-PG/50-browser suite. Existing repair negative controls have concrete failures, restored bytes and rebuilt outputs; initial non-compiling R3 mutation is correctly kept as failed setup rather than successful mutation proof.
- Fresh implementer production-copy proof is credible and hash-bound: clean npm ci/generate/build/prune, foreign-cwd OFF/MOCK fixture serve, Gateway201, capability/question200, Host421, CSP/no-store, 32/32 served assets and manifest unchanged. I read the scripts/results and reproduced the frozen build, but did not repeat that clean-install/prune sequence. Pre-existing TypeScript/Prisma peer retention is explicitly documented.

Review harness failures remain preserved: first hostile attempt used the wrapper's default cwd and could not locate the probe (no product test executed); rerun explicitly selected scratch. First full-unit attempt lacked a .git marker, so a pre-existing protected-file test created its synthetic canary and failed. Initializing the scratch Git marker fixed that contract; a second run exposed the leftover canary; after diagnosing and moving that reviewer-created canary to `unit-harness-canary.json`, the final suite passed 317/317. No original checkout mutation occurred and no product defect is inferred from those setup failures.

`EVIDENCE_INVENTORY.json` lists hashes and absolute/relative paths of every direct review log/receipt/script and all three generated/copied probes under `source/`; preserve it with this report, excluding dependencies and the generated application copy.

## Residual qualifications

OFF/MOCK only, synthetic fixture authority and disposable PG. No external inference, real tenant/vendor, deployment, new UI or ASK-B evidence. Per-process quota and ignored-abort retention remain intentional limits. Existing documented post-compilation oversized-answer 413 with `ask.failed/ASK_TOO_LARGE`, display marker, phase1 freshness clock, ENTITY descriptor enums and generic-parser logging qualifications are unchanged; this review creates no silent norm amendment. Source/bank/answer validation and accepted console/schema/dependency preservation showed no additional required finding. Acceptance stays pending the concrete R2 closures and renewed review of the repaired exact artifact.
