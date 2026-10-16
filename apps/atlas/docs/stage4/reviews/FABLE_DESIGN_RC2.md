All checks done. I'm now writing the final report; no further reads are needed.

# Stage4 architecture review RC2

**Verdict: APPROVED** for the exact artifact below, with five non-blocking clarifications (P2/P3) that must be carried as binding statements into the S4-A/S4-C task briefs and acceptance cases. No finding requires a normative text change or breaks safe implementability of the MOCK architecture. LIVE remains deferred and untouched by this verdict.

Reviewer: native Claude Fable 5.1, explicit high effort, fresh session, read-only, no subagents, no other reports read. Model/provider evidence is collected separately and is not claimed here.

## Artifact identity and verification

All hashing done with Python, counts and mismatches only.

| Item | Expected | Result |
|---|---|---|
| `verification/stage4/S4_DESIGN_RC2_MANIFEST.json` SHA-256 | 43f86a7e…c7230 | match |
| Manifest `packageHash` (8 files, UTF-8 sorted rule) | d848b026…4873ec | recomputed, match, 0 file mismatches |
| `verification/stage4/S4_DESIGN_RC2_PACKAGE.zip` SHA-256 | b96c15c7…6059 | match; 8 entries, 0 differ from tree |
| `verification/stage4/S4_DESIGN_BASELINE.json` SHA-256 | 6a9a1202…374a8 | match; 645 files |
| Baseline preservation | 642 byte-exact, 3 routing deltas | 642 preserved, 3 routing deltas verified before/after, 0 unexpected |
| HEAD / branch | 916a4d69… / planning/stage2-m365 | match |
| Accepted S3C-rc2 package in manifest | 212005fd…521b | match |
| Stage2/3 normative docs, installed migrations | 19 docs, 20 migrations + lock | 10 + 14 files present (19 normative plus status/brief files), 20 migration dirs + lock present and in baseline |

The eight normative docs reviewed in full: `docs/stage4/{AGENTS,README,01_SPEC,02_CONTRACTS,03_DATA_AND_CONCURRENCY,04_PORT_AND_SYNC,05_IMPLEMENTATION_PLAN,06_ACCEPTANCE}.md`. Adjacent source was read only for named dependencies: the Stage 3 fence migration, `packages/actions/authority.ts`, `packages/auth/{authority,prisma-auth}.ts`, `packages/audit/sanitize.ts`, `packages/graph/{fence-role,runtime-role}.ts`, `prisma/roles.sql`, `apps/api/src/db/auth.ts`, `packages/connections/connections.ts`, the M365 cleanup migration, and the relevant Prisma models. No pilot folders, settings, credentials, DB or network were touched.

## Assessment against the installed baseline

**Financial permissions, tables, API/CLI, exclusion from generic context/AI/Gateway.** Sound. Three new permissions join the existing `ClientMembership_permissions_check` by the established DROP/ADD pattern (last rewritten in `prisma/migrations/202610091000_stage3_action_fence/migration.sql:16-20`), so "additive migration, no membership expansion" is implementable. Dedicated tables with scoped Connection FKs and no Gateway tool keep aggregates out of `ClientContextV1`, readers and the ledger. Guards are per-controller (`apps/api/src/db/auth.ts:15-27`, `@UseGuards` on each controller, no `APP_GUARD`), so a route-specific adapter that never enters `ApiTokenGuard` is feasible without touching legacy 401 behaviour.

**Bearer dispatch, synthetic 401, workspace-only denial, atomic success audit.** Consistent with the accepted Stage 3 pattern: opaque in-memory credential, hash-only `currentToken` lookup under `ApiToken_lookup` with the digest cleared before actor lookup (`packages/actions/authority.ts:49-57`, policy at migration 202610071600). Denial writes one workspace `SecurityAuditEvent` with requested client as safe text (`securityDenial`, same file). The success audit goes to client `AuditEvent`, which has no Actor FK, so the read path takes no auth-table row locks. `packages/auth/authority.ts:11-16` already implements one-membership all-of.

**Fresh authority after ALL locks under the installed fence.** Correct. The fence trigger increments the workspace row on every Actor/Membership/ApiToken/Connection mutation (migration 202610091000:98-155), so holding the fence row (SHARE or UPDATE) guarantees no auth or binding change can commit. Rechecking token expiry with `clock_timestamp()` after State/Attempt waits matches Stage 3 semantics. Extracting `currentToken` and `setLocal` verbatim into `packages/auth/transaction-token.ts` does not change ApiToken visibility, policies or grants.

**Typed scoped FKs, NULL truth, immutable history, bidirectional ACTIVE pointer, allocated snapshot, latest/lastCompleted coherence.** Implementable; see P2-2 and P3-3 on wording.

**Lock mode and privilege matrix; Connection plain SELECT stability.** The deadlock analysis in `03:47-49` is right for explicit locks: a Connection UPDATE takes the tuple lock before its BEFORE ROW trigger waits on the fence, so a post-fence Connection row lock would invert order. Plain MVCC read is stable because the mutation cannot commit while the fence is held. Fence SHARE for reads is grantable by the existing runtime `UPDATE("workspaceId")` (`prisma/roles.sql:157`) and the PUBLIC `ActionAuthorityFence_scope` policy (migration 202610091000:88-89). See P3-4 for the FK row-lock caveat.

**Exact two fence policies, GUCs, no PUBLIC EXECUTE, roles, definer, non-superuser owner.** Consistent. Runtime readiness asserts exactly two fence policies with exact text (`packages/graph/fence-role.ts:128-141`), so "no third maintenance policy" is mandatory, and the design honours it by having the cleanup definer lock through the scope policy with `app.workspace_id` set by the runner. No readiness check forbids a second confined definer from holding `UPDATE("workspaceId")` on the fence. Revoking PUBLIC EXECUTE on every new routine in its own migration means no entry in `FENCE_SHARED_INVOKER_ROUTINES` is needed and the fence-definer routine check stays fail-closed. Default privileges grant the runtime full UPDATE on new tables (`prisma/roles.sql:160`), so the renderer must add REVOKE/column grants, and `PROTECTED_TABLES` plus a Stage 4 column allowlist must be extended in `packages/graph/runtime-role.ts:98-100`; the design names both. Distinct-role count moves from 5 to 7 (`prisma/roles.sql:73`).

**Strict DTO, BigInt per currency, credit, dates, empty vs null, SQL validation.** Bounds are mutually consistent: 100 pages × 100 items = 10000 IDs; 15 integer digits × 10000 fits the 19-digit sum bound. Trigger-based aggregate validation avoids CHECK immutability issues with Europe/Oslo conversion.

**Bounded private MOCK export vs unverified wire; fresh page auth, 60+20s deadline, cancel, pool wait, no I/O under locks.** Sound and clearly separated: per-page admission commits before the port call, no transaction held across I/O, deadlines anchored on the committed DB `startedAt`.

**Atomic publication, identical replay, max 3 known rollbacks, zero port calls; private failure after revocation; recover; DISABLED/lifecycle drift; precedence.** Sound. The precedence table in `04:48-56` is total and ordered. Recover with no ACTIVE is a zero-effect no-op; late results cannot publish because publication requires ACTIVE plus DB clock below `deadlineAt`.

**Explicit cleanup, 10s/1s timeouts, 1000-row budget, delete triggers, paired runner DB, post-admission revocation.** Matches the accepted Stage 2 shape (`prisma/migrations/202610081200…:16-35`, `packages/m365/maintenance.ts:125-126`) with tighter lock timeout and a connection-scoped GUC.

**Upgrade, legacy regression, checkpoint scope, model, evidence, LIVE gates.** The plan preserves 20 migrations, 19 frozen docs and the S3C baseline, stops at each checkpoint, and keeps LIVE as a separate amendment. Trusted test DI is correctly not treated as operator authority.

## Findings, required acceptance, residual risks

Prioritised; none blocks approval of this artifact. Each must appear in the S4-A/S4-C brief and acceptance evidence.

1. **P2 — RLS composition on new tables is underspecified.** `docs/stage4/03_DATA_AND_CONCURRENCY.md:100-102` requires definer policies scoping all three IDs via GUCs, but PostgreSQL permissive policies are OR-ed. If the new tables also carry the usual PUBLIC `_scope` policy (workspace + client, as every existing table does), the connection-level restriction has no RLS effect for the definer. Required: state that the definer policy is `AS RESTRICTIVE` (or that the scope policy is role-targeted). Acceptance: as the definer with `app.client_ids` = client A and `app.poweroffice_connection_id` = connection X, a direct SELECT on Snapshot/Attempt/State returns zero rows of connection Y of the same client; add to C3.

2. **P2 — Purged-snapshot invariant must be one-directional.** `03:33-34` says "lastSuccessAt/published pointer cannot diverge", yet cleanup clears `snapshotId` while the EXPIRED/purged precedence row (`04:51`) needs `lastSuccessAt` retained, and the definer has no `lastSuccessAt` UPDATE grant (`03:90`). Required: state the invariant as "snapshotId non-null ⇒ lastSuccessAt equals that snapshot's publishedAt; snapshotId null with non-null lastSuccessAt is the purged state". Acceptance: publish → purge → status read returns EXPIRED/SNAPSHOT_EXPIRED/null and lastCompleted SUCCEEDED; constraint test that a non-null pointer with mismatched lastSuccessAt is refused.

3. **P3 — "Deferrable COMMIT constraints" need the mechanism named.** `03:31-32` cannot be met by CHECK or partial FKs; it requires `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` invoker functions with PUBLIC EXECUTE revoked. Acceptance: within one transaction insert an ACTIVE attempt without updating the pointer and show the COMMIT fails; same for pointer without ACTIVE row.

4. **P3 — FK row locks after the fence are a known deadlock class, not covered by the "no Connection lock after fence" wording.** INSERTs into State/Attempt/Snapshot take KEY SHARE on the Connection row and Attempt takes KEY SHARE on the Actor row (`03:5,19`). A concurrent Connection or Actor UPDATE holds an exclusive tuple lock (BEFORE ROW triggers force it) while waiting for the fence, which yields 40P01. The design's fixed DB_CONFLICT code and the publication-only known-rollback policy handle this correctly, and Stage 3 has the same exposure. Required: note it in the brief so admission does not retry and publication retries only on 40P01/40001 with the same fact. Acceptance: the existing "concurrent direct Connection UPDATE against admission/publication/cleanup" cases in 06 (B2/B4/C3) must include the victim being the Stage 4 transaction and the victim being the Connection UPDATE, each with zero partial effects.

5. **P3 — HTTP status for a read on an invalid-binding connection is ambiguous.** `02:82-83` maps binding failure to 503; `04:50` returns a DTO with status UNAVAILABLE. Required: pin one (recommended: 200 with UNAVAILABLE DTO for status/summary reads; 503 only for mode/readiness and sync admission). Acceptance: one HTTP case per 04 precedence row recording the status code, plus a non-PowerOffice connection ID under an authorised client returning 404 with synthetic:true.

6. **P4 — Identical-fact replay after `deadlineAt`.** `03:64-69` requires DB clock below `deadlineAt` for publication and separately promises a stable receipt after lost acknowledgement. State explicitly that a replay of an already SUCCEEDED attempt with identical fact returns the no-op receipt regardless of deadline, never a payload, after fresh auth/binding checks. Acceptance under B4.

7. **P4 — Seeding path for the FIXTURE PowerOffice connection.** C4 (`06:20`) starts at "seed synthetic", but no doc names the component. Connection INSERT with status FIXTURE, provenance and lifecycleVersion 1 is permitted by the installed CHECKs and triggers, and `bindConnection` correctly refuses (`packages/connections/connections.ts:23`). State that the seed is test/fixture code only.

8. **P4 — Audit key naming.** Metadata key `outcome` (`02:92-94`) mirrors the `SecurityAuditEvent.outcome` column name; harmless in JSON but worth an explicit comment to avoid confusion in the C3/C4 privacy capture.

Residual risks accepted at architecture level:

- Explicit cleanup holds the workspace fence FOR UPDATE for up to 10 seconds, blocking Stage 3 admissions, Stage 4 reads and all auth mutations in that workspace. Acceptable for operator-triggered maintenance; document in RUNBOOK.
- The 1000-attempt cap with 30-day attempt retention can lock a heavily exercised connection out of sync for up to 30 days. Operational, not a safety issue, for MOCK.
- Every successful summary/status read inserts a client audit row under the fence. Volume is operator-driven in this slice; revisit before any UI or automation.
- Amounts, overdue logic and the invented export token are synthetic; nothing here verifies PowerOffice accounting semantics, live completeness or production readiness. All LIVE gates in `04:65-88` remain open.

Next: the second independent gate (Astra/xhigh) must cover this same RC2 package hash before S4-A starts; the P2 items should be written into the S4-A brief verbatim so implementer and acceptor read one interpretation.