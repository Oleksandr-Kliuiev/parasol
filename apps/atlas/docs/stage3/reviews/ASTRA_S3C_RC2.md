# S3-C RC2 independent acceptance re-review

**Verdict: APPROVED for the exact S3-C RC2 MOCK artifact identified below.** RC1 findings R1, R2 and R3 are closed. No required finding remains from this bounded re-review or the adjacent invariants examined. This does not approve LIVE, a vendor adapter or operational deployment.

Reviewer: the same explicitly assigned native **gpt-6-astra** reviewer as RC1, retaining effective **xhigh** effort. This was a bounded re-review of the three findings against a newly frozen artifact, not a lower-effort session or implementer self-acceptance. Review completed **2026-10-09 07:26:59 UTC**. No fallback reviewer/model was used.

## Accepted identity

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch `planning/stage2-m365`.
- Manifest: `verification/stage3/S3C_RC2_MANIFEST.json`, SHA-256 `c676b68e5e300641fec3d9bef8fbfc7f363c3938dc32bdb2842e46ff24afa186`.
- **Source package hash:** `212005fd24b4f23a810ccc9afb2f3213ff7f67ae50f226ac51e8b3b0379e521b`.
- Working inventory hash: `f727b0413209ee089c6fa8820c4cd09173c181a2a9d55405f3aba4f08bf4d15a`.
- Source ZIP: `/tmp/atlas-stage3/S3C_RC2_SOURCE.zip`, SHA-256 `1633a93d6c9262abf813debed54b13dd146de1d456860effd060f4995744fac7`.
- Reviewed predecessor: RC1 package `99529a43db18f4087dca4afabc1d7352ed1fcf3569c96e5435d9a5aa6c372485`; preserved RC1 report SHA-256 `ca644cf8f35ba158ffafe0feaa06f9c166d47a052bbb2902fbc0a4a63a873481`.
- Dependencies remain the approved Stage 3 RC4 architecture package `e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c` and accepted S3-B RC2 package `fd70db2d87c512a5d9c878d61cf77a71b3456d1000b06ced5a4ea2d4cf1c01ec`.

Independently recomputed the source and working-inventory hashes; checked every one of **608 source ZIP entries** and **641 inventoried working files**. Compared all RC1 inventory entries: exactly **15 changed / 6 added / 0 removed**, matching `previousReviewedArtifact.delta`. No schema, role, migration, authority, reservation or guard change is present. Files outside the declared delta remain byte-exact, including the prior normative architecture and evidence. The 33 historical ZIP exclusions remain covered by matching working-inventory hashes. Rechecked the inventory, manifest, archive, HEAD and branch after all probes: unchanged. The RC2 manifest itself is the sole non-ignored extra outside its own inventory.

## Finding closure

### R1 — Closed: cancellation and original deadline

`packages/actions/mock-port.ts:37–68` receives the signal together with the original monotonic deadline. Pool admission and transaction options are bounded; remaining time is recalculated after pool acquisition and applied as a transaction-local PostgreSQL `statement_timeout`. Signal/deadline checks before database work and after the statement prevent committing work whose cancellation is already known. `execution.ts` passes its original 15-second instant; `verification.ts` passes the claim's already anchored read deadline. Neither retries a port call.

Independently repeated my original RC1 reproduction using the actual RC2 built-in port: one runtime Prisma connection held for 3 seconds, a separate table SHARE lock held until 16 seconds, and the call's signal/deadline at 15 seconds. RC1 committed at 16.017 seconds; RC2 produced:

```json
{"outcome":"ACTION_OUTCOME_UNKNOWN","settledMs":15031,"signalAborted":true,"committedSyntheticRowsAfterUnlock":0,"poolHoldPassed":true}
```

The independently run new PostgreSQL tests also passed abort during pool wait for create/read, blocked INSERT and SELECT, early abort followed by lock release, a successful call within the remaining window, and the complete dispatch path with exactly one create and UNKNOWN rather than NOT_DISPATCHED. Existing late-result, separately authorized initial-read and recovery tests passed.

The implementation does not promise instantaneous interruption for an early manual abort while Prisma is awaiting blocked SQL. SQL remains bounded by the original deadline and an abort observed before commit rolls the transaction back. Setup/driver/scheduling latency can make promise settlement slightly later than the nominal instant; the absolute post-statement guard prevents that latency from authorizing a new commit. The race after the final guard while COMMIT is already in flight remains the designed possible-effect case. These limits do not reproduce R1's preventable post-deadline commit and do not warrant a new finding.

### R2 — Closed: durable fact receipts and duplicate audits

`packages/actions/publication.ts` derives an audit primary key from a domain-separated canonical fact using HMAC-SHA256 keyed by immutable private capability material, retaining 122 digest bits in a UUIDv8 layout. Conflict and stale paths check for that committed receipt under the existing request → attempt → ordinal lock order. The first observation and its receipt are one atomic audit insert; identical replays add no audit. Distinct facts retain distinct receipts, and a rollback leaves no receipt.

Independently exercised simultaneous replays on real PostgreSQL with an owned dispatch and a legitimate candidate claim abandoned by a differing late original:

```json
{"createEffects":{"CONFLICT":1,"IDENTICAL":7},"staleCount":8,"conflictAudits":1,"staleAudits":1,"receiptIdsUuidV8":true,"distinctReceiptIds":2,"requestState":"CREATED_UNVERIFIED","verificationCount":1}
```

The new replay tests independently passed sequential and new-client replay, distinct conflicts/stale outcomes, successful-read replay, audit rollback, two known rollbacks followed by success, exhaustion at three attempts, and forged immutable identity rejection. Existing same-fact retry and publication/admission lock-order checks also passed. The retry limit and absence of port retries are unchanged; the RC1 independent organic deadlock evidence continues to apply to that unchanged retry machinery.

Privacy assessment: the externally readable audit ID is an opaque keyed PRF output, not a ticket ID, token, nonce, secret reference or an unkeyed digest supporting a candidate-ID dictionary test. The random capability keys remain private, canonical fact input remains in the trusted process, and no private fields were added to audit metadata. The existing scoped append-only audit table provides durable storage; runtime and cleanup privileges were not expanded. Receipt lookup happens only after the existing owned-identity checks and introduces no new authority. The ordinary negligible collision assumption of a 122-bit identifier remains; no new user-controlled collision path was found.

Audit retention is relevant to this implementation: receipts depend on their audit rows remaining present. Current audit mutation/truncate guards and grants preserve that condition, and no retention change belongs to this checkpoint. A future retention design must preserve equivalent replay protection. This is a future dependency, not a defect in the approved MOCK slice.

### R3 — Closed: synthetic marker on CLI errors

`packages/ops/actions.ts:88–98` includes `synthetic: true` for invalid arguments, missing runtime database configuration and the common success envelope; the existing failure envelope already includes it. The new unit test reproduces both prior omissions. The actual CLI-process tests now check the marker on every parsed response, including the two error branches. All passed without printing private input or bearer material.

## Independent verification

Command, run against disposable PostgreSQL through the existing private environment wrapper:

```sh
source /tmp/atlas-stage3/claude-tools/pgenv.sh
node --experimental-strip-types --test \
  tests/pg/action-port-cancel.pg.test.ts tests/pg/action-replay.pg.test.ts \
  tests/pg/action-execute.pg.test.ts tests/pg/action-verify.pg.test.ts \
  tests/pg/action-late.pg.test.ts tests/pg/action-recovery.pg.test.ts \
  tests/pg/action-cli.pg.test.ts tests/pg/action-upgrade-s3c.pg.test.ts \
  tests/pg/action-exec-nonsuper.pg.test.ts tests/action-cli.test.ts
```

**Exit 0: 35 passed, 0 failed, 0 skipped** — 31 PostgreSQL and 4 unit tests, approximately **40.865 seconds**. The two additional independent probes above also exited 0 on PostgreSQL **17.11**. All reviewer-created databases, roles and temporary private fixtures were cleaned. Final checks found **0 disposable test databases and 0 matching test roles**.

Narrowly inspected the final implementation evidence and `/tmp/atlas-stage3/s3c-checks/rc2/run1` summaries: all ten required commands plus untracked-whitespace checking recorded exit 0; logs confirm **181 unit/PGlite** and **401 PostgreSQL** passing tests, no failures/skips, plus PG17, schema drift and API smoke PASS. These broad runs were implementer evidence, not mislabeled as independent reruns. The reported negative controls used RC1 implementations and are not RC2 product failures. No generator or build was run by this reviewer.

## Acceptance boundary

The fixes implement the already approved cancellation, replay and output contracts. They introduce no new user capability, public action endpoint, authorization rule, schema, role grant, migration or LIVE transport. Existing opaque permit/claim ownership, one lifetime create, fresh authority for new reads/recovery, exact binding/matching, three consumed ordinals, stale-result handling, outcome preservation and audit atomicity retain supporting source and independent regression evidence.

Exact equal-instant timing is not deterministically scheduled; conservative clocks and comparisons were inspected. Existing trusted in-process port injection remains outside operator controls. No persistent/pilot database, account, vendor or LIVE action was accessed. The checkout remained read-only, and no status or acceptance file was edited by this reviewer. **S3-LIVE and S2-LIVE remain deferred.** Approval applies to this exact RC2 artifact and the recorded MOCK scope only.
