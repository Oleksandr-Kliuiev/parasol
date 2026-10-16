# S3-A RC1 independent acceptance review

**REQUIRED_CHANGES.** Reviewer: GPT-6 Astra; effective review effort **xhigh**. This is the first actual checkpoint review, read-only, with fresh review context. S3-B/C must remain unstarted. All evaluation below is of the unchanged RC1 artifact, not a proposed repair.

## Exact reviewed artifact

- Package: `55c1157596bc6ba5b7068c02b776199d39222c48b10cae7fc087a2e4be061593`.
- Manifest: `verification/stage3/S3A_RC1_MANIFEST.json`; 574/574 current file hashes verified, aggregate independently recomputed.
- Private source ZIP: `/tmp/atlas-stage3/S3A_RC1_SOURCE.zip`; SHA-256 `02a53d39d2eaee45a5a2012bbffa6dd6b9348ca410eb574e15d619f87dd0c0cf`; all 574 archive entries match the manifest.
- Baseline manifest SHA-256: `10535916a4f9ba6b440ce384df10cf78464b67acf00ba7bee7b5c0a32765dd78`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`. Delta: 29 modified baseline paths, 26 added (23 implementation/handoff plus 3 administrative evidence), zero removed.
- Eight frozen Stage 3 architecture documents match package `e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c`; all 19 prior migration artifacts and Stage 1 REVIEW_REPORT preserved. Stage 2 normative preservation fails as described below.
- Native implementation stream independently hashes to `a1672c798e38e8d00650d822d7a1d145b6f4ea716abd578202c668267bdbbc5d`; every observed assistant message model is `claude-opus-5-5`, session `21ca7ffa-f253-4a2f-a0b6-cfa3d67bb4ff`. Requested high effort/native subscription routing are recorded in execution evidence; the model scan independently confirms response-model identity, not subscription quota or hidden effort.

## Required fixes

### F1 — P2: fence definer's extra routine privileges escape readiness

Locations: `packages/graph/fence-role.ts:74` (especially lines 80–87), `prisma/roles.sql:169`.

The role audit rejects ownership of other functions and unexpected relation/sequence privileges, but never inventories EXECUTE privileges on other functions. Provisioning resets tables/sequences and the fence function's own ACL, not unexpected grants *to* the definer on other routines. This violates the accepted dedicated-role contract (“no other relation/sequence/function privileges”) and exact-privilege readiness requirement.

Reproduced in a disposable PG17 database: create `public.astra_extra()` as an owner SECURITY DEFINER function returning an ApiToken count, revoke PUBLIC EXECUTE, then `GRANT EXECUTE ON FUNCTION public.astra_extra() TO <fence-role>`. `has_function_privilege` is true, yet `assertRuntimeRole()` passes and `actionFenceProblems(...)` is `[]`. The role now has an additional authority-bearing callable surface which the gate claims to exclude. This is explicit grant drift, not arbitrary replacement of the approved fence function body.

Required: inventory application-routine privileges of the fence role, reject unexpected EXECUTE grants, and refuse or remove these grants during provisioning. Any allowance for existing shared invoker helpers must be narrow and explicit, while preserving accepted helper/auth/cleanup surfaces. Add a regression for an unrelated, non-PUBLIC SECURITY DEFINER function granted to the fence role; startup and fenced admission must fail until repaired. Evidence: `/tmp/atlas-stage3/astra-s3a-function-grant-repro.json`.

### F2 — P2: protected input blocks indefinitely on a FIFO

Location: `packages/actions/private-file.ts:66`.

`open(path, O_RDONLY | O_NOFOLLOW)` on a named pipe without a writer waits before returning a descriptor. Thus the subsequent `fstat().isFile()` rejection is never reached; a 0600 FIFO hangs preview/request input handling rather than returning the fixed input error. This contradicts the protected reader's non-regular-file rejection contract.

Reproduced with `mkfifo -m 600 <private-temp-path>` followed by `readProtectedJson(path, 16384)`: still pending after the bounded probe, requiring process termination. No file content or credentials were involved.

Required: use a nonblocking open suitable for checking the descriptor type (for example, add O_NONBLOCK), retain O_NOFOLLOW and same-descriptor fstat/read, and reject non-regular descriptors with ACTION_INPUT_INVALID. Add a bounded subprocess test for a FIFO with no writer, preserving regular-file and symlink protections.

### F3 — P2: ACTIVE claim CHECK admits absent ordinal/deadline

Location: `prisma/migrations/202610091100_stage3_action_requests/migration.sql:217` (lines 221–223).

The ACTIVE branch compares nullable `activeVerificationOrdinal` and `activeDeadlineAt` without requiring them to be non-null. PostgreSQL CHECK accepts UNKNOWN. A row with ACTIVE, a non-null token, a non-null startedAt, but null ordinal and deadline therefore satisfies this constraint. Such a persisted claim has no usable ordinal or recovery deadline. The complete later-stage shape constraints are explicitly part of S3-A even though runtime writes to these tables remain unavailable today.

Reproduced in a disposable database after creating a valid request/approval/attempt: update verificationState to ACTIVE, verificationCount/Seq to 1, set a random active token and startedAt, leave activeVerificationOrdinal and activeDeadlineAt NULL. The update succeeds and scoped runtime observation confirms both missing fields. Evidence: `/tmp/atlas-stage3/astra-s3a-null-claim.json`.

Required: make the ACTIVE branch total/boolean by explicitly requiring every mandatory claim field non-null, including ordinal and deadline, before validating ranges/equality. Add independent negative cases for each missing field and a positive fully populated claim. Audit nearby nullable lifecycle CHECK expressions for the same SQL-NULL issue; retain the approved state machine and S3-B/C service boundary.

### F4 — P2: frozen Stage 2 roadmap was edited; preservation claim is false

Locations: `docs/ROADMAP.md:27`, `verification/stage3/S3A_IMPLEMENTATION_EVIDENCE.json:101`.

Stage 2 `REVIEW_MANIFEST.json` pins docs/ROADMAP.md among its 11 normative files. Expected/baseline SHA-256 is `e68cf7d11a86a4844440ff3ff52344e6d52b92f08d96a2e4711fd513af5c93e0`; RC1 is `781bc5a6b893e3df56958c729f9c41037d621ddfd6d33ca0128752e55821808a`. The Stage 3 status row was changed, contrary to the S3-A brief's explicit frozen-normative11 restriction. The evidence nonetheless reports `frozenMigrationsLockStage1ReportStage2Docs: true`. Independently checked all 11 normative files: this is the only mismatch.

Required: restore the exact frozen roadmap bytes; keep current Stage 3 status in its administrative status/routing documents. Correct evidence and issue a new package/manifest/archive identity. Do not amend the accepted Stage 2 manifest to hide the difference.

## Independent verification and assessment

- `npm test`: **175/175 pass**, zero failures/skips. The focused canonical/file run also passed **7/7** (included in those 175).
- Direct Node test run of all six `tests/pg/action-*.pg.test.ts`: **22/22 pass**, zero failures/skips. Covers non-superuser owner provisioning, FORCE/RLS, idempotent concurrency, immutable signers/rows, grants, missing fence, upgrade, and five adjacent owner/application paths.
- Two additional deterministic lock-wait probes: natural token expiry and committed token revocation while action admission waits on the fence both return ACTION_AUTHENTICATION_FAILED; zero request rows. Evidence: `/tmp/atlas-stage3/astra-s3a-lock-auth.json`.
- Three additional defect probes reproduced F1–F3. F4 confirmed against both baseline and the independent Stage 2 normative manifest.
- `git diff --check`: pass. Source/ZIP hashes checked independently. No checkout edits, generation, rebuilds, commits, provider calls, pilot/config access or persistent database operations. Disposable PG17 databases/roles only.
- Implementer logs record all ten required checks successful, including full **339/339 PG** and schema/generation/typecheck/build/smoke/PG17/drift checks. I inspected the compact log summary and model evidence; I did not rerun that entire PG/build suite. Independent logs: `/tmp/atlas-stage3/astra-s3a-unit.log`, `astra-s3a-focused-pg.log`, `astra-s3a-canonical.log`.

A1–A4 source review otherwise supports scoped composite FKs, unchanged digest-gated ApiToken lookup, post-fence reauthentication, exact nullable expiry snapshots, epoch invalidation, idempotency retrieval precedence without renewal/adoption, canonical Unicode handling and safe projections. A5/A6 have F1 outstanding; installed lifecycle shape has F3. R1 focused healthy/missing-fence paths pass, including safe boundary errors and emergency-disable dependency. R2 cannot pass until F4 is restored. Protected-file handling has F2.

The extra ACTION_NOT_FOUND code is a fixed non-disclosing missing/invisible-resource response; ACTION_STATE_CONFLICT is suitable for a derived-ID collision. Validity hints are retrieval-only and do not grant authority. Separate policy/port constants retain the approved actionVersion and become part of the immutable hash. Lowercase UUID syntax is an explicit restriction, with no alias/adoption behavior; preserve it in the future command contract or normalize case deliberately. None of these choices adds a required finding for this checkpoint.

Residual limits: S3-B approval/reservation and S3-C create/verification/recovery/CLI services are unimplemented and unaccepted; later checks must prove requester-expiry caps, claim/attempt atomicity and publication/recovery concurrency when those services exist. Implicit FK key-share deadlocks remain a documented fixed ACTION_DB_CONFLICT, zero pre-dispatch retry path. Arbitrary superuser function-body replacement remains outside supported operation; that exclusion does not cover the extra grants in F1. Per-admission catalog checks have an acknowledged cost. MOCK evidence does not satisfy any LIVE gate.

Repair the four findings as one bounded checkpoint update, rerun affected checks plus the required checkpoint suite, and freeze a new exact artifact. Because the repair affects authorization/readiness and durable claim invariants, renewed acceptance should use a fresh explicit GPT-6 Astra/xhigh review under the project workflow. No dependent checkpoint advancement is accepted by this report.
