# S3-C RC1 independent acceptance review

**Verdict: CHANGES_REQUIRED.** Three required findings remain. This does not accept S3-C or authorize dependent work or LIVE.

Reviewer: fresh native Codex reviewer explicitly assigned **gpt-6-astra / xhigh**; effective effort **xhigh**. No other S3-C reviewer verdict was supplied to the initial review. No external reviewer or fallback model was used for this assessment. Review completed 2026-10-09 UTC. The checkout was read-only throughout; only this report was written as a deliverable. Tests/probes used disposable PostgreSQL databases, roles and temporary synthetic fixture files, subsequently removed.

## Exact artifact and preservation

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch `planning/stage2-m365`. Review used the declared S3-C baseline delta, not the much larger dirty diff against HEAD.
- Manifest: `verification/stage3/S3C_RC1_MANIFEST.json`, SHA-256 `77d0e62ad00a6c28c9c77b4f78127b5f4fd29a9f45b80ba52b47849adbe5df8c`.
- Source package hash: `99529a43db18f4087dca4afabc1d7352ed1fcf3569c96e5435d9a5aa6c372485`.
- Working inventory hash: `94781a259bd2808f9c9768aee65e633751a4e628f5d1f0ac446565d91bbf0ee0`.
- Source ZIP: `/tmp/atlas-stage3/S3C_RC1_SOURCE.zip`, SHA-256 `bef94903f83612b806daa46c86b719090fdfcd96131f73686d6010e110ac37f1`.
- Baseline: `verification/stage3/S3C_BASELINE.json`, SHA-256 `404634032167c5e7e82dc80480c563cf1b345f088845a827ba4ba7128b7c404a`.
- Dependencies: approved Stage 3 RC4 architecture package `e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c`; accepted S3-B RC2 package `fd70db2d87c512a5d9c878d61cf77a71b3456d1000b06ced5a4ea2d4cf1c01ec`.

Independently recomputed both inventory hashes; verified all 602 ZIP entries against the manifest and all 635 working-inventory files against their hashes. The 33 historical ZIPs excluded from the source archive remain present with matching inventory hashes. Independently compared all baseline entries: exactly **18 changed / 22 added / 0 removed**, matching the declared delta. The manifest itself is the only non-ignored extra outside its own working inventory. Rechecked current inventory, manifest and ZIP after the probes: no changes. This preserves baseline files outside the declared delta, including frozen architecture, migrations and earlier evidence.

## Required findings

### R1 — P1: built-in port does not honor an in-flight AbortSignal

**Location:** `packages/actions/mock-port.ts:34`, `:40–50`, `:53–61`.

Both methods check `signal.aborted` only on entry. They neither observe later aborts nor bind the database work to the invocation's remaining deadline. The database transaction allows a separate 10-second pool wait followed by a new 15-second transaction window. The outer dispatch timeout does not cancel that work. Consequently the built-in create can commit a new effect after its actual 15-second signal has fired; this is more than a late response to an already committed effect.

**Independent reproduction:** PostgreSQL 17.11; real built-in `mockActionPorts`, confined runtime, a one-connection Prisma pool. Hold that pool connection for 3 seconds, and hold a separate `SHARE` table lock on `ActionMockTicket` until 16 seconds after `createOne` starts. Abort the supplied signal at 15 seconds. The create acquires the pool after 3 seconds, waits on INSERT, and then commits when the table lock is released, still inside its separate transaction timeout. Observed:

```json
{"outcome":"RESOLVED","elapsedMs":16017,"signalAborted":true,"committedSyntheticRows":1,"poolHoldPassed":true}
```

The same entry-only signal handling is present in `readOne`. Existing deadline tests wrap the port with a test implementation that listens for abort, so they do not establish that the built-in implementation honors it.

**Required correction and acceptance:** enforce the invocation's abort/deadline across pool acquisition and database work for both methods, without starting a fresh full timeout after waiting. Add real built-in-port tests for abort during pool wait and blocked SQL, including the 15-second create deadline. Work that has not committed must stop/roll back when cancellation can still prevent the effect. Preserve the designed UNKNOWN and owned late-fact handling for genuinely ambiguous commit/response races; do not classify possible invocation as NOT_DISPATCHED or introduce a port retry. Required by `04_EXECUTION_AND_PORT` and C2/C5.

### R2 — P2: identical conflict and stale publications duplicate audit effects

**Location:** `packages/actions/publication.ts:101–103`, `:121–123`, `:166–172`.

Successful create/read facts have no-op replay paths, but conflict and stale facts do not retain a stable committed fact identity. Repeating the same conflicting create result always inserts another `action.create_result_conflict`; repeating the same abandoned claim's result always inserts another `action.verification_stale`. The approved rule applies to all fact publication: an identical committed publication is a no-op with no duplicate audit.

**Independent reproductions:**

1. Publish an original create ID, then publish the exact same differing create fact twice using the original dispatch identity. Observed **2 conflict audits**.
2. Publish UNKNOWN, admit a candidate claim, capture its own exact private identity, then publish a differing late original to abandon the claim. Publish the same candidate MISMATCH fact twice with that identity. Observed results **STALE / STALE**, **2 stale audits**, ordinal still ABANDONED and request still CREATED_UNVERIFIED. No replacement claim or changed token/outcome was needed.

Stored outcomes are preserved; the defect is the duplicated audit effect and missing all-facts replay guarantee.

**Required correction and acceptance:** make an already committed identical conflict/stale fact a no-op, while retaining a safe audit for the first observation. Preserve lock order, atomicity, immutable identities, audit privacy, distinct-fact handling and the three-attempt known-rollback bound. Cover both reproductions and duplicate successful facts, including audit rollback and retry. Required by `04_EXECUTION_AND_PORT` “Late create results and candidate ordering” and C5/C6.

### R3 — P2: two action CLI error envelopes omit the synthetic marker

**Location:** `packages/ops/actions.ts:88`, `:92`.

The invalid-arguments branch and missing-runtime-database branch return exit 2 without `synthetic: true`, unlike the normal success and failure envelopes. The approved public output contract and C1/C7 require the synthetic marker on every action response.

**Independent reproduction:** invoke `runActionCli(['action-get'], {})`; then invoke a syntactically valid `action-get` with MOCK and a validly shaped synthetic bearer but no runtime database configuration. Both return exit 2, and `Object.hasOwn(output, 'synthetic')` is false. These probes made no database call and printed no input or token.

**Required correction and acceptance:** include the fixed synthetic marker in both envelopes and cover usage/configuration failures alongside normal action responses. Keep errors fixed and private inputs out of output.

## Independent checks and evidence

The focused independent command was:

```sh
source /tmp/atlas-stage3/claude-tools/pgenv.sh
node --experimental-strip-types --test \
  tests/pg/action-execute.pg.test.ts tests/pg/action-verify.pg.test.ts \
  tests/pg/action-late.pg.test.ts tests/pg/action-recovery.pg.test.ts \
  tests/pg/action-cli.pg.test.ts tests/pg/action-upgrade-s3c.pg.test.ts \
  tests/pg/action-exec-nonsuper.pg.test.ts tests/action-cli.test.ts
```

**Exit 0: 28 passed, 0 failed, 0 skipped** (25 PostgreSQL tests plus 3 unit tests; approximately 40.226 seconds). This covered the real CLI journey, lifetime create latch, fresh read authority, matching, budget/claims/recovery, late-result orderings, audit rollback, grants/upgrades, non-superuser owner observations and network trap.

An additional independent **real two-session PostgreSQL deadlock** probe exercised `publishCreateFact`, beyond trigger-raised SQLSTATE tests. A scoped owner transaction held the attempt row; publication held the request and waited on the attempt; the holder then requested the request row. PostgreSQL aborted the publication's first transaction. The same fact retried and committed after the holder rolled back. Observed **2 publication attempt-lock queries, PUBLISHED, 1 created audit, 1 synthetic ticket**, no holder error and no additional port call. This supports the actual driver error mapping and same-fact retry behavior; the existing focused suite independently passed exhaustion at three attempts.

The first abort probe had a harness-only failure because `$queryRaw SELECT pg_sleep(3)` attempted to decode PostgreSQL `void`. It was corrected to `$executeRaw`; no product repair was made. The failed probe's one disposable database and four roles were removed before the successful reproduction. Final cleanup query found **0 disposable test databases and 0 matching test roles**.

Read the implementation evidence and narrowly verified final run2 summaries/log results: all ten required commands plus the untracked-whitespace check recorded exit 0; **180 unit/PGlite and 395 PostgreSQL** passed, no failures/skips. PG17.11, schema drift and API smoke PASS lines are present. Those broad runs were performed by the implementer, not repeated or misrepresented as independent here. No generator/build was run by this reviewer.

## Scope assessment and remaining limits

The inspected orchestration keeps admission/recovery under fence → request → approval → attempt → ordinal and fact publication under request → attempt → ordinal without acquiring earlier authority locks. Public claim/permit handles use WeakMaps and are single-use; publication's raw internal identity objects remain inside trusted in-process services. The CLI hardcodes the built-in mock port and provides no user-selected port/callback/origin path. These internal dependency-injection seams are not separate findings in this MOCK threat model. A deliberately blocking custom factory would be trusted injected code, not a presently exposed operator control.

The deadline comparisons for recovery/publication use `>=` / `<` respectively after locks; local read/start clocks are conservatively anchored before the DB clock read. Exact equal-instant scheduling was inspected, not deterministically exercised. Fresh verification/recovery authority and exact binding, revoked original signers after reservation, at-most-three lifetime reads, immutable results, safe summaries, runtime column allowlists and existing Gateway isolation otherwise have supporting source/test evidence. The three findings above limit acceptance.

No source/status/evidence file was edited, no persistent/pilot database was accessed, and no account/vendor call or LIVE action was performed. LIVE remains deferred. Re-review the corrected, newly frozen exact artifact and affected checks at effective **xhigh** before S3-C acceptance.
