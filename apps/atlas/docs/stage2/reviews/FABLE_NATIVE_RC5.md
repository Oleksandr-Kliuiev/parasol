# Independent architectural re-review: Atlas Stage 2 (M365 Correlation), RC5

**Date:** 2026-10-08
**Package:** `docs/stage2/REVIEW_MANIFEST.json` version 1.0-rc5, package SHA-256 `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`, baseline commit `916a4d6`
**Reviewer:** Fable 5.1 (`claude-fable-5-1`), native Claude Code, effort high, fresh read-only session (Read/Glob/Grep only). Model identity is self-reported; the orchestrator records transport/model separately.
**Basis:** my own RC4 report (`docs/stage2/reviews/FABLE_NATIVE_RC4.md`, APPROVE on hash `9c19f605…`), the compact RC4→RC5 diff, the current text of the four changed files, and narrow Stage 1 source checks. No other reviewer reports and no `REVIEW_STATUS.md` were read.

**Verdict: APPROVE** (S2-ARCH, design only, for this hash). No obligatory findings. All RC4 non-blocking notes 1–4 are closed in the normative text; notes 5–7 remain implementation details.

## Scope of this re-review

Focused closure/regression review of the RC5 changes in `02_CONTRACTS`, `03_CONNECTOR_SYNC`, `04_IMPLEMENTATION_PLAN`, `05_ACCEPTANCE`. The other seven manifest files are stated unchanged; I did not replay the RC4 audit of them. The RC4 verdict carries over to them only on the orchestrator's hash recomputation.

## Change-by-change assessment

| RC5 change | Verified against | Status |
|---|---|---|
| **Connection lock grant for cleanup definer** (02 §6): SELECT on six columns + UPDATE(id), no Connection DML, runner has no direct Connection privileges and cannot SET ROLE | PostgreSQL requires UPDATE privilege on at least one column for `FOR UPDATE`/`FOR NO KEY UPDATE`; `Connection_binding_immutable` BEFORE UPDATE trigger (`202610071700` lines 38–50) rejects any change to workspaceId/clientId/id/system/externalTenantId; only the table owner can disable a trigger and the definer is not owner; Connection RLS is a FOR ALL policy not bound to a role, so it applies to the definer; `secretRef` is deliberately outside the SELECT grant | Sound. Least-privilege and privacy preserved |
| **Lock contention / no-mutation acceptance** (05 C5a) | Lock order "Connection → resource/root" unchanged from RC4; new assertions are observable in `tests/pg` with a LOGIN runner | Consistent; closes the gap between the grant and its test |
| **Graph `ge`/`le` + local half-open filter** (03 §1, 05 B6) | Closes RC4 note 1. Row at exactly `to` is discarded locally and fetched by the adjacent root/child whose `from` equals it, so no coverage hole; "rows outside [from,to] fail the attempt" is consistent with "rows exactly at `to` are discarded, not failed" | Closed |
| **Idempotent role provisioning** (02 §3, 04, 05 A4a) | Closes RC4 note 2. `roles.sql` today starts with a non-idempotent `CREATE ROLE`; `ALTER DEFAULT PRIVILEGES` (line 25) will pre-grant INSERT/UPDATE on new tables to an existing role, which the "reapply grants/revokes" rule covers; "upgrade runtime stays stopped until provisioning passes" (unchanged) fences the window | Closed at design level |
| **Shared cursor MAC key** (02 §5) | Closes RC4 note 3; same `env` secret-reference convention as 03 §2 | Closed |
| **lifecycleVersion on all activation paths** (02 §1) | Closes RC4 note 4. The only activation path is `activateConnection` (`packages/sync/activation.ts:34`), called from `packages/ops/live-read.ts:25` and tests; adding an increment to that `update` is trivial; the trigger leaves the new column free; R1/R2 still require Stage 1 regressions | Closed |
| **PG/PGlite grant parity** (04) | `scripts/pg17-check.ts:47–50` and `tests/database.test.ts:30–34` each carry an inline copy of the roles.sql grants rather than rendering the file; `renderRolesSql` (`pg-harness.ts:36–41`) will need its shape assertion updated, as RC4 note 7 already said | Consistent; see residual 2 |

No regression found: the new text does not contradict unchanged sections (lock order, publication fence, retention predicates, permission matrix, DTO allowlists).

## Obligatory findings

**None.**

## Residual implementation/live notes (non-blocking)

1. **Lock mode for the Connection fence.** Stage 1 inserts into `RawEvent`/`ExternalEntity`/`SyncState` take `FOR KEY SHARE` on the parent Connection via FK. A `FOR UPDATE` fence in cleanup/publication/disable would block concurrent Atera/Huntress ingest for that connection for the lock's duration; `FOR NO KEY UPDATE` does not, still serializes the three M365 operations against each other, and needs the same UPDATE(id) grant. Recommend `FOR NO KEY UPDATE` in tasks 2.3/2.5/2.9 and a C5a/B5a assertion that an ingest insert is not blocked. Design-neutral; RC4 note 6 already names lock duration.
2. **One source of truth for grants.** With the new parity rule, `pg17-check.ts` should render `prisma/roles.sql` (as the harness does) instead of its inline copy; the PGlite snippet can only approximate (no LOGIN), so the "runner cannot SET ROLE" and "credentials preserved" assertions belong in `tests/pg`, where the matrix already places them.
3. **No-op and failed activation.** `activateConnection` returns early for an already-ACTIVE connection and `adapters.pg.test.ts:32` asserts idempotence. Specify in task 2.3 that only the transaction that sets ACTIVE increments `lifecycleVersion`; a no-op or failed health check does not. Either choice keeps public outputs unchanged, but incrementing on no-op would evict caches needlessly.
4. **Column-list discipline.** With column-level SELECT the routine must name columns explicitly; `SELECT *` on Connection fails under the definer. A test that the definer cannot read `secretRef` is cheap and worth adding to A4a.
5. **Existing-role validation must fail, not warn.** "Validate their confinement" on upgrade should abort provisioning if the existing role is a table owner, has BYPASSRLS, or is a member of the owner; the runtime guard would catch it later, but provisioning is the earlier, cheaper gate.
6. RC4 notes 5 (FK mirror composite key) and 7 (`renderRolesSql` shape assertion) stand as implementation details.
7. Live risks unchanged from RC4: Graph `ge`/`le` semantics on `createdDateTime`, sign-in licensing/403 behaviour and eventual consistency are S2-LIVE facts, not provable here.

## Limitations

- I **cannot recompute SHA-256** with Read/Glob/Grep and rely on the orchestrator's recomputation of all 11 entries and the package hash. I confirmed every diff hunk is present verbatim in the current four files and that the RC4 original directory holds all 11 files, but I did not byte-compare the seven files stated unchanged.
- No tests, typecheck, migrations, PGlite or PostgreSQL were run; no tenant access. PostgreSQL privilege and Graph facts are from documentation knowledge, not live checks.
- Approve means the RC5 design matches its stated invariants and is implementable on the Stage 1 code I inspected. It is not acceptance of any implementation (S2-A/B/C require executed evidence), not a live pass (S2-LIVE open), and not approval of Stages 3–9. Any further change to a normative file requires re-review of the new hash.
