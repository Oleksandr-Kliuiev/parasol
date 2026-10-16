# Independent architecture review: Stage 3 S3-design-rc3 (MOCK-only governed ticket flow)

Verdict: **REQUIRED_CHANGES**, bounded to normative text and acceptance additions. No re-architecture is needed. Nothing in the repository was edited, no DB, network, credential or pilot artifact was touched. Model routing evidence is in the message metadata for the orchestrator to verify. Self-identification is not offered as evidence. Earlier reviewer reports in docs/stage3/reviews, REVIEW_STATUS.md and PREPARATION_BRIEF.md were deliberately not read.

## Reviewed artifact identity

| Item | Expected | Observed |
|---|---|---|
| Manifest | S3-design-rc3, baseline 916a4d6, branch planning/stage2-m365 | same, HEAD is 916a4d69853ff6da636e8609a2e0bd33aa787f66 |
| Package hash (8 docs, sorted by path) | dc4c5185…74887 | recomputed identical from working tree and from ZIP entries |
| ZIP SHA256 | 9267c969…1fa7 | match, 8 entries byte-identical to working tree |
| Per-file SHA256 | 8 values in manifest | 8 of 8 match |
| Preserved recorder manifest | sha 60953542…, packageHash a02667ee…, 324 files | manifest sha matches, 324 of 324 files match, aggregate recomputed |
| Preserved Stage 2 normative manifest | sha b88069db…, packageHash 1d3b1064…, 11 files | manifest sha matches, 11 of 11 files match, aggregate recomputed |
| Stage 3 code, schema, migrations | none | none present |

## Findings

**P2-1. Result-publication lock order is unspecified and inverts the admission order.** Admission locks fence → request → approval → attempt → ordinal (03_DATA_AND_CONCURRENCY.md:95). Publication "locks attempt/claim" and then writes the request result (04_EXECUTION_AND_PORT.md:51-58, 66-74). A concurrent action-verify or action-recover against an in-flight publication can deadlock. The victim gets ACTION_DB_CONFLICT with no retry (02_CONTRACTS.md:101-102), so a verified read or a known create fact is discarded while the ordinal stays consumed. Safety holds, liveness and budget do not. Required: one stated order for all post-dispatch publications, request → attempt → ordinal. State that a token-bound publication transaction may be re-attempted a bounded number of times on 40P01/40001 because it performs no port call.

**P2-2. Accepted Stage 1/2 write paths now depend on the fence surface with no regression case and no error mapping.** The BEFORE trigger on Connection, Actor, ClientMembership and ApiToken (03:75-79) fires for bind, Stage 1 activation (packages/sync/activation.ts:38), M365 activation (packages/m365/activation.ts:100), m365-disable (packages/connections/m365-disable.ts:36) and the owner seed. With an incomplete fence these fail, and the accepted code surfaces UNEXPECTED_ERROR (packages/core/contracts.ts:49-51), not ACTION_FENCE_NOT_READY. The emergency local revoke m365-disable becomes unavailable to runtime and owner alike. R1 covers reads only (06_ACCEPTANCE.md:26) and B3 covers only the race (06:15). Required: state the dependency, define the error mapping to a fixed safe code, add a regression row for every listed write path under the runtime role after the upgrade from accepted Stage 2, and note in RUNBOOK that m365-disable availability depends on fence health.

**P3-1. Verification lease expiry is ambiguous.** "BUSY until released or expired" (04:49) conflicts with "only action-recover marks ABANDONED" (04:61-62). Pick one, and add a DB invariant of at most one ACTIVE verification per attempt.

**P3-2. Runtime self-check and PROTECTED_TABLES for action tables.** 03:81-85 lists fence checks only. The new tables must join PROTECTED_TABLES and gain an exact UPDATE-column allowlist like M365_RUNTIME_UPDATE_COLUMNS in packages/graph/runtime-role.ts:25-36, so broad default grants on action tables refuse startup.

**P3-3. Trigger EXECUTE semantics.** EXECUTE is revoked from runtime and PUBLIC (03:63-64) yet the trigger fires on runtime updates (03:75). This works because PostgreSQL checks EXECUTE only at CREATE TRIGGER time. State it, create triggers before ownership transfer, and add the acceptance case.

**P3-4. Fence row immutability for every role.** Make 03:27-28 a BEFORE UPDATE/DELETE trigger: workspaceId unchanged, version = old + 1, DELETE/TRUNCATE refused, including for the definer.

**P3-5. Unicode validation misses C1, format and bidi controls** (01_SPEC.md:33-34). The preview is the approver's only view, so overrides and zero-width characters can render differently from the vendor UI. Reject Cc, Cf, Cs, Co, Cn except LF in description.

**P3-6. Protected file hardening** (02:58-66). Add fchmod to 0600 after exclusive create so umask cannot break the strict input check, and require st_uid equal to the effective uid and st_nlink of 1 on the same descriptor.

**P3-7. Policy/port version drift** (02:76-79). State that the deployed policy/port version must equal the stored one at approve and reserve, with a fixed mismatch code.

**P3-8. Optional DB-level epoch check** on ActionApproval and ActionAttempt insert against the locked fence row. Defense in depth only.

**P3-9. Test observability under FORCE RLS.** No FORCE RLS exists in the repository today. With a non-superuser owner the fixtures cannot read fence or action tables. 05/06 must state the observation path for "zero duplicate create" and "runtime global visibility empty".

**P3-10. FK to ApiToken rows** (03:10, 14, 29) makes referenced tokens undeletable. State that token lifecycle is revoke or replace, never delete, and that Prisma back-relations are schema-file additions only.

## Focus-area assessment

Sound as written: the stored protected preview for an approver without request grant (02:46-49), the token ROW ID plus immutable expiry with the unchanged-epoch proof (02:15-17, 03:37-51, usable through the existing ApiToken_lookup policy with no new policy, view or function), monotonic remove/restore invalidation (02:69-74), the dedicated SECURITY DEFINER fence with exact grants, FORCE policies, search_path, NEW/OLD-derived workspace, row_count guard and owner-then-definer completeness count (03:53-91), reservation commit as the single linearization point with no duplicate create (02:80-82, 04:8-18), durable leases with non-refundable ordinals (04:36-63), explicit APPROVED replay without renewal (02:53-56), candidate mismatch preserving UNKNOWN (04:53-55), the no-follow/fstat readers (02:58-66), full fence before requests (05:14-15), and Stage 1/2 contract preservation. Arithmetic checks pass: marked title fits 240, UUIDv8 retains 122 bits, recovery at 35 seconds equals start plus create plus grace.

## Required acceptance cases to add

1. Concurrent verify/recover against an in-flight publication never loses a result, and publication re-attempts make zero port calls.
2. Bind, Stage 1 activation, M365 activation, m365-disable and owner seed succeed under the runtime role with a healthy fence and fail closed with a fixed code when the fence is incomplete.
3. Runtime Connection UPDATE fires the fence trigger with EXECUTE revoked, and direct invocation is refused.
4. Fence version decrease, skip, workspaceId change, DELETE and TRUNCATE are refused for all roles.
5. The DB enforces one ACTIVE verification per attempt.
6. Startup refuses broad default UPDATE on every action table.
7. C1, Cf and noncharacters are rejected in title and description.
8. Protected files survive a restrictive umask, and foreign-owner or hard-linked input is rejected.
9. Policy/port drift between request and approve or reserve never executes.
10. Non-superuser owner mode proves the mock-ticket count and empty runtime visibility through the stated path.

## Residual risks

Workspace-wide invalidation causes friction in busy workspaces, acknowledged at 01:45-47. VERIFIED may name a non-Atlas duplicate when an exact-marker candidate matches first, audited by design. A DB conflict at create-result publication after a crash can leave a real ticket as permanent UNKNOWN unless reconciled. The preview file proves content equality, not human attention. No purge of private MOCK content. Candidate reconciliation is reachable only through fault-injection tests. This review executed no tests, so every "sound" statement is about normative text and its fit with the baseline source. No code or real-write approval follows from this architecture assessment.

The full report is also saved at /Users/oleksandr/.claude/plans/independent-fresh-read-only-architecture-tingly-sonnet.md.