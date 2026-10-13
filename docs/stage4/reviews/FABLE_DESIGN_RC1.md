# Stage4 architecture review RC1

**Verdict: CHANGES_REQUIRED** for the exact artifact below. The architecture is bounded, privacy-safe and consistent with the installed Stage 1/2/3 contracts in almost every respect. Two normative statements in 03 contradict each other or the installed PostgreSQL fence semantics in a way an implementer cannot resolve without deviating from the frozen text, and acceptance gate A3 tests "exact" privileges against that text. A small RC2 edit set resolves them. No new scope is required.

## Artifact verification

| Item | Expected | Observed |
|---|---|---|
| Manifest SHA-256 | 9c8724f3…2259 | match |
| Package hash (8 files, UTF-8 sorted rule) | 0553b356…3175 | recomputed, match |
| ZIP SHA-256 | d24ff043…33b5 | match; 8 entries, 0 mismatches vs checkout |
| Baseline SHA-256 | 6a9a1202…74a8 | match |
| Baseline files | 645 | 645 present; 642 byte-exact; 3 changed |
| Changed files | AGENTS.md, docs/AI_CONTEXT_MAP.md, docs/DEVELOPMENT_WORKFLOW.md | exactly those 3; after-hashes match manifest |
| HEAD / branch | 916a4d69…7f66 / planning/stage2-m365 | match |
| Installed migrations | 20 + lock | 20 directories + migration_lock.toml |

Manifest states codeTests NOT_RUN and LIVE DEFERRED_BY_OWNER. No implementation, tests, generators or writes were performed by this review.

## Method

Read all eight normative docs. Read only the adjacent source needed for concrete contract questions: the Stage 3 fence migration and roles.sql routine ACL section, fence-role.ts, runtime-role.ts, the Stage 3 fenced admission in packages/actions/authority.ts, packages/auth/authority.ts and token.ts, connections.ts, tool-policy.ts, the Stage 2 maintenance runner and its role check, the Stage 2 cleanup routine header, the membership permission CHECK history, the Connection/ApiToken/SecurityAuditEvent models, and the audit metadata allowlist. No other reports, status files, pilot folders or credentials were read.

## Findings

### P2-1. Lock order "fence → Connection FOR SHARE" inverts the installed Stage 3 trigger order and is deadlock-prone

**Where:** docs/stage4/03_DATA_AND_CONCURRENCY.md:34, :84, :87; docs/stage4/04_PORT_AND_SYNC.md:43.

**Problem.** The installed fence trigger (migration 202610091000_stage3_action_fence) fires BEFORE ROW on Connection UPDATE/DELETE. PostgreSQL locks the target tuple before a BEFORE ROW trigger runs, so any Connection mutation holds the Connection row lock and then waits for the fence row. Stage 4 prescribes the opposite order for every new transaction: fence FOR UPDATE, then Connection FOR SHARE. A concurrent UPDATE of that same Connection row (a disable, a provenance repair, any owner maintenance) and a Stage 4 admission wait on each other and PostgreSQL aborts one with 40P01. The outcome is fail-closed, but the document presents this as a deadlock-free lock order, and admission "does not automatically retry", so an operator sees POWEROFFICE_DB_CONFLICT with no explanation.

The Connection row lock is also unnecessary. The migration comment states the fence contract: "An unchanged version therefore proves that no auth/binding row of that workspace changed." Holding the fence row FOR UPDATE already guarantees that no Connection change of the workspace can commit during the transaction, so a plain scoped SELECT of status, lifecycleVersion, externalTenantId, secretRef-shape and boundBy after the fence lock is stable for the whole transaction.

**Required change.** Either remove Connection FOR SHARE from the normative lock order and specify "scoped SELECT of the binding after the fence lock", or keep it and (a) state the inversion relative to the installed fence trigger explicitly, (b) name the fixed outcome, (c) grant the privilege required by P2-2.

**Required acceptance (B2/B4/C3).** Concurrent transaction performing UPDATE on the same PowerOffice Connection row while a sync admission, a publication and a cleanup call are in flight: no partial effects on either side, fixed codes only, and the next explicit command observes the new lifecycleVersion and refuses with POWEROFFICE_BINDING_CHANGED or UNAVAILABLE.

### P2-2. Maintenance definer privilege list cannot perform the lock order it is required to follow

**Where:** docs/stage4/03_DATA_AND_CONCURRENCY.md:84-87 vs :34.

**Problem.** Line 84 gives the dedicated definer "Connection/fence scoped SELECT, fence UPDATE(workspaceId) … solely for SELECT FOR UPDATE locking". Line 87 requires the function to "acquire the existing fence first" and line 34 says maintenance takes "the same order", which includes Connection FOR SHARE. PostgreSQL requires UPDATE privilege on at least one column for FOR SHARE as well as FOR UPDATE. The document already applies that rule for the fence row, and the accepted Stage 2 definer holds UPDATE(id) on Connection for exactly this reason (roles.sql line 165, runtime-role.ts DEFINER_COLUMN_PRIVILEGES). As written, the routine either cannot take the Connection lock or the roles provisioning must grant something A3 declares forbidden. The same gap applies to "Attempt FOR UPDATE (if involved)": the definer has attempt SELECT/DELETE only. DELETE takes its own row lock, so that case only needs clarifying, not a grant.

**Required change.** Make the definer's exact privilege list and the maintenance lock sequence consistent. Recommended: resolve P2-1 by dropping the Connection row lock for all Stage 4 transactions, and state that the definer locks fence (UPDATE(workspaceId)), then State (pointer-column UPDATE), then deletes attempts/snapshots without a separate FOR UPDATE.

**Required acceptance (A3/C3).** The extended runtime role check and the new runner-perspective check must assert the final list exactly, and a disposable-DB test must prove the routine completes its lock sequence under that list with no 42501.

### P2-3. "FORCE policies dedicated to that role and parameters" is not implementable as stated

**Where:** docs/stage4/03_DATA_AND_CONCURRENCY.md:78, :85; the fence policy in migration 202610091000 ("workspaceId" = atlas_app_workspace()).

**Problem.** Row-level security policies cannot see function parameters. The installed fence policy is PUBLIC-scoped on the app.workspace_id setting, and fence-role.ts requires exactly two policies on the fence table, so the definer's fence lock only works if app.workspace_id is set in its transaction. The document says the routine "takes validated workspace/client/connection and DB time only" and that policies are dedicated to "that role and parameters", without saying how the parameters reach the policies. Stage 2 resolved this by having the runner connection set app.* transaction-locally before the call (packages/m365/maintenance.ts:125-127), and the routine reads them through the PUBLIC invoker helpers.

**Required change.** Specify one mechanism: either the routine sets app.workspace_id and app.client_ids transaction-locally from its validated arguments before any lock, or the runner connection sets them as in Stage 2 and the routine validates they equal its arguments. State that the definer's dedicated policies on the new tables use those settings plus the connection argument, and that the fence table receives no new policy.

**Required acceptance (A2/C3).** As the definer with empty or foreign app settings, every new table returns zero rows and the fence lock refuses; parameters naming another client or a non-PowerOffice connection are refused inside the function with a fixed code and zero row effects.

### P3-1. PUBLIC EXECUTE on new routines must be revoked inside the migration, and a CHECK-level validator needs an explicit runtime grant

**Where:** docs/stage4/03_DATA_AND_CONCURRENCY.md:8-9, :26, :82; roles.sql §4b/§5; fence-role.ts FENCE_SHARED_INVOKER_ROUTINES.

**Problem.** roles.sql §5 and every Stage 3 admission fail if the fence definer can execute any PUBLIC or SECURITY DEFINER routine outside the frozen shared list. The design correctly keeps that list unchanged, but if the revoke happens only in roles.sql, provisioning fails at its own §5 check. A separate detail: "Aggregate JSON validation in … SQL" done through a non-trigger helper called from a CHECK constraint executes with the inserting role's privileges, so revoking PUBLIC requires an explicit GRANT EXECUTE to the runtime, and only the runtime.

**Required change.** State that every new routine revokes PUBLIC in its own migration, that the aggregate validator is either a trigger function or an explicitly runtime-granted helper, and that no new entry joins the shared invoker list.

**Required acceptance (A3/R2).** Immediately after deploying the Stage 4 migrations and before rerunning roles.sql, the fence readiness query reports zero routine violations; after roles.sql, the runtime can insert a snapshot and the fence definer cannot execute any new routine.

### P3-2. Read-view status precedence is underdetermined

**Where:** docs/stage4/04_PORT_AND_SYNC.md:43-48; docs/stage4/02_CONTRACTS.md:64-65.

**Problem.** The rules are individually clear but overlap: a purged prior success (EXPIRED from lastSuccessAt) followed by a failed refresh (ERROR); an unexpired snapshot with an ACTIVE refresh past deadline; an expired-but-unpurged snapshot while the latest attempt FAILED. "FRESH when … latest attempt is not FAILED/ABANDONED" also needs the ACTIVE case stated.

**Required change.** Add a decision table over (binding valid, snapshot pointer present, snapshot expired, lastSuccessAt present, lastAttempt state, age) with one status per row and stated precedence (UNAVAILABLE > EXPIRED > ERROR > MISSING; FRESH/STALE only with an unexpired snapshot).

**Required acceptance (C2).** One test per table row with stored DB-clock comparisons, including the purged-then-failed and expired-then-ACTIVE cases.

### P3-3. Recovery boundary and no-ACTIVE recovery result

**Where:** docs/stage4/03_DATA_AND_CONCURRENCY.md:43-44 ("at deadlineAt or later") vs docs/stage4/04_PORT_AND_SYNC.md:33 ("after startedAt+80s"); 06 B5 (">=80s").

**Problem.** Three phrasings of the same boundary. Also undefined: recover when no ACTIVE attempt exists (for example after an ambiguous commit that actually succeeded, which the design correctly does not retry). The operator needs a fixed, non-mutating outcome.

**Required change.** Fix the comparison as DB clock >= deadlineAt, and define recover with no ACTIVE attempt as a fixed code with zero effects and no client audit (or an explicit no-op audit, chosen once).

**Required acceptance (B5).** Recover at deadlineAt - 1s refuses RECOVERY_NOT_DUE; at deadlineAt succeeds; recover after a committed publication returns the fixed code and changes nothing.

### P3-4. Reads take the workspace fence FOR UPDATE and State FOR UPDATE, and the state-initialising write is not limited to sync

**Where:** docs/stage4/03_DATA_AND_CONCURRENCY.md:34, :40; docs/stage4/04_PORT_AND_SYNC.md:43.

**Problem.** Every status and summary read serialises with every other PowerOffice read and with every Stage 3 action admission in the workspace, through the single fence row. This is safe but is a liveness cost that is not acknowledged. Separately, "Initialize the state with ON CONFLICT DO NOTHING" under "all new transactions" would make reads write.

**Required change.** Limit State initialisation to sync admission. For reads, either state the serialisation explicitly as accepted, or specify FOR SHARE on the fence row (permitted by the runtime's UPDATE(workspaceId) grant and still blocked by any auth mutation) and State FOR SHARE.

**Required acceptance (C2/B2).** Status and summary reads never insert or update any row; a read concurrent with a publication observes either the old or the new snapshot, never a pointer/snapshot mismatch.

### P3-5. Maintenance routine bounds need lock_timeout and DB-side purge predicates for every role

**Where:** docs/stage4/03_DATA_AND_CONCURRENCY.md:89-96.

**Problem.** "Max 10s transaction" is stated; lock wait is not, and a fence wait can consume the whole budget. Stage 2 also enforces the expiry and reference predicates in row triggers so "even a direct call deletes nothing unexpired"; Stage 4 states snapshot immutability but not a DELETE guard.

**Required change.** Specify statement_timeout and lock_timeout values for the runner transaction, and BEFORE DELETE guards on snapshot (expiresAt <= DB clock, not referenced by State) and attempt (terminal, older than 30 days, unreferenced) that apply to all roles including the definer.

**Required acceptance (C3).** A direct definer-role DELETE of an unexpired snapshot or an ACTIVE attempt is refused by the trigger; a lock wait longer than the configured lock_timeout rolls back with the fixed timeout code and zero effects.

### P3-6. Audit metadata allowlist is a shared file and counts are already allowlisted

**Where:** docs/stage4/02_CONTRACTS.md:77-79; packages/audit/sanitize.ts allowlist.

**Problem.** The allowlist is global. attemptId, snapshotId, sequence and outcome are new keys and must be added there; existing count keys (deletedAttempts and similar) exist and must not be populated by PowerOffice cleanup, which the design forbids. The design should name this file as in-scope for S4-A and state the no-count rule as a test.

**Required acceptance (C3/C4).** Privacy capture proves PowerOffice audit rows contain only the six allowlisted keys and no numeric count or amount.

## Confirmed sound against installed contracts

- **Fresh bearer after last locks.** Matches the accepted Stage 3 pattern in packages/actions/authority.ts (hash-only lookup, digest cleared, clock_timestamp after the fence lock, one-membership all-of, single workspace SecurityAuditEvent on denial, audit-failure fixed code). Extracting currentToken verbatim is a mechanical refactor; A4 regression is the right gate.
- **No ActorDTO or ApiToken policy expansion.** No new grants on Actor, ClientMembership or ApiToken; runtime already has INSERT/UPDATE revoked on them.
- **Permission vocabulary.** The additive CHECK replacement follows the exact precedent of migrations 202610081000 and 202610091000; memberships are not rewritten.
- **Connection compatibility.** 'poweroffice' is already in the Connection system CHECK and the System type; binding patterns accept the fixed synthetic format; BINDABLE_SYSTEMS remains unchanged. The required refusal in resolveConnection is correct and necessary, since READABLE_STATUSES currently includes FIXTURE.
- **Tool policy.** decideToolCall is already all-of on one membership; a new read-only tool with ['context:read','poweroffice:read'] fits without policy changes.
- **Runner pairing and post-revocation boundary.** Matches packages/m365/maintenance.ts exactly, including the documented residual gap.
- **Arithmetic bounds.** 10000 × 15-digit amounts give at most 19 integer digits; counts, page and byte caps are mutually consistent.
- **Role count.** roles.sql asserts exactly five distinct roles; the design's "two new maintenance roles" correctly implies extending that assertion and the renderers, not weakening them.

## Residual risks and LIVE open issues

- Attempt.actorId FK with RESTRICT plus indefinite retention of last-attempt metadata means an Actor row referenced by a PowerOffice attempt can never be deleted; consistent with the Stage 3 ApiToken precedent but should be stated.
- Europe/Oslo business date requires IANA time-zone data in the runtime; acceptance A1 should include a DST-transition date computed through the chosen library, not a hand-written offset.
- Per-page fenced admission means up to 100 fence acquisitions per sync in 60s; the deadline model absorbs pool and lock waits as designed, but throughput in a busy workspace is unmeasured.
- Known-rollback retry (40P01/40001) is harmless under READ COMMITTED but will mostly be exercised by the P2-1 inversion unless that is removed.
- All LIVE gates in 04 remain open and correctly scoped: v2 contract, company proof, balance/credit/currency semantics, completeness, replication freshness, retention admission. MOCK evidence must not be presented as any of these.

## Checkpoint and matrix notes

The S4-A/B/C split and the D1/A/B/C/R gates cover the requested invariants. The acceptance cases listed above should be added to A2, A3, B2, B4, B5, C2 and C3 before S4-A starts. The eight-file package is the right unit; after the RC2 edits both independent gates must re-cover the new hash before implementation.