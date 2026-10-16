# S2-C-rc1 — CHANGES_REQUIRED

Date: 2026-10-08. Reviewer: GPT-6 Astra (`gpt-6-astra`), effective effort **xhigh**, fresh native Codex subagent `/root/astra_s2c_rc1`. Read-only checkpoint review of tasks 2.7–2.10, C1–C6 including lettered cases, and R1/R2. Report returned to and saved by Codex; reviewer made no checkout edits.

## Artifact verified

- Candidate package: `493059a8d40ce832772511477b8647d7033179599bfbc62324033f0903a7521b`.
- All **306** current payload hashes and corresponding ZIP entries matched. Relative to S2-B: **17 modified, 37 new, none removed**; all other baseline entries matched.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch: `planning/stage2-m365`.
- Baseline manifest digest: `d122f0ea4031ce3421c114c286d409b974d83449d8db6f3930b53884486eb841`.
- All 11 normative files matched package `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
- Brief matched `de3eea93865ef907872a4cf170a87993f629f4ff2ea006bf7fe4293073ad7f57`.
- Frozen migrations and Stage 1 report remained unchanged; report hash: `7e186cf1722540d75511b0599cb55cacc2f2df06e8490389dd2a93abffc9fc78`.
- Final recheck still matched the candidate. No checkout files were changed during this review.

## Required findings

### R1 [P2] Preserve precision when choosing the next cursor-expiry transition

Locations: `packages/correlation/read.ts:38`, `packages/correlation/cursor.ts:102`.

`eligibilityEndMs` floors `from + 7 days` before `cursorExpiry` decides whether the transition is future. A genuinely future transition within the clock's current millisecond becomes equal to `nowMs` and is discarded.

Deterministic reproduction:

- DB clock key: `2026-10-08T12:00:00.1235000Z`.
- Eligible input `from`: `2026-10-01T12:00:00.1239000Z`.
- Actual eligibility transition: `2026-10-08T12:00:00.1239000Z`.
- Issued expiry: **`2026-10-08T12:15:00.123Z`**.
- At `.1240000Z`, cursor expiry checks pass and interval validation instead returns **`CORRELATION_INTERVAL_NOT_RETAINED`**.

This violates the earliest-future-transition and next-page `CORRELATION_CURSOR_EXPIRED` contracts. The interval guard prevents expired-data exposure.

Required fix: determine future eligibility using the precise clock/time keys before converting to integer expiry milliseconds. Conservative early expiry is acceptable; discarding the transition and extending validity is not. Add deterministic same-millisecond boundary tests for correlation and sign-in-list cursor handling, including the expected expiry code before interval validation.

### R2 [P2] Include historical published-attempt validity in conflict cursor bounds

Locations: `packages/correlation/query.ts:91`, `packages/correlation/read.ts:90`, `packages/m365/reads.ts:56`.

`conflictContributors` checks historical attempt expiry in its `EXISTS` predicate but returns only evidence expiry. Attempt identity/expiry therefore does not constrain the fingerprint or cursor deadline.

A real disposable-PG service reproduction used the schema-permitted shorter expiry during `COMPLETE → SUPERSEDED`, with every trigger and constraint enabled:

- Historical attempt expiry: **`2026-10-08 17:49:52.945` UTC**.
- Its evidence expiry: `2026-10-15 13:02:00` UTC.
- Both read surfaces issued cursor expiry **`2026-10-08T18:04:46.982Z`**.
- After attempt expiry, both next-page requests returned **`CORRELATION_CHANGED`**, while a fresh correlation read changed `CONFLICTED` to `CURRENT` and restored canonical-person annotation.

Fingerprint recomputation prevents mixed pages, but it does not satisfy the required expiry bound.

Required fix: include contributing published-membership/attempt validity, or an equivalent effective-validity representation, in fingerprint and expiry calculation. Account for evidence retained through multiple published attempts. Add tests where attempt expiry precedes evidence expiry and require the cursor to expire at that transition on both surfaces.

## Verification

Independently executed **95 existing tests**, all passing with **zero failures, skips or cancellations**:

- **62** focused unit/PG tests covering resolution, provenance, ordering, cursors, expiry, reads, permissions, ledger withdrawal, maintenance confinement, target binding and cleanup atomicity.
- **33** API/CLI/C6 and Stage 1 regression tests, including actual subprocess create/resume/NOT_DUE/requeue/reset, activation revocation, the compiled API/tool journey, lifecycle races, independent worker passes, public compatibility and gateway behavior.

Also executed the deterministic pure and disposable-PG reproductions above. `git diff --check` passed.

Verified all ten original check-log hashes, ZIP copies, receipt correspondence and pre/post-check payload identities. Recorded checkpoint checks report **144 unit/PGlite + 306 PostgreSQL tests**, zero failures/skips/cancellations, and successful schema validation, generation, typecheck, build, smoke, PG17 and drift checks. Execution-receipt hash matched the coordinator record; its metadata reports native `claude-opus-5-5` / high. Claude streams/thinking were not read.

Reviewed implementation conforms elsewhere to the inspected selection/proof, authority/snapshot, retention, API/tool/CLI, maintenance and compatibility requirements. Stage 1 tool descriptions and `ClientContextV1` remain unchanged; the correlation reason-code delta is exactly the ten approved additions. No active file exceeds 447 lines.

## Residual risks and scope

The documented cleanup revocation gap and time-bounded whole-pass execution remain explicit approved limitations. The 19,000-row synthetic performance receipt supports roughly 480 ms per page locally; it does not establish larger-scale performance. The pre-existing S2-B approximately 9,500-membership staging timeout remains a visible failure limitation outside this change.

**LIVE was not exercised.** No live tenant/account access, provider calls or deployment occurred.

## Review evidence

- Focused test log `/tmp/atlas-s2c-astra-rc1-focused.log`: SHA-256 `32a6d95620f8b226feabbca3dd8d7f4a64152c5c44224432506bf9230a04d8e9`.
- Surface/regression log `/tmp/atlas-s2c-astra-rc1-surfaces.log`: `47f961c7f9b51e2bd6498a705f04b1b94194a1176ce6acec9001b5b26d8007aa`.
- Reproduction script `/tmp/atlas-s2c-astra-rc1-repro.mjs`: `50e03dd33c6ae2ed93744a1e97cdaa963c342983caa78320b953409568d8a676`.
- Reproduction output `/tmp/atlas-s2c-astra-rc1-repro.log`: `48fa5ce39172b995654a654f2440e181eb14f2062429246aba98f1ef2f731d2c`.
