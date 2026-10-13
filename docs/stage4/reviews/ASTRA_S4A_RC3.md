# Independent S4-A RC3 acceptance review

**Verdict: CHANGES_REQUIRED.** Two required A3 findings remain. S4-B and S4-C must stay stopped pending repair, resealing, required checks and fresh independent acceptance. This is an actual-code review of S4-A foundation scope, including its SQL cleanup routine; it does not demand the deferred B/C services.

Reviewer assignment: native **gpt-6-astra / xhigh**, fresh context (`fork_turns: none`), task `/root/astra_s4a_rc3`. The parent native launch/runtime record establishes the named-model assignment; this report's self-description is not model proof. No subagents were used. No previous S4-A assessment report/verdict was read or adopted. Codex retained checkout write ownership throughout; the reviewer wrote only this report outside the checkout.

## Exact reviewed artifact

- Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, plus the sealed dirty inventory. HEAD diff was not treated as the checkpoint delta.
- Manifest: `verification/stage4/S4A_RC3_MANIFEST.json`, SHA-256 `8015c6ed447147f030638f741bbc65e34bdfd00cda32401a7eedfc03f54cc628`.
- Source package hash: `cb6f603a6eb8897b79c9e58cfceb33d05662386b71c237ee7b1894de5da131f7`.
- Working inventory hash: `580589e9ed100eebcf13166f07330ea62e8133cbe89b99a9d6388be01f08e616`.
- ZIP: `verification/stage4/S4A_RC3_PACKAGE.zip`, SHA-256 `149f35cfcbdcb06016f5c38a045845e276db81a2073f5348f797ce397f44e791`.
- Implementation evidence: `verification/stage4/S4A_RC3_IMPLEMENTATION_EVIDENCE.json`, SHA-256 `93f114b7d56b3745d5f4dd4df758acaeb17401ccc26a8fc33a9663f1f0f7294e`.
- Initial baseline: `verification/stage4/S4A_BASELINE.json`, SHA-256 `6888685478c236dd7fff0779caf3090c24fe151ea829d05621574b739d4e1d95`.
- Cohesive privilege-repair baseline: `verification/stage4/S4A_RC3_REPAIR_BASELINE.json`, SHA-256 `3923281bafca7ff2213d385cf0b9bd1c824a8a3f1a47a01ce90e4d3b273b2451`.
- Governing eight-file design package: `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`; design RC2 manifest SHA-256 `43f86a7eb492738a2fb0d9c43c18470e26d19860a259f708f38bb7e9ee3c7230`.
- Mandatory handoff: `docs/stage4/IMPLEMENTATION_HANDOFF.md`, SHA-256 `9f199dbb27d255f60db9f926e788cc23b5cba83722d5c0aff780a913f18b94ab`; all eight clarifications applied.

Programmatic verification matched all **711 archive entries and 749 working-inventory entries**, recomputed both manifest digests, checked ZIP bytes/entries, and matched all eight normative files. Initial-baseline delta is exactly **30 changed / 77 added / 0 removed**. Privilege-repair source delta is three existing source/test files changed and five new files, as declared.

## Required findings

### R1 — P1: PostgreSQL 17 MAINTAIN bypasses the exact privilege checks

Locations: `packages/graph/poweroffice-surface.ts:41` and `:71`; `packages/graph/poweroffice-role.ts:140`; `prisma/roles.sql:402` (and the analogous builtin table enumeration around line 443).

The table-privilege enumeration includes SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER, but omits PostgreSQL 17 **MAINTAIN**. The runtime check on the three PowerOffice tables also omits it. Therefore readiness accepts a maintenance runner/definer with extra MAINTAIN on an unrelated relation and accepts runtime MAINTAIN on State, Attempt and Snapshot. Explicit grants can be removed by REVOKE ALL during reprovisioning, but that does not make readiness fail closed before reprovisioning. More seriously, PUBLIC MAINTAIN survives provisioning and its postcondition reports success.

This is an effective capability, not just an ACL-shape discrepancy. In an independent rollback-only probe, the PowerOffice runner had none of SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on a newly created unrelated synthetic table, had MAINTAIN, and successfully executed `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE`. This escapes the approved EXECUTE-only bounded cleanup capability and its lock protocol. The finding does not claim that this privilege itself exposes invoice or credential values.

Independent results on PostgreSQL **17.11**:

| Drift | Readiness before provisioning | Production provisioning body | Effective MAINTAIN afterward |
|---|---|---|---|
| Unrelated synthetic table → PO runner, explicit | all PO problems empty; runner violations 0 | passed | removed |
| Unrelated synthetic table → PO definer, explicit | all PO problems empty; owner violations 0 | passed | removed |
| Unrelated synthetic table → PUBLIC | all PO problems empty; both counters 0 | passed | retained by runner and definer |
| Each of State / Attempt / Snapshot → runtime, explicit | full `assertConfinedRuntimeRole` accepted; runtime grant violations 0 | passed | removed |
| Each of State / Attempt / Snapshot → PUBLIC | full `assertConfinedRuntimeRole` accepted; all three relevant counters 0 | passed | retained by runtime, runner and definer; full assertion still accepted |

The three-table cases were independently exercised, not inferred from one table. Full startup facts were evaluated in the same rollback envelope with `SET LOCAL SESSION AUTHORIZATION` to the confined runtime, so there was no artificial session-role mismatch or skipped startup assertion. The maintenance-role probes used the existing same-connection `factsInEnvelope` helper. Every probe ended with unconditional ROLLBACK; the generated disposable database and roles were dropped. No grants in these probes were committed.

Required correction: include MAINTAIN in the effective table privilege checks for both PowerOffice maintenance roles across the user/builtin relation surfaces, the matching provisioning postcondition, and runtime checks on all three new PowerOffice tables. Keep the approved exact grants unchanged. Safely revoke own-role explicit excess grants where possible and reject residual PUBLIC authority atomically; do not rewrite PUBLIC globally. Add regression cases for explicit and PUBLIC grants, both maintenance roles, all three runtime tables, and a harmless synthetic-table lock positive control.

Compatibility was checked independently: the pinned `@electric-sql/pglite` environment reports **PostgreSQL 17.5** and successfully supports both `GRANT MAINTAIN` and `has_table_privilege(..., 'MAINTAIN')`. There is no demonstrated PGlite reason to omit this privilege or weaken the PG17 check.

### R2 — P2: nondefault tablespace PUBLIC CREATE remains an unchecked extra capability

Locations: `packages/graph/poweroffice-surface.ts:110-111`; `prisma/roles.sql:467-468`. This is the disclosed tablespace limitation, classified here as **required under A3**, not an accepted residual.

The effective check asks about CREATE on `pg_default` only. Its other shared-object check looks for `pg_shdepend.refobjid = role_oid`, which detects explicit role dependencies/ownership but does not detect an ACL entry for PUBLIC. The revocation loop likewise targets explicit grantees matching the two PowerOffice role OIDs. Consequently an already-installed nondefault tablespace with PUBLIC CREATE is outside every relevant predicate and remains available to both roles through PUBLIC.

The approved contract grants the runner its cleanup EXECUTE capability and the definer a specific relation/locking envelope. Additional tablespace CREATE is object-creation authority, not the harmless schema USAGE compatibility exception: with the preserved database TEMP privilege it permits placement of temporary objects in that additional tablespace. A3's exact privilege/provisioning/readiness requirement has no accepted exception for this capability. Absence of such a tablespace in the current disposable test environment, or a PGlite implementation limit, cannot establish the production PG17 invariant.

Required correction: inspect all tablespace ACL/effective CREATE paths relevant to the two roles, including PUBLIC on nondefault tablespaces, and make both readiness and provisioning refuse residual extra authority. Retain safe explicit-grant revocation and never alter global PUBLIC ACLs as a repair. The production check can use tablespace catalog/ACL metadata; handle any PGlite limitation explicitly without turning off the PG17 guard. Add metadata-level regression coverage proving that a nondefault identity is examined, alongside the existing rollback-only shared-ACL tests.

Evidence classification: this is a direct static coverage finding from the production SQL and the disclosed limitation. **No real tablespace was created, changed, used, or otherwise probed**, and no host operation was performed. It is not reported as an executed tablespace exploit.

## Independent review and checks

Read the routed root/feature/Prisma/PG instructions, governing specification/contracts/data/acceptance and S4-A brief. Reviewed all new PowerOffice modules, all three new migrations, Prisma models, role/readiness/surface SQL, rollback helper, new tests and bounded existing integration deltas. Prior assessments and historical verdict collections were not review inputs.

Independent commands (no generator/build/schema/source writes):

1. `node --experimental-strip-types --test tests/poweroffice-*.test.ts`: **15/15 passed**, no failures, cancellations or skips.
2. Via the private PG wrapper, `node --experimental-strip-types --test tests/pg/poweroffice-{aggregate-sql,authority,binding,builtins,cleanup,commit,deadline,generic,history,locks,nonsuper,roles,schema,upgrade}.pg.test.ts`: **59/59 passed**, no failures, cancellations or skips; approximately 16.4 seconds.
3. Via the same wrapper, `node --experimental-strip-types --test tests/pg/action-{guard,requests,signers,upgrade-s3c}.pg.test.ts`: **22/22 passed**, no failures, cancellations or skips; approximately 32.0 seconds.
4. Independent PG17 rollback-only MAINTAIN probes described in R1: confirmed the readiness/provisioning failures and the unrelated-table exclusive lock capability.
5. Independent in-memory PGlite 17.5 MAINTAIN compatibility probe: grant and effective-privilege query supported.
6. Additional pure-validator probes for trailing LF/CR/Unicode line separator in money, dates, UUIDs, invoice/summary DTOs and synthetic bindings: rejected as expected; no finding.
7. Programmatic source/archive/preservation verification before and after the review: exact match, detailed below.

Thus **96 existing tests passed independently**, while additional adversarial probes still establish a required acceptance defect. Passing the existing suite is not acceptance.

The final rollback test helper validates the rendered script has exactly one outer BEGIN/COMMIT and one DO block, removes only that transaction wrapper, evaluates the real provisioning body under a savepoint, and unconditionally rolls back the outer envelope. The rerun builtin/shared ACL suite passed its observer assertions before/during/after drift, including zero remaining parameter ACL rows. No filesystem builtin was invoked; no password/credential catalog row or file data was read. The previously disclosed committed shared-parameter tamper remains historical failed diagnostic evidence; this review does not relabel it as isolated or acceptable.

## Evidence assessment and preservation

The sealed implementation evidence lists all 11 required commands with exit 0. I checked the referenced final `rc3-sealed` logs exist and independently parsed their summaries: **196/196 unit/PGlite and 466/466 PostgreSQL**, zero failures/cancellations/skips. These are implementation evidence, distinct from the independent 96-test run. Full generation/build commands were not repeated by the read-only reviewer.

Selected final log SHA-256 values measured during this review:

- `npm-test.log`: `e2ae27d06fce61080646864c5674e00a63313f8ddf65138032197b1e04c61792`.
- `test-pg.log`: `9e01de8ca6b8dc2d431b829a9cf270fc671d9454fbb23ce1ac10df19ad755bd2`.
- `typecheck.log`: `82ce872894ea3ff464db85484429617eb71eb7ae393adef0e216180bd46b5d41`.
- `db-check-pg17.log`: `e0f458b74dab2c3c193ca54424344ca9d60f0d4e906bf73571b5ee411cfcc0b8`.
- `db-check-drift.log`: `09745f1b994913bf6ad2fdcec79f7da0d6ceb405946380fd9885774b910d711f`.

Executable `setLocal` and `currentToken` text matches the accepted S3-C source byte-for-byte apart from exporting the moved function. `packages/graph/fence-role.ts` is byte-exact against the accepted S3-C package, including the shared invoker list. Existing source/test deltas inspected were additive integration, six-role renderer/fixture adaptation and unchanged old-release rendering; no removed accepted assertions were found in that delta.

All **20 installed migrations plus lock**, existing fixture files and earlier Stage2/Stage3 documents/history present in the initial baseline retain their hashes. The eight Stage4 norms remain exact. Every changed/added active source/test/schema/SQL file is below 500 lines. The final recheck found **zero mismatches among 749 inventoried files** and unchanged HEAD/manifest/ZIP hashes. The only Git-listed files outside the working inventory are the RC3 manifest and RC3 package ZIP themselves. No source, generated output, status, evidence or repository file was written by this reviewer.

## Scope and remaining gates

The foundation has substantial verified coverage: detached strict DTOs, exact BigInt/Oslo aggregation, export completeness/disposal, private bearer authority and last-lock checks, scoped FORCE RLS/FKs, identity/history/sequence/ACTIVE invariants, deferred constraints, original deadline guards, paired synthetic binding, bounded SQL cleanup, safe audit shape, non-superuser migration ownership and accepted-stage regression paths. I found no additional required defect in that reviewed foundation beyond R1/R2.

Actual source sessions, sync/publication/failure/recovery services, replay/cancellation and direct Connection/FK victim journeys remain S4-B. Dedicated reads/API/CLI, fresh maintain admission, runner DB pairing and the whole-transaction 10-second/1-second-lock wrapper remain S4-C. They are not treated as implemented or accepted here. LIVE, vendor semantics, production/account/persistent operations remain deferred by the owner.

R1 and R2 require a coherent privilege-boundary repair under the existing approved contract, updated regression/check evidence and a new exact package. Because authorization/confinement is affected, obtain a **fresh native gpt-6-astra/xhigh acceptance review** of the repaired artifact before advancing dependent work. The present artifact is **CHANGES_REQUIRED**.
