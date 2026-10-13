# Independent architecture review — S3-design-rc2

Read-only session. No files edited (except this reviewer's plan note), no DB, network, credentials, tests or pilot touched. No earlier reviewer reports or verdicts were read. Model routing is for the orchestrator to verify from message evidence, not from this text.

## Reviewed artifact identity

Every hash was recomputed independently and matches the manifest.

| Item | Result |
|---|---|
| Manifest `verification/stage3/S3_DESIGN_RC2_MANIFEST.json`, version S3-design-rc2, baseline 916a4d6 | read |
| ZIP SHA256 `d9bb342c…21d264` | match |
| Aggregate package hash `1c715ed4…f1521` (8 UTF-8 entries, sorted by path) | match, both from working tree and from ZIP contents |
| Per-file SHA256 of 01–06, AGENTS.md, README.md | 8 of 8 match; ZIP contents byte-identical to working tree |
| Preserved recorder manifest (sha `60953542…1971`, package `a02667ee…03e3`) | manifest sha match; 324 of 324 files match on disk; aggregate recomputed from disk matches |
| Preserved Stage 2 normative manifest (sha `b88069db…3577`, package `1d3b1064…1efb`) | manifest sha match; 11 of 11 files match; aggregate recomputed from disk matches |

## Verdict: REQUIRED_CHANGES

The changes are bounded and document-only. No structural redesign is needed. The core architecture is sound: dedicated SECURITY DEFINER fence role under FORCE RLS, monotonic epoch invalidation, stored token row IDs with a narrow lookup policy, reservation commit as the single linearization point, durable verification leases, late-result ordering, privacy whitelist, and the S3-A full-fence precondition all cohere and stay compatible with the preserved Stage 1 and Stage 2 contracts. Three P2 items are normative contradictions or ambiguities that would be baked into S3-A and S3-C contracts if implemented as written.

## Findings

**P2-1. The startup fact "one fence per workspace" cannot be computed by the runtime** (`docs/stage3/03_DATA_AND_CONCURRENCY.md:70-72`). The fence runtime policy is workspace-scoped and the Workspace policy is GUC-scoped. At startup no GUC is set, so the runtime sees zero rows of both tables and any count comparison passes vacuously. Fix: drop it from startup facts, keep the per-admission check (line 61 and 65), and add an owner-side check in roles.sql. The owner counts Workspace rows (ENABLE-only RLS, owner bypasses) and counts fence rows under SET LOCAL ROLE to the definer, whose policy is USING true.

**P2-2. Fence lock mode is unspecified, and acceptance A3 depends on it** (`03_DATA_AND_CONCURRENCY.md:22,26,77`; `06_ACCEPTANCE.md` A3). "Runtime locks via UPDATE(workspaceId) privilege" does not say FOR UPDATE, FOR SHARE, or a no-op UPDATE. FOR KEY SHARE would not block the trigger's version update. A no-op UPDATE produces dead tuples. With FOR SHARE, two concurrent requests with the same key race on the unique index and one receives SQLSTATE 23505, which the contract never maps. Fix: mandate SELECT … FOR UPDATE on the fence row for every admission transaction, or define 23505 as idempotent retrieval.

**P2-3. VERIFICATION_MISMATCH conflates a wrong operator candidate with a wrongly created ticket** (`04_EXECUTION_AND_PORT.md:39-41,51`; `01_SPEC.md:43-44`). For an UNKNOWN attempt, a wrong candidate ID completes MISMATCH "with VERIFICATION_MISMATCH request outcome", which erases the fact that the create outcome is still unknown. Whether MISMATCH is terminal and whether remaining ordinals may still verify is unstated. "One supplied candidate ID per reservation" is ambiguous between attempt and ordinal. Fix: a candidate mismatch records ordinal MISMATCH and retains the request outcome. Only an original-ID mismatch yields VERIFICATION_MISMATCH. State terminality and the per-ordinal candidate rule.

**P3-1. Error code inconsistency** (`02_CONTRACTS.md:89-94` vs `04_EXECUTION_AND_PORT.md:15,57`). 02 defines ACTION_NOT_DUE, 04 uses ACTION_RECOVERY_NOT_DUE. ACTION_AUTHENTICATION_FAILED (02:17) and UNEXPECTED_ERROR are absent from the fixed list.

**P3-2. Permission vocabulary migration is not named** (`02_CONTRACTS.md:4`; `03_DATA_AND_CONCURRENCY.md:3`). The membership CHECK is a vocabulary extended by migration each stage, most recently in `202610081000_stage2_m365_directory/migration.sql:51-54`. The four actions permissions need a new DROP/ADD CONSTRAINT migration listed in S3-A scope.

**P3-3. Token-row revalidation column limit is code discipline, not DB-enforced** (`03_DATA_AND_CONCURRENCY.md:36-38`). The runtime holds table-level SELECT on ApiToken (`prisma/roles.sql:92`), and baseline auth filters on the hash column (`packages/auth/prisma-auth.ts:18`), which needs SELECT on it. Either state the limit is code-level, or as optional hardening switch the bearer lookup to policy-only filtering and revoke SELECT on tokenHash and label from the runtime.

**P3-4. Approval input file read lacks TOCTOU rules** (`02_CONTRACTS.md:59`). The export side specifies O_EXCL and O_NOFOLLOW. The input side should open with O_NOFOLLOW and fstat for regular file, mode 0600 and size before reading.

**P3-5. Recovery to UNKNOWN only from RESERVED** (`04_EXECUTION_AND_PORT.md:14-15`). Line 57 says this for claims. Say it for create recovery too, so a published CREATED_UNVERIFIED is never downgraded.

**P3-6. Default-privileges window** (`03_DATA_AND_CONCURRENCY.md:25-27`; `prisma/roles.sql:113`). ALTER DEFAULT PRIVILEGES gives the runtime INSERT and UPDATE on every new table, including fence version, until roles.sql re-runs. Make the exact fence expectation (no INSERT, UPDATE only on workspaceId) an explicit startup fact and part of A5.

## Confirmed sound

- **Definer surface.** NOLOGIN, NOINHERIT, NOBYPASSRLS, no relation ownership, PG16+ ADMIN-only creator link, RETURNS trigger so not directly callable, EXECUTE revoked from PUBLIC and runtime. Trigger firing does not re-check EXECUTE, so Connection mutations by the runtime still increment. Workspace derives from NEW/OLD only, row_count must equal 1, and the function fails closed before roles.sql transfers ownership.
- **Lock order.** Fence, then plain auth reads, then request, approval, attempt, ordinal. FK KEY SHARE locks on Connection and Actor are compatible with non-key owner updates. Delete or key-update cycles map to ACTION_DB_CONFLICT as specified.
- **Existing Connection triggers compose.** A mutation rejected by Connection_binding_immutable or Connection_lifecycle_version rolls back the fence increment atomically.
- **Approval.** Preview is rendered from the immutable row. The whitelist excludes customer key, secretRef and token IDs. The approver needs only read, approve and context. Hash plus full-field compare, with self-approval refused at the DB.
- **Dispatch.** Reservation commit is the linearization point, one unique attempt per request, recovery never re-POSTs, late original ID versus candidate rules preserve VERIFIED facts.
- **Compatibility.** Legacy Approval stays inert, Gateway write denial unchanged, ClientContextV1 untouched, frozen migrations preserved.

## Required acceptance cases to add

1. Two concurrent action-request calls with the same key yield one row and one idempotent retrieval, with no 23505 or UNEXPECTED_ERROR.
2. Fresh deploy without roles.sql: runtime startup refuses because the fence has runtime INSERT or version UPDATE. After roles.sql it passes.
3. Owner-side fence-count check fails on a missing fence row, and admission for that workspace returns ACTION_FENCE_NOT_READY.
4. A Connection update rejected by the existing immutability trigger leaves the fence version unchanged. An accepted no-op update increments it.
5. A wrong candidate on UNKNOWN keeps the request UNKNOWN, records ordinal MISMATCH, and a remaining ordinal can still VERIFY.
6. Approver membership granted after the request invalidates the request, documenting the conservative rule.
7. Approval input that is a symlink, oversized, wrong mode or non-regular yields a fixed refusal and no mutation.
8. Admission concurrent with m365-disable on the bound Connection yields a deterministic ACTION_DB_CONFLICT or INVALIDATED with zero port calls.
9. A wrong-workspace GUC in a runtime transaction cannot read or lock another workspace's fence.

## Residual risks

- The fence row is a per-workspace mutex for all admissions and all auth or Connection mutations. This affects throughput, not safety.
- The conservative epoch rule invalidates every pending request on any auth or Connection mutation in the workspace.
- actions:read permits export of private title and description via the preview file. Candidate IDs appear on the command line.
- The 5-second permit window is process-clock. A stalled process may create late, but still only once, published via the original token.
- A human-initiated duplicate through a new idempotency key after UNKNOWN is not prevented. A validity hint would help.
- MOCK success proves nothing about Atera wire semantics, idempotency, notifications or retention, as section 04 already states.

No code approval, migration approval or real-write approval is implied by this assessment. The full report is also saved at `/Users/oleksandr/.claude/plans/independent-fresh-read-only-architecture-cheeky-oasis.md`.