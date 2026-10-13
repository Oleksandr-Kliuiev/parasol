# S4-A RC1 independent checkpoint review

**Verdict: CHANGES_REQUIRED.** Stop at S4-A; this package is not accepted for dependent S4-B work.

Review assignment: fresh GPT-6 Astra, effective effort **xhigh**. The orchestrator retains the native launch/runtime identity evidence; this report's self-identification is not model proof. This was an independent actual-code review, not adoption of the implementer's conclusions. No other review report/verdict was read. The orchestrator supplied an accumulator-disposal observation during the review; I independently reproduced it. All other required findings below came from inspection and independent probes.

## Exact artifact and preservation

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- Actual HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; actual branch: `planning/stage2-m365`.
- S4A-rc1 package: `65ae3876cca017ff6b6096f1c6f0f3fdfe7a9ef9e1a98d6f999307fac4aa8056`.
- Manifest SHA-256: `f4f6c575f7cd4b3c7abb70d61af7691411e0b8f814e41398d7a2575563bf2f1f`.
- Source ZIP SHA-256: `9f18e7bad81fff191ee60add4eb79248659979d1c602fef53bca985dae9f3fd1`.
- Baseline SHA-256: `6888685478c236dd7fff0779caf3090c24fe151ea829d05621574b739d4e1d95`.
- Approved architecture package: `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`.
- Independently recomputed the 677-file source package hash and 713-entry working inventory hash; every current file and every archived source entry matched. Checkpoint delta is 29 changed / 41 added / 0 removed from the 672-file baseline, not the HEAD diff.
- Baseline comparison confirms preservation of the 20 installed migrations plus lock, earlier normative files, eight Stage4 normative files, and existing history/evidence. No unexpected changed path was found.
- Compared changed adjacent source and existing tests with baseline-hash-matching entries of the accepted S3C RC2 archive. The current-token query and setLocal bodies are verbatim extractions. Existing test changes are additive role/schema expectations and deliberate old-role renderers, not removed behavioral assertions. The new S3C role fixture is byte-exact with baseline roles.sql.
- The working inventory was rechecked after the review tests and probes: zero mismatches. No source, generated output, build, schema-generation output, or persistent database was modified. Only this report is a reviewer filesystem deliverable.

## Required findings

### F1 — P1: Maintenance roles can execute an unapproved definer routine while readiness and reprovisioning report healthy

Locations: `packages/graph/poweroffice-role.ts:101–136`, `prisma/roles.sql:202–255` and its final confinement checks.

The new readiness checks inspect table/column privileges, attributes, memberships, ownership, and the ACL of `atlas_poweroffice_cleanup`. They do not inspect the application-routine EXECUTE surface of the PowerOffice runner or definer. The provisioning reset likewise leaves unrelated routine grants in place. This violates the approved execute-only runner and exact maintenance-role confinement contract (A3/R2); an additional SECURITY DEFINER routine can confer authority absent from all the inspected relation grants.

Independent disposable-PG reproduction:

1. Provision the ordinary test database/roles. Create `public.s4a_review_extra()` returning integer 42, SECURITY DEFINER with fixed search_path; immediately revoke all PUBLIC privileges.
2. Grant EXECUTE on that routine to the PowerOffice runner and definer only. No fence-definer grant, PUBLIC grant, membership, or direct table grant is added.
3. Query the full `RUNTIME_ROLE_CHECK_SQL` as runtime and call `assertConfinedRuntimeRole`.
4. Call the extra routine as the actual runner login, then rerun the production roles.sql through `provisionRoles` and recheck.

Observed: `ready:true`, actual runner result `42`; `poRoutineViolations`, `poOwnerViolations`, and `poExecuteViolations` all `0`. Reprovisioning succeeds, both unexpected grants survive, and full readiness remains healthy.

Required correction: validate each PowerOffice maintenance role's complete application-routine execution surface, allowing only its intended cleanup capability and explicitly identified harmless shared invoker helpers where required. Remove unexpected explicit grants during provisioning when possible and otherwise fail closed. Do not widen the Stage3 fence shared-invoker list. Cover routines outside the `atlas_poweroffice_` name prefix and outside public, and inherited/PUBLIC access paths consistently with the approved boundary.

Acceptance: the reproduction must fail readiness before any PowerOffice work; reprovision must revoke the extra grants or refuse. Test runner and definer separately, a SECURITY DEFINER routine, an unexpected explicit helper grant, and a foreign-schema routine. Healthy/non-superuser provision and existing fence readiness must still pass.

### F2 — P1: The 10-second timestamp tolerance admits new publication and FAILED closure after the actual claim deadline

Locations: `prisma/migrations/202610091210_stage4_poweroffice_guards/migration.sql:120–123` and `:163–169`; related Attempt CHECK in `202610091200_stage4_poweroffice_state`.

The snapshot guard compares the supplied `publishedAt` with the claim deadline, and accepts timestamps within the prior 10 seconds. The terminal guard similarly accepts a recent supplied `completedAt`; the CHECK compares that supplied value with the deadline. Neither path independently rejects an already expired ACTIVE claim using the actual DB clock. The tolerance therefore becomes an extra publication/failure window, contrary to the original 80-second deadline and the requirement that at/after deadline only recovery can close the claim. This is a schema/history foundation issue already within S4-A, not a demand to implement S4-B services.

Independent disposable-PG reproduction under the actual confined runtime grants:

1. Use `claimAttempt` to commit a valid ACTIVE claim. Use the existing superuser-only `ageConnection(..., '81 seconds')` fixture to put its unchanged 80-second deadline approximately one second in the past.
2. Acquire the approved fence → State → Attempt locks. Query DB clock and verify `deadlineAt < clock_timestamp() AT TIME ZONE 'UTC'` is true.
3. Supply `t = deadlineAt - interval '1 millisecond'`. Insert the allocated snapshot at t; update the Attempt to SUCCEEDED/completedAt=t and coherent State publication pointers/history; commit.
4. On a separate claim, repeat with FAILED/completedAt=t and coherent terminal State metadata.

Observed: `late-publication {expiredBeforeInsert:true, committed:true}` and `late-failure {expiredBeforeUpdate:true, committed:true}`. No trigger was disabled during either attempted transition; replica mode was used only by the existing fixture to age the preexisting ACTIVE claim. The regular history tests pass because their writers always supply a fresh timestamp, so they miss backdating within this tolerance.

Required correction: enforce the actual DB deadline at the relevant new-publication and ACTIVE-terminal transitions, independently of any timestamp-transport tolerance. Keep the approved original deadline, not a renewed or grace-period deadline. Preserve the distinct future identical-SUCCEEDED-receipt contract: a receipt-only no-op after deadline is allowed, a new ACTIVE publication is not.

Acceptance: direct runtime and owner attempts at/after deadline with backdated but recent publishedAt/completedAt must roll back with no snapshot/pointer/terminal changes; FAILED must refuse and ABANDONED must remain possible. Before-deadline valid publication and all coherent history/cleanup tests must still pass. Include an exact-boundary DB-clock case, not only grossly old timestamps.

### F3 — P2: Cleanup does not validate the complete synthetic binding and can purge after the pair has become invalid

Location: `prisma/migrations/202610091220_stage4_poweroffice_cleanup/migration.sql:45–50`; exact Connection-column grant in `prisma/roles.sql:207–208` and `packages/graph/poweroffice-role.ts:26`.

The routine checks tenant-ID shape, provenance, status and version, but never proves that `secretRef` is `fixture://poweroffice/<the same UUID>`. `checkBinding(...,'closeout')` correctly requires that pair. The existing Connection immutability trigger does not make secretRef immutable, so full validity cannot be inferred from earlier admission or unchanged externalTenantId.

Independent disposable-PG reproduction:

- Commit a valid synthetic claim and complete snapshot for `po-a`, then age it two days using the existing fixture.
- As owner, update only secretRef to a different synthetic fixture UUID. This ordinary UPDATE is accepted by the installed Connection triggers.
- The TS closeout validator now returns `POWEROFFICE_CONNECTION_UNAVAILABLE`.
- Call cleanup as the actual confined runner with matching workspace/client/connection GUCs and a local correlation UUID.

Observed: SQL returns `COMPLETED`, `clearedPointer:true`, `deletedSnapshots:1`, `deletedAttempts:0`; it deletes and audits despite the invalid binding. A separate newly inserted mismatch also returned COMPLETED, confirming this is not a lifecycle-version artifact.

Required correction: establish and enforce the full paired synthetic-binding invariant at the cleanup boundary without quietly widening credential visibility or rewriting accepted migrations. The exact current no-secretRef definer grant is an intentional implementation boundary and should not simply be broadened as an expedient repair. A DB-enforced integrity invariant that the routine can safely rely on is one possible approach; its compatibility and upgrade behavior need review. If the proposed repair changes the approved privilege/binding contract, obtain the required architecture review instead of declaring this discrepancy intentional.

Acceptance: malformed/non-fixture/mismatched secret references and mutation between admission and cleanup must refuse with zero pointer/delete/audit effects (or be prevented by an independently verified invariant). Valid FIXTURE and valid DISABLED/lifecycle-advanced closeout still work, with the exact confined-role grants and no secret resolution. Existing accepted Connection/Stage2/Stage3 behavior remains unchanged.

### F4 — P2: Disposing an incomplete accumulator resets uniqueness tracking without making it terminal

Location: `packages/poweroffice/export.ts:75–76`, interacting with `:40–42` and `:57–59`.

`dispose()` clears only the ID set; count, ordinal, header and aggregate remain live. Subsequent pages can therefore reuse an earlier invoice ID and still produce a claimed complete summary. This violates the complete-export distinct-ID contract and creates an unsafe lifetime boundary for future abort/late-result handling.

Independent inline reproduction: valid header totalCount=101; accept page1 containing 100 distinct invoices, each outstanding 1.00 NOK, hasMore=true; call dispose(); accept ordinal2/final page containing invoice1 again; call summary(). Observed `acceptedDuplicateAfterDispose:true`, totalCount 101 and amount 101.00 despite only 100 distinct IDs. The orchestrator supplied the scenario; I ran it against this exact source independently.

Required correction: make disposal of an incomplete pass irrevocably inert/failed. Keep internal successful memory cleanup separate if needed so a completed detached summary remains available. Do not allow disposal to reset any validator condition for a resumable pass.

Acceptance: after disposal of an incomplete accumulator, both duplicate and otherwise-valid subsequent pages refuse, summary refuses, and repeated disposal is harmless. Ordinary successful completion and frozen summary retrieval still work; first-failure poisoning remains intact.

## Independent verification

All commands ran in the checkout above. PostgreSQL commands used `/tmp/atlas-stage3/claude-tools/pgenv.sh` without reading/printing that wrapper, environment values, URLs or credentials. Harness-created databases and unique roles were disposed in test hooks/finally. No builds/generators were run by the reviewer.

1. `node --experimental-strip-types --test tests/poweroffice-dto.test.ts tests/poweroffice-aggregate.test.ts tests/poweroffice-policy.test.ts`
   - Exit 0, **14/14 passed**, about 0.2 s.
2. Wrapper + `node --experimental-strip-types --test --test-concurrency=1` for `tests/pg/poweroffice-{commit,cleanup,authority,roles,locks,upgrade,nonsuper}.pg.test.ts` (explicit expanded paths in execution).
   - Exit 0, **31/31 passed**, about 15.2 s.
3. Wrapper + the same Node flags for `tests/pg/poweroffice-aggregate-sql.pg.test.ts`, `poweroffice-history.pg.test.ts`, `poweroffice-generic.pg.test.ts`, and `action-guard.pg.test.ts`.
   - Exit 0, **19/19 passed**, about 34.0 s. This independently covers TS/SQL aggregate corpus, direct history guards, generic exclusion, and accepted Stage3 authority/expiry/replay/audit-rollback semantics after extraction.
4. Independent inline Node reproductions for F1–F4 produced the contrary-to-contract outcomes recorded above. The first combined PG probe proved F2, then stopped because its proposed new fixture reused an existing unique tenant ID (23505); its finally cleanup ran. The corrected probe used a distinct synthetic ID and completed F1/F3. A final separate probe confirmed actual invalid-binding deletion and FAILED-after-deadline. The intermediate setup error is not counted as successful evidence.
5. Additional canonical-whitespace negative probes (LF, CR, U+2028/U+2029 suffixes) were refused by the invoice/date/money/summary validators; no finding from that hypothesis.
6. Programmatic hashes and narrow baseline diffs, including currentToken/setLocal extraction and unchanged old role fixture; source/archive verification and end-of-review inventory check all passed.

The implementation evidence JSON has verified SHA-256 `4016531e060212c8c8e6d368fba62f910e4c7b4919b3bd1178a8f21e1a7aebc3`. It reports 195/195 unit/PGlite and 446/446 PostgreSQL tests plus exit-0 schema validation/generation, typecheck, API build/smoke, PG17, drift and whitespace checks. These remain **implementer evidence**, not my independent runs or acceptance. The reported earlier failed run/cancelled worker is not reclassified as passing.

## Positive assessment and remaining boundaries

The modular organization, immutable DTO copies, BigInt arithmetic, currency separation, bounded complete-export checks outside F4, scoped compound FKs, restrictive three-ID cleanup RLS, bidirectional deferred ACTIVE/pointer/history constraints, allocated snapshot ownership, purged-lastSuccess representation, immutable terminal history, bounded cleanup selection, atomic cleanup audit rollback, last-lock bearer recheck and workspace-only denial behavior are supported by code inspection and the focused checks. Migration-time PUBLIC EXECUTE revokes, unchanged fence policies/invoker list, non-superuser provisioning and populated accepted-20-migration upgrade are independently exercised. No generic graph/context/Gateway or credential-resolution expansion was found.

The approved SQL cleanup foundation is legitimately in S4-A. Public maintain admission, paired-runner DB verification, original whole-transaction 10-second cancellation/1-second lock-timeout wrapper, API/CLI and their synthetic/error/privacy journeys remain S4-C. Actual source sessions, claim/publication/failure/recovery services, publication retry/replay, port cancellation and direct Connection/FK deadlock victim orderings remain S4-B/C evidence; this report does not accept them. LIVE/account/vendor operations remain deferred.

No unavoidable contradiction in the frozen normative documents was established. F1/F2/F4 are implementation corrections to approved invariants. F3 requires a concrete implementation choice that preserves full binding checks and privilege confinement; an actual change to those contracts would need a design amendment. Because fixes affect deadline and role-confinement invariants, renewed acceptance should use a fresh explicit Astra/xhigh review of the newly sealed artifact and affected regression evidence. Preserve this RC1 artifact and failed-boundary evidence; do not advance dependent work on RC1.
