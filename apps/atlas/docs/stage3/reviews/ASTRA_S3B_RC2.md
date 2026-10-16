# S3-B RC2 bounded independent acceptance re-review

**Decision: APPROVED for the exact MOCK-only S3-B RC2 artifact below.** RC1 findings **F1 and F2 are closed; required findings remaining: 0**. The previously assessed RC1 scope is retained. This report does not implement or start S3-C, authorize LIVE work, or alter project status files.

Reviewer: native Codex subagent `astra_s3b_rc1`, explicitly assigned **`gpt-6-astra`, effective effort `xhigh`**. This is a bounded continuation of the same independent reviewer session, not a new initial review and not an effort downgrade. Review date: 2026-10-09. The coordinator retains native launch/model evidence; subscription usage attributable to this reviewer is unavailable.

## Exact accepted artifact

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`.
- Manifest: `verification/stage3/S3B_RC2_MANIFEST.json`, SHA-256 **`736dd5c725e122d9368ec2bd28a247a319a15ac7f96112d22249a728c6353958`**.
- Source package hash: **`fd70db2d87c512a5d9c878d61cf77a71b3456d1000b06ced5a4ea2d4cf1c01ec`**, **576** source files.
- Source ZIP: `/tmp/atlas-stage3/S3B_RC2_SOURCE.zip`, SHA-256 **`468911dc43f556b6543d4569bbc1a130d03b67caa5c88c05b55b19fbaacdfdbc`**. All 576 entries independently matched checkout and declared hashes.
- Full working inventory: **608** files, aggregate **`eca0cf694f9268f51d5eb2ee8496f8b2ed6075388727ee5cfb0b018fe6423ee7`**. Every entry independently matched before and after checks. Historical ZIP bytes remain omitted from the source archive while their hashes remain in the inventory.
- Previously reviewed RC1 package: `7515e441dd31c75ad652e590180c7b3befc378a241620798c6deed58eaa15877`; RC1 report SHA-256 `bed3d97a875172b2a7deaebb044c8c23b5fd3fb8843443b2b2876dd1477ffd5c`.
- Independently derived RC1 → RC2 delta exactly matches `previousReviewedArtifact.delta`: **10 changed / 4 added / 0 removed**. Changes comprise four action modules, two focused test modules and four routing/status documents. Additions preserve the prior report/manifest and append RC2 implementation/native-execution evidence.
- Original baseline SHA-256 remains `936c5b9ae2630a68915253fdfb52f474cc537c42a418bd0612de57f26036dbc6` (591 files). Approved eight-document Stage 3 RC4 architecture package remains `e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c`; all eight normative file hashes independently matched. All 20 old migrations plus lock, prior Stage 3 evidence, Stage 2 normative content/ROADMAP and accepted S3-A source not in the declared S3-B delta remain preserved. No migration or grant change was introduced by RC2.

## Finding closure and nearby behavior

### F1 — closed: expiry after the final lock precedes terminal replay and other known-row outcomes

`guard.ts` now exposes `lockedClock`, which reads the DB clock and rejects the captured current bearer expiry on that time. Approve/reject/revoke/cancel/reserve call it after their final explicit request/approval lock, before successful replay, audited refusal, stored-loss commit, decision or reservation. In reservation, the monotonic mark remains immediately before this clock read; moving the authority check has not renewed the permit deadline.

The original independent RC1 reproduction was run unchanged against RC2. Both a repeated own revoke and repeated own cancel, admitted while valid and then blocked past current-token expiry on the request row, now return **`ACTION_AUTHENTICATION_FAILED`**.

Independently rerun added real PostgreSQL regressions cover both terminal operations on the request row and, where present, the final approval row. They confirm unchanged request/approval rows, zero new audit rows and zero attempts; valid terminal replays before and after the refused call return the same stored result and epoch. Nearby approval replay, executor reservation, wrong-signer revoke and wrong-requester cancel checks also refuse the expired caller before a refusal audit or stale-epoch terminal mutation.

Fresh valid callers still commit detected stored authority loss/expiry and revoke the unconsumed approval; restoring rights does not revive intent. Existing natural-expiry-after-lock and epoch/remove-restore tests passed. Current caller authentication has appropriate precedence over mutating an intent based on its stored guard. No signer-token lookup, token digest persistence, new authority surface or scope change was added.

### F2 — closed: known conflicts remain conflicts at both audit boundaries

The private `auditFailure` classifier uses the existing `isDbConflict` helper for client and security-denial audit INSERTs. Recognized **40P01 / 40001 / P2034** produce only **`ACTION_DB_CONFLICT`**; other audit errors retain **`ACTION_AUDIT_FAILED`**. This preserves the fixed public error contract without forwarding raw SQL diagnostics or adding a retry.

The original independent reservation-audit deadlock probe was run unchanged. A passive Prisma query extension again confirmed **SQLSTATE 40P01**, recognized by the production helper. The public outcome is now **`ACTION_DB_CONFLICT`**, with request and approval still APPROVED and **0 attempts**; no permit was returned.

Independently rerun real deadlock regressions prove the blocked relation is the audit INSERT itself for both `AuditEvent` and `SecurityAuditEvent`, and preserve zero committed effect/denial row. Ordinary injected audit-storage failures at both boundaries still return `ACTION_AUDIT_FAILED`. The successful next reservation requires an explicit new caller invocation; no automatic retry or permit minting occurs on the failed transaction.

## Independent checks and evidence

1. **Artifact verification — PASS.** SHA-256 of the manifest, source ZIP, every ZIP/source entry, working inventory and aggregate hashes; independent exact delta comparison to RC1; frozen migration/evidence/normative preservation checks. Repeated after the checks with zero inventory mismatches.
2. **All action PostgreSQL tests plus adjacent clock regressions — exit 0, 56/56 passed, 0 failed, 64.15 seconds.** Actual command, from the checkout:

   ```sh
   /tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test --test-concurrency=1 tests/pg/action-*.pg.test.ts tests/pg/m365-confirm-clock.pg.test.ts
   ```

   This independently reran all **53** S3-A/S3-B action tests, including the four RC2 additions, and the **3** accepted M365 clock-after-lock cases. Coverage includes authority/scoping, immutable SQL boundaries, nonsuperuser provisioning, routine ACLs, accepted owner/disable compatibility, exact preview/replay/TTL, committed loss, one-use permit/deadline, ordering, conflict/audit rollback and both upgrade paths.
3. **Original independent RC1 probes against RC2 — exit 0.** Executed the exact JS reproduction block in `/tmp/atlas-stage3/ASTRA_S3B_RC1.md` with the existing disposable-DB wrapper, without creating a source/probe file. Output:

   ```text
   revoke: ACTION_AUTHENTICATION_FAILED
   cancel: ACTION_AUTHENTICATION_FAILED
   audit-deadlock: raw SQLSTATE=40P01, conflict=true,
     public outcome=ACTION_DB_CONFLICT, attempts=0,
     request=APPROVED, approval=APPROVED
   ```

   Reproducible extraction/invocation:

   ```python
   from pathlib import Path
   import subprocess
   report = Path('/tmp/atlas-stage3/ASTRA_S3B_RC1.md').read_text()
   probe = report.split('```js\n', 1)[1].split('\n```', 1)[0]
   subprocess.run(['/tmp/atlas-stage3/claude-tools/pgenv.sh', 'node',
                   '--experimental-strip-types', '--input-type=module'],
                  input=probe, text=True, check=True)
   ```

4. **`git diff --check` — exit 0.** Changed source/test modules range from 102 to 316 lines, within the context budget.
5. **Supplied checkpoint evidence independently inspected, distinguished from reviewer reruns.** Narrow final log checks confirmed **177/177 unit/PGlite**, **370/370 full PostgreSQL**, PG17-check PASS and schema-drift PASS. The RC2 evidence records all ten required commands exiting 0 and the focused 53/53 run. Its discrimination run records three defect tests failing with the four original RC1 source modules and the ordinary-audit-failure preservation test passing on both; source was restored and verified before final checks. I did not repeat source mutation, generate/build, or the entire broad suite during this read-only review.
6. **Implementation identity evidence inspected.** RC2 execution metadata records only `claude-opus-5-5`, explicit high, native Anthropic subscription, same implementation session `bf6a1f74-9a89-4ca9-8618-d662b9579c7a`, exit 0, no permission denials. The implementer's report did not determine this acceptance decision.

The reviewer held no checkout write ownership and made no source/evidence/generated-file edits. All independent database work used disposable harness-created databases/roles with cleanup, and protected temporary synthetic fixture files were removed. No pilot/persistent DB, config, account, external vendor call or LIVE action was used. The only retained reviewer write is this report.

## Residual limits and acceptance scope

- RC1's already assessed design boundary is unchanged: runtime grants are column-limited, with approved lifecycle/history/FK/CHECK enforcement. Arbitrary runtime SQL is not claimed to enforce all service-level permission/time decisions. Immutable UPDATEs and future result/verification/mock writes remain closed; this bounded repair does not require a new DB architecture.
- The reservation permit is process-local, conservatively bounded by its original monotonic deadline, minted only after commit and consumed at most once. Expired/refused consumption never resets the durable attempt. Restart recovery and synthetic port execution remain S3-C work.
- Lock-wait expiry tests deliberately wait for the DB clock; deadlock tests require the disposable owner privileges and differing deadlock timeouts. These tests passed in the provided PG17 environment. They do not establish LIVE/provider or production operational readiness.
- No new required finding or regression was found in the reviewed delta or affected surroundings. Source authorization, atomicity, permit, error and no-retry contracts are preserved with F1/F2 corrected.
- Acceptance applies only to the exact RC2 artifact identified above. The coordinator must verify that identity before integrating this gate. Administrative status updates should record this **continued Astra/xhigh re-review** accurately. S3-C is still **NOT_STARTED** within this artifact; this report itself performs no dependent work.
