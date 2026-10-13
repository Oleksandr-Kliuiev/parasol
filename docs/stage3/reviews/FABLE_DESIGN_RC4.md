## Independent architecture review: S3-design-rc4

**Reviewer:** Claude Fable 5.1 (`claude-fable-5-1`), effort high, native subscription. Fresh context. I did not read any other reviewer report, REVIEW_STATUS, preparation brief or review history. Read-only: no edits, no DB, no network.

**Verdict: APPROVED** for the MOCK-only governed ticket architecture as a whole. Findings below are contract precisions to fold into the S3-A brief. None changes authority, data boundaries, atomicity or public contracts. No code, test, migration, LIVE or real-write approval is implied.

### Reviewed artifact identity

All checks were recomputed independently with Python over the manifest, ZIP and disk.

| Item | Result |
|---|---|
| Manifest version / baseline | S3-design-rc4, baseline 916a4d6, branch planning/stage2-m365 |
| 8 docs: disk == manifest == ZIP entry | all match |
| Aggregate hash (sorted by path) | e2d574185b53f28b5fc25f039a1b8c3df2cc7111133077fca2b4318809364d3c, match |
| ZIP SHA256 | 8c07c235133f453b90c766793c40aa836aa0e1280666d0156e55f0838497eaa2, match |
| Preserved recorder set | manifest sha matches, 324 files present and hash-equal, aggregate matches |
| Preserved Stage 2 normative set | manifest sha matches, 11 files present and hash-equal, aggregate matches |

The working tree is dirty, but every manifest-listed file equals its recorded hash.

### Findings, prioritized

- **P2-1 Unbounded AWAITING_APPROVAL lifetime.** `docs/stage3/01_SPEC.md:37` bounds only the approval TTL. The EXPIRED transition in `docs/stage3/02_CONTRACTS.md:46` and `04_EXECUTION_AND_PORT.md:6` resolves only to signer token expiry, and null means never (`03_DATA_AND_CONCURRENCY.md:52`). A pending request from a non-expiring token stays approvable indefinitely while the epoch is unchanged. Define a request admission TTL committed as EXPIRED at the next fenced touch, or state the unbounded window as an explicit decision.
- **P2-2 TRUNCATE hole in the epoch proof.** `03:49` and `03:82` rely on row-level BEFORE triggers. TRUNCATE fires no row triggers. Action-table FKs only block TRUNCATE where referencing rows exist, and ClientMembership is never referenced. An owner TRUNCATE of ClientMembership leaves the epoch equal while memberships vanish. Add statement-level BEFORE TRUNCATE refusal on Actor, ClientMembership, ApiToken and Connection, as the fence already has at `03:38`, and include it in startup checks.
- **P3-3 Runtime fence policy command unspecified.** `03:28-29` and `03:34-35` say "workspace policy" without a command. Under RLS, SELECT FOR UPDATE also applies UPDATE policies. A SELECT-only policy returns zero rows and every admission becomes ACTION_FENCE_NOT_READY. Specify FOR ALL or SELECT plus UPDATE with USING on workspace. The trigger at `03:37` still refuses every runtime UPDATE.
- **P3-4 Startup trigger inventory incomplete.** `03:90-91` lists four mutation triggers plus Workspace insert/delete triggers. Not listed: the fence self-guards and the Workspace identity-move refusal from `03:79`. Note that the Actor workspace FK is ON UPDATE CASCADE in migration 202610071600 line 48. A6 tests these, readiness does not check they are enabled.
- **P3-5 In-transaction re-authentication is an adjacent change to accepted auth.** `02:15-17` and `03:46` require repeating bearer auth inside the fenced transaction. The accepted function in `packages/auth/prisma-auth.ts:12` opens its own transaction. S3-A needs a transaction-scoped variant that preserves the GUC clearing sequence at lines 15 to 22 and the zero-token-row invariant in `tests/sql-invariants.ts:198-206`. Name it in the S3-A integration delta.
- **P3-6 Length and validation order ambiguity.** `01:33-35` validates raw scalars before NFC and trim but does not say whether the 160 and 2000 scalar counts apply to the stored normalized form. Specify counts on the final stored text and a cheap post-NFC re-validation.
- **P3-7 roles.sql shape guard.** `03:88` extends roles.sql. The test renderer in `tests/support/roles-sql.ts:35,41` throws on token-count change. Record in S3-A that the helper must grow a fourth role deliberately, not be loosened.

### Checks that pass as specified

Every item in the review brief is present and consistent across the eight docs. Specifically: exact stored preview exportable with read-only grant (`02:49`); token ROW ID plus immutable nullable expiry snapshots with no digest and no new ApiToken policy, view or function (`02:16-17`, `03:44-47`), consistent with the accepted lookup policy in migration 202610071600 lines 73 to 81; the unchanged-epoch plus DB-clock proof (`03:49-55`); monotonic remove-and-restore invalidation (`02:73-76`); dedicated SECURITY DEFINER role, ACL, FORCE policies, search_path, trigger-creation EXECUTE semantics, row_count guard and no GUC use in the trigger (`03:60-86`); provisioning completeness through owner Workspace count then SET LOCAL ROLE definer count (`03:95-97`), valid because Workspace is ENABLE rather than FORCE RLS so the owner count is global; single dispatch linearization at reservation commit with a unique lifetime attempt (`02:84-86`, `03:17`, `04:8-10`); durable read leases with ordinal 1 as the initial read, 35 second grace, partial unique ACTIVE row and explicit recover (`04:23-24`, `04:45-66`); candidate mismatch preserving UNKNOWN per ordinal (`04:55-57`); late original versus candidate ordering (`04:69-81`); publication lock order request to attempt to ordinal with three same-fact retries on 40P01 and 40001 and zero port calls (`02:106-108`, `04:70-73`); privacy and fixed codes (`02:96-111`); protected file export and input with no-follow, fstat on the same descriptor, fchmod 0600, effective uid, link count 1, size cap and checkout refusal (`02:58-68`); deployed policy and port version checks (`02:81-83`); explicit APPROVED replay without renewal (`02:53-56`); scoped FOR UPDATE admission and default-grant refusal (`03:91-98`, consistent with the default privileges at `prisma/roles.sql:113`); accepted bind, activation, M365 activation, m365-disable and owner-seed fence dependency with error mapping and RUNBOOK note (`02:109-110`, `03:117-120`, `05:17-18`, R1); emergency disable failing closed under a corrupt fence (`03:118-120`); runtime-scoped FORCE observation (`03:122-124`); token retention (`03:31-32`); Unicode categories (`01:33-35`); full fence in S3-A before any request (`05:14-15`); legacy Approval inert; permissions CHECK extension matching the pattern in migration 202610081000 lines 51 to 54.

Lock-order analysis holds. Admission takes fence, request, approval, attempt, ordinal. Publication takes request, attempt, ordinal and never the fence. Owner and Connection mutators hold their own row then the fence through the trigger. Admission never locks Connection or auth rows, so no cycle exists. The m365-disable path in `packages/connections/m365-disable.ts:29-37` waits on an in-flight admission and commits after it. The earlier reservation stays linearized and later verification admissions refuse on binding drift, matching `02:85-86` and `03:104-108`.

### Required acceptance cases to add

1. Pending request TTL, or the explicit unbounded decision, with a null-expiry requester token.
2. Owner TRUNCATE on each fenced table is refused and the epoch is unchanged after refusal.
3. Runtime FOR UPDATE on the fence returns exactly its workspace row under RLS. A runtime UPDATE with unchanged values is refused by the trigger.
4. Readiness fails when any fence self-guard or Workspace update/delete trigger is disabled or missing.
5. Token revoked or rotated between CLI pre-auth and fence lock yields a fixed code, zero request rows, and the token GUC is cleared before any non-token read in the same transaction.
6. Lengths enforced on normalized and trimmed text, with post-NFC re-validation.
7. Approval expiry equals the minimum of now plus 15 minutes and both signer snapshots. Null snapshots yield 15 minutes.
8. A late original create fact after recovery to UNKNOWN upgrades to CREATED_UNVERIFIED. NOT_DISPATCHED never receives one.
9. Workspace insert then Actor insert in one owner transaction succeeds. Two workspaces yield two fences with equal counts under the definer role.
10. m365-disable concurrent with a held admission waits and commits version plus one. The earlier reservation remains valid and the next verification admission refuses binding drift.
11. roles.sql rendering with four roles passes the shape guard and unique-name rendering.

### Residual risks

- Emergency m365-disable is unavailable under a corrupt fence. Only offline reviewed repair exists.
- Any auth or Connection mutation invalidates every pending action in the workspace. A connections:manage actor can trigger this at will, since disabling an already disabled connection still increments the version.
- Fence FOR UPDATE serializes previews and requests per workspace and briefly blocks owner auth writes and Connection lifecycle updates.
- Exported preview files hold private content on operator disks with 0600 mode and no retention control.
- The mock port cannot exercise real network or timeout semantics. LIVE remains a separate gate.
- Prisma back-relations touch accepted schema files without a DB change. The drift check must stay empty.
- Unicode data version drift across Node versions affects unassigned-category classification at input time only.

The same report is saved at `/Users/oleksandr/.claude/plans/independent-fresh-read-only-architecture-async-pudding.md`. Model routing evidence must be taken from the assistant-message metadata, not from this text.