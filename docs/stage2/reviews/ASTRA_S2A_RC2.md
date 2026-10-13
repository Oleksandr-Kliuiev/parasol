# Independent acceptance review — S2-A-rc2

Verdict: **REQUEST_CHANGES**. One obligatory **P1** finding remains in the persisted publication boundary. Do not advance dependent S2-B work on this artifact.

Reviewed 2026-10-08 by the explicitly selected native Codex reviewer **gpt-6-astra**, effective reasoning effort **xhigh**, fresh review context. The runtime binding selects the model and effort; separate upstream response-model metadata is not exposed, and none is claimed. Attributable subscription usage and billing are unavailable. Read-only review: no implementation, documentation, or evidence files in the checkout were changed. This report is outside the checkout.

## Scope and exact identity

Tasks 2.1–2.3 / S2-A: A1–A5, A3a/A4a, R1/R2, and persisted cleanup/grant foundations. Particular independent scrutiny of F1 runtime membership paths, F2 persistence/publication concurrency, F3 post-lock confirmation clock, and F4 SQL DTO truth semantics. This is not S2-B/C, full C5, Graph adapter/worker/cache/correlation API, live acceptance, or production approval.

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- Branch: `planning/stage2-m365`; HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`. Intentional dirty work preserved.
- `verification/stage2/S2A_RC2_MANIFEST.json`: 208 payload files; package SHA-256 `9220ceecebb2660386afedaec2b6a63a9daeb13cf6f5e12b158a96b7df5ad696`.
- `verification/stage2/S2A_RC2_PACKAGE.zip`: all 208 manifest payload entries independently match the source hashes; archive has 209 entries including its manifest.
- Normative RC5: 11 files, aggregate `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
- Stage 1 `REVIEW_REPORT.md`: `7e186cf1722540d75511b0599cb55cacc2f2df06e8490389dd2a93abffc9fc78`.
- Independently checked every source hash and recalculated each aggregate before and after the review using sorted `sha256 + two spaces + path + LF`. Zero mismatches both times. The final package and normative identities are unchanged.

## P1 — F2 remains open: completion and root-pointer publication can be separated across the lifecycle/newest-attempt fence

Locations:

- `prisma/migrations/202610081000_stage2_m365_directory/migration.sql:238–244` (`atlas_m365_resource_state`, changed non-null pointer).
- `prisma/migrations/202610081150_stage2_m365_signin_triggers/migration.sql:23–37` (`atlas_m365_signin_window`, changed non-null pointer).
- Related terminal transitions: directory migration `303–323`; sign-in trigger migration `93–118`.

The Connection/current-version/newest-started checks run when a generation becomes PUBLISHED or an attempt becomes COMPLETE. Those transitions can commit while their root pointers remain NULL. A later pointer UPDATE checks only the terminal state and that the target attemptSeq equals the supplied latestPublishedSeq. It does not recheck Connection ACTIVE/current lifecycleVersion or the current latestStartedSeq. There is no commit-time constraint binding the first terminal publication to its pointer transition.

This breaks two distinct requirements in contracts §3: publication is fenced at the actual pointer change, and terminal completion/pointer publication is atomic. The remaining hole is in SQL persistence already claimed by S2-A, independently of the future S2-B publisher service.

### Independent real-PostgreSQL reproduction

Executed an inline Node ESM probe through the existing disposable-database harness on PostgreSQL **17.11 (Debian 17.11-1.pgdg13+2)**. Setup used `seedGraph`, `seedM365`, and a login created by the unmodified production `roles.sql`; mutations below ran as the **confined runtime role**, with transaction-local workspace `w`, client `c1`. No grants were widened and no trigger was disabled.

1. On ACTIVE connection `m1`, lifecycleVersion 1, create a directory resource state with latestStartedSeq 1 and an empty STAGING generation `probe-gen`, attemptSeq/version 1. Transition it to PUBLISHED with completedAt and cleared claim; **COMMIT without changing activeGenerationId succeeds**.
2. Create an hour-aligned window `probe-win`, request/root job, RUNNING attempt `probe-att` at attemptSeq/version 1, and its full-interval root leaf. Advance leaf PENDING → RUNNING → COMPLETE. Set attempt COMPLETE with completedAt/publishedAt, cleared claim, leafCount 1 and evidenceCount 0; **COMMIT without changing publishedAttemptId succeeds**.
3. Independently observed committed state:
   `directory_state=PUBLISHED, activeGenerationId=NULL, attempt_state=COMPLETE, publishedAttemptId=NULL`.
4. In another committed transaction, disable `m1` and increment lifecycleVersion to 2. Then execute:

```sql
UPDATE "M365ResourceState"
SET "activeGenerationId" = 'probe-gen', "latestPublishedSeq" = 1,
    "latestRecordedSeq" = 1, status = 'OK',
    "lastAttemptAt" = now(), "lastSuccessAt" = now()
WHERE "connectionId" = 'm1';
UPDATE "M365SignInWindow"
SET "publishedAttemptId" = 'probe-att', "latestPublishedSeq" = 1,
    "latestRecordedSeq" = 1, status = 'OK',
    "lastAttemptAt" = now(), "lastSuccessAt" = now()
WHERE id = 'probe-win';
```

Both UPDATEs **succeed**, and a read in that runtime transaction reports the old version-1 pointers while Connection is DISABLED/version 2. The probe deliberately rolls back these pointer changes after recording the result; the completion-without-pointer and disable transactions above were committed.

5. Reactivate the connection at version 3, and in a committed transaction raise both roots' latestStartedSeq to 2. Repeat the same pointer UPDATEs. Both again **succeed**, reporting ACTIVE/version 3, latestStartedSeq 2, latestPublishedSeq 1, and the old version-1 pointers. Roll back probe pointer changes afterward.
6. Nearby control: marking the detached sign-in attempt SUPERSEDED and then pointing at it is correctly rejected with P0001, `the window pointer names the COMPLETE attempt of latestPublishedSeq`.

The existing tests miss this because their publication helper performs terminal transition and pointer update together in one correctly ordered transaction. The repaired terminal-transition fence and child locking therefore pass while this root-pointer path remains open.

### Required correction and regression evidence

1. **Pointer linearization fence:** every new non-null directory/window pointer must revalidate ACTIVE Connection, the target's current lifecycleVersion, and the target's eligibility against current latestStartedSeq while holding the common Connection → root order. An earlier terminal-state check is insufficient. Preserve fail-closed behavior for out-of-order calls, retained older snapshots after a failed/newer attempt, and the narrow expired-pointer cleanup exception.
2. **Commit-time atomicity:** a first PUBLISHED/COMPLETE transition cannot commit without its corresponding root-pointer publication in that transaction. Add a database-enforced transaction boundary (for example appropriately designed deferred constraints or a confined atomic publication interface); a service convention alone does not close this SQL invariant. Historical already-published rows may of course remain after a newer pointer replaces them.
3. Test both resource types under production runtime grants: terminal-only COMMIT rejection/rollback; correctly ordered atomic success; disable/version change and newer-started change between would-be completion and pointer publication; both contention orders; prior retained pointer preserved on failure; supersede/cleanup interactions. A repair limited to item 1 does not satisfy item 2.

## Other reviewed repair boundaries and nearby checks

- **F1:** direct outgoing membership rejection covers direct and transitive NOINHERIT/SET-only routes before serving data; session/current-user mismatch and privileged role attributes also fail closed. Focused tests demonstrate actual SET ROLE paths to BYPASSRLS, DELETE/immutable UPDATE, and refusal of inherited privileges. The non-superuser-owner suite confirms the allowed trusted creator/administration provisioning path remains usable and untrusted incoming cleanup-role links remain refused.
- **F2 child races:** the added parent locks, post-wait reads, count checks, and NOWAIT handling close the exercised late directory-object and window-membership races; sibling-overlap serialization also passes. These results do not close the pointer/atomicity finding above.
- **F3:** the decision-clock callback is taken after Connection, resource-state and external-object locks inside each retry. The real-PG tests cross both the 60-minute boundary and payload expiry while blocked, refuse after the wait, and persist the post-lock time for a just-fresh success.
- **F4:** exact key sets, outer COALESCE and CHECK `IS TRUE` reject empty/incomplete/null-required DTO shapes; complete DTOs with explicit nullable fields remain valid. Shared SQL invariant coverage passed on real PostgreSQL independently of the TypeScript parsers.
- All-of permission checks remain scoped to a single client membership. Focused runtime tests cover Stage 1 public projection filtering, scoped mapping denials, current-authority recheck during disable, repeat-disable version increment, and the actual CLI. No additional obligatory finding was established in this bounded review.

## Commands and results

Independently executed (all files prefixed `tests/pg/`):

```text
node --env-file=.env --experimental-strip-types --test \
  tests/pg/m365-runtime-membership.pg.test.ts tests/pg/m365-race-directory.pg.test.ts \
  tests/pg/m365-race-signin.pg.test.ts tests/pg/m365-confirm-clock.pg.test.ts
```

Exit 0; **21/21 passed**, 0 failures/skips (about 1.75 seconds reported by test runner).

```text
node --env-file=.env --experimental-strip-types --test \
  tests/pg/m365-schema.pg.test.ts tests/pg/m365-privileges.pg.test.ts \
  tests/pg/m365-routine-acl.pg.test.ts tests/pg/m365-nonsuper.pg.test.ts \
  tests/pg/m365-disable.pg.test.ts tests/pg/m365-permissions.pg.test.ts tests/pg/m365-scope.pg.test.ts
```

Exit 0; **27/27 passed**, 0 failures/skips (about 3.41 seconds). A `pg` warning about concurrently queued queries is present in the scope test; it did not fail the run or invalidate the independently reproduced blocker.

The separate inline `node --env-file=.env --experimental-strip-types --input-type=module` probe above exited 0 and reproduced the finding. No temporary test source was written into the checkout.

Independently verified all **11** log hashes in `verification/stage2/S2A_RC2_CHECKS.json` against the raw local files. Each receipt has exitCode 0 and is tied to this package: schema validate, generation, typecheck, unit/PGlite 106/106, API build/smoke, full PostgreSQL 166/166 twice, PG17 check, zero-drift check, diff check. These are verified supplied receipts, not claims that this reviewer reran all 11 commands. Passing author receipts do not override the independent reproduction.

## Cleanup and limitations

The custom probe disconnected its runtime session, dropped its disposable database and all three unique managed roles in finally, then independently queried the administrator catalog: **0 matching databases, 0 matching roles**. After the focused suites ended, catalog checks reported **0 `atlas_it_%` databases and 0 roles matching `atlas_it_%`, `atlas_rx_%`, or `atlas_ns_%`**. No live vendor/network calls, deployment, build, generation, snapshots, or source writes were performed by the reviewer.

The final payload/source hashes, normative RC5 aggregate and Stage 1 review hash were rechecked and are unchanged. Review stopped after the bounded blocker/nearby checks; no claim of exhaustive discovery or acceptance of later service workflows. Required next action: repair the two publication requirements, run affected checks, freeze a new artifact, and obtain fresh xhigh acceptance because the repair changes atomicity/concurrency invariants.
