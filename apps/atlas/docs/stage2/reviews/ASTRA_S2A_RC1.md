# S2-A-rc1 independent acceptance review — REQUEST_CHANGES

Date: 2026-10-08. Reviewer: native Codex **gpt-6-astra**, explicitly assigned and effective effort **xhigh**, fresh first-acceptance session. No other reviewer verdict or implementer conclusion was used. Checkout access was read-only; this outside-checkout report is the only file I created.

S2-A is **not accepted**. Do not advance dependent S2-B work. Four obligatory findings below are reproduced, not hypotheses. Fixes affect concurrency/isolation; renewed acceptance should use a fresh Astra xhigh reviewer against a new frozen artifact.

## Exact reviewed artifact

- Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`
- Branch: `planning/stage2-m365`; baseline/current HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; intentionally dirty.
- Checkpoint manifest: `verification/stage2/S2A_RC1_MANIFEST.json`, version `S2-A-rc1`, 202 files, 77 listed changed paths.
- Package hash: `182c4bb12c5c4dd7ef9b2c78a5cedfe4bf609f3a2e80a031ffc8b8eaff9a19ad`.
- Approved architecture RC5 hash: `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`, all 11 normative entries verified.
- Stage 1 `REVIEW_REPORT.md`: `7e186cf1722540d75511b0599cb55cacc2f2df06e8490389dd2a93abffc9fc78`, unchanged throughout this review. No tracked migration changed relative to HEAD.
- Independently recomputed every listed file hash and both aggregate package hashes **before and after review**: zero mismatches. Every manifest payload file also matches `verification/stage2/S2A_RC1_PACKAGE.zip`.

Scope: tasks 2.1–2.3, A1–A5/A3a/A4a/R1/R2. Cleanup role/routine foundations were inspected because provisioning depends on them; this review does not claim full C5 acceptance, a Graph adapter, sync worker, token cache, correlation endpoint, or live readiness.

## Obligatory findings

### F1 — P1: Runtime startup accepts forbidden SET ROLE paths

Location: `packages/graph/runtime-role.ts:101–109` (runtime facts), `:150–162` (acceptance). Related policy: `prisma/roles.sql:64–66` already prohibits runtime membership in any role.

The self-check tests the current role's SUPERUSER/BYPASSRLS and table privileges, plus membership in table owners and the two cleanup roles. It does not reject other runtime memberships or inspect privileges reachable by SET ROLE. NOINHERIT makes those privileges invisible to `has_table_privilege(current_role, ...)`, but does not prevent SET ROLE.

Reproduction, on a uniquely provisioned disposable PG17 database with `seedGraph` and `seedM365`, using the actual runtime login:

1. As owner, create a unique `NOLOGIN NOINHERIT BYPASSRLS` role, grant it SELECT on Connection, and grant it to the runtime with `INHERIT FALSE, SET TRUE`.
2. Execute `RUNTIME_ROLE_CHECK_SQL` as runtime and pass its row to `assertConfinedRuntimeRole`: **accepted**.
3. On that same runtime connection, SET ROLE to the new role, without any app scope. `SELECT count(*) FROM "Connection"` returns **6 rows** across the seeded clients.
4. The same result was reproduced through an intermediate NOLOGIN role, demonstrating a transitive SET path.
5. A separate NOINHERIT SET path to a role with DELETE on AuditEvent was also **accepted**; after SET ROLE, `has_table_privilege(current_user, '"AuditEvent"', 'DELETE')` is true. Control: changing that grant to INHERIT TRUE was correctly refused by the existing guard.

Contract violated: A1 confinement and RC5 §3 fail-closed runtime checks when role grants are wrong; ordinary runtime may not bypass RLS or delete audit/evidence. This needs an owner-created/misconfigured grant; it is a startup-detection failure, not a claim that an ordinary application request can create the grant. `roles.sql` rejects such membership if rerun, but startup currently does not.

Correction: make runtime startup enforce the same no-membership confinement policy as provisioning (and its required runtime role attributes), or exhaustively reject dangerous effective SET/inheritance paths. Avoid weakening the separately reviewed non-superuser migration-owner exception for cleanup roles.

Verification: direct and transitive BYPASSRLS SET paths; NOINHERIT SET paths to DELETE/immutable-column UPDATE grants; an inherited-grant control; fresh and repeated provisioning including non-superuser table owner. Every forbidden path must fail before runtime serves data.

### F2 — P1: Unlocked parent-state checks allow mutation after publication

Primary locations:

- `prisma/migrations/202610081000_stage2_m365_directory/migration.sql:302–310`, directory-object parent-state check; publication checks at `:273–289`.
- `prisma/migrations/202610081100_stage2_m365_signin_windows/migration.sql:493–502`, membership leaf/attempt-state checks; nearby leaf parent-state checks at `:415–436` and attempt publication at `:383–406`.

These trigger SELECTs do not lock the parent whose state authorizes the write. The FK's KEY SHARE protection does not conflict with an ordinary non-key state update. Consequently two real runtime transactions can both pass their checks and commit an invalid published result.

Directory reproduction (both transactions set local scope w/c1; normal provisioned runtime grants):

1. Prepare an ACTIVE M365 connection, resource state sequence 1, and empty STAGING generation `review-gen`.
2. Transaction A inserts a valid directory object into `review-gen` with `externalEntityId=NULL`; leave A uncommitted.
3. Transaction B updates the generation to PUBLISHED, completedAt=now, clears claim/lease, rowCount=0; updates the resource pointer and sequences to publish it; commits. Its snapshot sees no object from A.
4. Commit A. Result observed: **state=PUBLISHED, rowCount=0, actualRows=1, missingMirrors=1**.

Sign-in reproduction:

1. Prepare a RUNNING attempt with one full-interval RUNNING leaf and a valid evidence row.
2. A inserts WindowEvidence membership but does not commit.
3. B marks the leaf COMPLETE, the attempt COMPLETE/published, swaps the window pointer and commits.
4. At publication there are **0** visible memberships. Commit A: the same published attempt now exposes **1** membership, while stored evidenceCount remains **0**.

Nearby lifecycle-fence probe, also reproduced: A updates Connection to DISABLED/version 2 and retains its row lock without committing. B can mark a version-1 empty generation PUBLISHED and swap its pointer **while A still holds that lock**, since publication only reads the old committed status/version (`directory migration:276–280`; the corresponding sign-in read is `signin migration:384–388`). This demonstrates that the existing SQL fence itself is not serialization-safe; no missing future adapter was used in the repro.

Contract violated: RC5 §3 requires published rows/memberships to be immutable through SQL or equivalently privilege-safe enforcement, requires every published directory object to have its typed mirror, and defines a common Connection/state publication fence. A valid result can be changed by a late commit under the current grants.

Correction: serialize authorization by parent state with all inserts/updates that can affect published membership, and serialize lifecycle validation with the Connection fence. Preserve the approved common lock order, including cleanup; do not merely add inverted parent locks that create deadlocks. Cover directory objects, leaf/attempt state, and WindowEvidence together. The correction belongs to these persisted invariants; implementing the S2-B worker is not requested.

Verification: deterministic two-session PG17 tests for both orders of directory insertion/publication and membership insertion/leaf completion/publication; complete parent/leaf state checks after waits; disable versus directory/sign-in publication; newest-attempt fence; cleanup contention. A loser must wait/revalidate or fail, and a published snapshot must never acquire a late unmirrored object or membership. Check adjacent sibling partition/count checks under concurrent inserts as part of the repair (that particular race was inspected but not independently reproduced here).

### F3 — P2: Mapping freshness uses a timestamp captured before lock wait

Locations: `packages/graph/mapping.ts:189,197–210`; `packages/graph/m365-mapping.ts:48–56`.

`confirmLink` evaluates its default `now = new Date()` when the call starts, then may wait for Connection/resource/external-object locks. `assertFreshM365Membership` uses that old timestamp for the 60-minute limit and expiry after the locks have finally been acquired.

Reproduction through the real service and generated Prisma runtime client:

1. Publish a directory generation completed 3,599 seconds ago, containing the candidate's mirrored user.
2. Hold its Connection `FOR NO KEY UPDATE` in another transaction.
3. Call `confirmLink` normally, without supplying its optional date.
4. Wait 1.5 seconds; release the holder.
5. Observed result: **CONFIRMED**, actual database-measured generation age **3600.55606 seconds**.

Contract violated: RC5 §3 and task 2.3 require a new confirmation to use current fresh directory membership, age strictly below 60 minutes, rechecked under transaction. Contention can also cross the payload expiry boundary.

Correction: obtain the decision time after acquiring all relevant locks and immediately before the freshness/expiry check (a clock function can retain deterministic testing). Ensure retry attempts recalculate time; a transaction-start `now()` would still be stale after a lock wait. Use the checked time consistently for the decision/audit timestamp.

Verification: deterministic lock-wait tests crossing 60 minutes and the payload expiry boundary, plus a just-fresh allowed control and existing stale/pending/absent-object regressions.

### F4 — P2: SQL DTO checks accept an empty object through NULL

Locations: directory migration `:190–210`; sign-in migration `:261–273`.

Both exact-key validators use `array_agg(jsonb_object_keys(...))` and nullable field comparisons inside ordinary CHECK expressions. For `{}`, key aggregation and missing-field comparisons yield SQL NULL. PostgreSQL CHECK accepts UNKNOWN, so the claimed shape and required identity checks do not reject it.

Reproduced as the provisioned runtime: a DirectoryObject with valid scope/sourceObjectId and **dto={}** inserted successfully into a STAGING generation; a SignInEvidence with a valid local ID/sourceId/hash, valid retention values, null reference columns and **dto={}** also inserted successfully. Both parsers correctly reject such missing required inputs; the persistence constraints fail independently.

Correction: require the full validation predicate to be TRUE, not UNKNOWN, and explicitly represent permitted JSON null values (notably userType, which is validly nullable). Enforce required DTO identity/type and exact key presence without relying on a nullable comparison. Preserve legitimate parser outputs containing null optionals.

Verification: runtime inserts of `{}`, missing/null required IDs, and incomplete DTO shapes must fail on both tables; complete DTOs with every allowed nullable field null must pass. Run PGlite and real-PG constraint suites.

## Verification and evidence

Independently reran two bounded commands, with no checkout output or generated artifacts:

```text
node --env-file=.env --experimental-strip-types --test tests/pg/m365-scope.pg.test.ts tests/pg/m365-schema.pg.test.ts tests/pg/m365-permissions.pg.test.ts tests/pg/m365-disable.pg.test.ts tests/pg/m365-privileges.pg.test.ts tests/pg/m365-routine-acl.pg.test.ts tests/pg/m365-nonsuper.pg.test.ts tests/pg/m365-upgrade.pg.test.ts tests/pg/roles-output.pg.test.ts tests/m365-dto.test.ts tests/m365-public-compat.test.ts tests/tool-permissions.test.ts
```

Result: **51 passed, 0 failed, 0 skipped**.

```text
node --env-file=.env --experimental-strip-types --test tests/pg/lifecycle-race.pg.test.ts tests/pg/operator-passes.pg.test.ts tests/decision-config.test.ts tests/context-budget.test.ts tests/context-mapper.test.ts tests/tool-gateway.test.ts tests/m365-database.test.ts
```

Result: **26 passed, 0 failed, 0 skipped**. This includes Stage 1 lifecycle race, independent baseline/shadow passes, configured prompt versions, context/tool compatibility, PGlite, and the 700-line ceiling.

Additional independent probes were executed via `node --env-file=.env --experimental-strip-types --input-type=module` on stdin using `tests/support/pg-harness.ts:createTestDatabase`, `tests/sql-invariants.ts:seedGraph`, `tests/m365-sql-invariants.ts:seedM365`, and, for service checks, `tests/support/{graph-fixtures,m365-fixtures}.ts`. Exact operation order and observed values are recorded in F1–F4 above; no separate probe file or raw-secret log was created. All four probe processes exited 0 after recording their unexpected-success evidence and running their finally cleanup.

Positive additional service probe: six simultaneous m365-disable calls correctly serialized from version 1 to versions **2,3,4,5,6,7**, final status DISABLED/version 7, with **six** connection.disabled audits.

Every raw log named by `verification/stage2/S2A_RC1_CHECKS.json` exists and independently matches its recorded SHA-256, including the reported 106 unit/PGlite tests, two 145-test PostgreSQL runs, schema/generate/typecheck/build/smoke/pg17/drift/diff checks. Those orchestrator results corroborate the baseline; the new adversarial probes expose missing coverage despite passing suites. No build/generate command was rerun by this reviewer.

Cleanup verification after every test/probe finished: **0** remaining `atlas_it_%` databases and **0** remaining `atlas_it_%`, `atlas_review_%`, `atlas_rx_%`, or `atlas_ry_%` roles. Credentials/environment values were never printed. All database changes were confined to disposable test databases and unique test roles.

## Bounded conclusions and residual limits

Composite scope/connection/typed keys, basic RLS, explicit DTO projection, old-context filtering, single/split-client permission rejection, public legacy tool shape, ordinary disable behavior, cleanup ACL reset and non-superuser provisioning all have meaningful passing evidence. Code organization stays within the configured ceiling. These positives do not close F1–F4.

Unimplemented S2-B/C/LIVE behavior remains outside acceptance; no Graph calls, live tenant reads, deployment, or full retention-service acceptance was performed. Literal psql output remains the already recorded operational limitation; protocol-output credential tests passed. No additional unproved hypothesis is promoted to a finding. The request to inspect adjacent concurrency checks is a focused repair/regression requirement, not approval to expand Stage 2 scope.
