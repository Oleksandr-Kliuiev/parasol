# Atlas S2-A-rc3 independent review — REQUEST_CHANGES / INCOMPLETE

Date: 2026-10-08. Reviewer: explicitly assigned native GPT-6 Astra (`gpt-6-astra`), effective effort `xhigh`, fresh context. Separate upstream response-model metadata is not exposed; none is claimed.

Review stopped on the coordinator's explicit instruction after an environment cybersecurity-risk interruption. No further investigation or testing was performed after that instruction. This is not full checkpoint acceptance.

## Verified identity

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1` (read-only during review).
- Branch: `planning/stage2-m365`; HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; intentionally dirty.
- S2-A-rc3: all 209 manifest payload files and corresponding ZIP entries matched their SHA-256 values. Independently recomputed sorted-path aggregate: `b4489cca250cea23ae7e3dafed7fff237ad705eabb58aef6e8b4c41466e3d7ed`.
- Normative RC5: all 11 files matched; aggregate `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
- Stage 1 `REVIEW_REPORT.md`: `7e186cf1722540d75511b0599cb55cacc2f2df06e8490389dd2a93abffc9fc78`; all 12 pre-Stage-2 migrations matched HEAD.
- All 11 raw-log hashes referenced by `verification/stage2/S2A_RC3_CHECKS.json` matched; receipts declare exit 0 and bind to the exact RC3 package. Supplied receipts are verification evidence, not independent acceptance.

These identity checks occurred before independent testing. The final repeated hash check was not performed because the review was interrupted.

## Confirmed obligatory finding

**P1 — Missing-parent INSERT validation can admit a terminal directory generation without publication.**

Location: `prisma/migrations/202610081000_stage2_m365_directory/migration.sql`, `atlas_m365_directory_generation()`, lines 290–300; related UPDATE-only deferred trigger at lines 350–352.

The INSERT branch returns early when its resource-state parent is absent, relying on the foreign key instead of enforcing the initial-state requirement. Independent testing with the production runtime grants confirmed a committed `PUBLISHED` generation with `activeGenerationId = NULL`. The deferred check does not cover that INSERT path. This violates the required binding of first terminal state and pointer publication.

Required correction: enforce the permitted initial state independently of parent lookup success, fail closed on missing prerequisite state, and add a real-PostgreSQL regression for this missing-parent INSERT boundary and its atomicity requirement. Independently reassess analogous lifecycle-entry checks before acceptance; that follow-up was not completed in this interrupted review.

No additional exploitation details are included.

## Independent verification completed

Executed the existing focused files using `node --env-file=.env --experimental-strip-types --test`:

- `tests/pg/m365-publication-atomic.pg.test.ts`
- `tests/pg/m365-race-directory.pg.test.ts`
- `tests/pg/m365-race-signin.pg.test.ts`
- `tests/pg/m365-runtime-membership.pg.test.ts`
- `tests/pg/m365-confirm-clock.pg.test.ts`
- `tests/pg/m365-schema.pg.test.ts`
- `tests/pg/m365-privileges.pg.test.ts`
- `tests/pg/m365-routine-acl.pg.test.ts`
- `tests/pg/m365-nonsuper.pg.test.ts`
- `tests/pg/m365-disable.pg.test.ts`
- `tests/pg/m365-permissions.pg.test.ts`
- `tests/pg/m365-scope.pg.test.ts`

Result: **54 tests passed, 0 failed, 0 skipped; exit 0**. The confirmed defect was found by a separate bounded independent check, not by those existing tests. Their passing result does not close the defect.

The focused test harness completed its teardown. The independent check explicitly closed its runtime connection and invoked disposable-database/unique-role teardown, which completed. No checkout files were edited, no live vendor calls or deployments occurred, and no credentials were printed. A subsequent cluster-wide cleanup audit was not performed after interruption.

## Scope and limits

Intended scope was tasks 2.1–2.3 and A1–A5/A3a/A4a/R1/R2, including persisted cleanup/grant foundations. The review examined package identity, relevant contracts, publication triggers, and selected authorization/runtime/retention code and tests, but stopped before completing all independent analysis and final identity confirmation.

S2-B worker/Graph adapter/cache, S2-C correlation API, full C5, live integration, and production readiness remain outside this review. No conclusions are asserted for uncompleted probes or unexamined paths. **REQUEST_CHANGES on the confirmed finding; overall review INCOMPLETE.**
