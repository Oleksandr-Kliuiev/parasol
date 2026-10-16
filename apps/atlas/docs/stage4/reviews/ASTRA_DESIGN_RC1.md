# Stage 4 PowerOffice MOCK design — independent Astra review

Verdict: **CHANGES_REQUIRED**

Reviewer assignment: fresh native Codex subagent, explicitly GPT-6 Astra (`gpt-6-astra`), `xhigh`. The orchestrator must retain the native launch/runtime evidence for that assignment; this report's text is not independent provider-identity proof. Review date: 2026-10-09.

This is an architecture review of the complete eight-file MOCK-only proposal. It is not implementation acceptance, LIVE approval, financial guidance, or authorization to access an account. No other reviewer's verdict or historical review report was read. No source, migration, generated file, database, account, pilot configuration, credential, or vendor API was changed or used. The only file written by this review is this report.

## Exact artifact and verification

Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.

| Item | Verified identity |
|---|---|
| HEAD | `916a4d69853ff6da636e8609a2e0bd33aa787f66` |
| Branch | `planning/stage2-m365` |
| Manifest | `verification/stage4/S4_DESIGN_RC1_MANIFEST.json` |
| Manifest SHA-256 | `9c8724f3c7d316aa83c6a452334ecaa195beb3af94e8d5ca9c0b3a893bff2259` |
| Normative package hash | `0553b3560cd5baee66c1b5294ff04fa05b47282def2d80242100af073a0c3175` |
| Archive | `verification/stage4/S4_DESIGN_RC1_PACKAGE.zip` |
| Archive SHA-256 | `d24ff04317b0f4fe908bf9389b07613c06b9ed9879f6e26c194e57c3e0c233b5` |
| Baseline | `verification/stage4/S4_DESIGN_BASELINE.json` |
| Baseline SHA-256 | `6a9a1202be4404930606681452d74cc78c7597c77abbcab185f400a2426374a8` |
| Recorded accepted S3C RC2 package | `212005fd24b4f23a810ccc9afb2f3213ff7f67ae50f226ac51e8b3b0379e521b` |

Programmatic verification found **zero mismatches**: 8 normative source files, 8 matching archive entries, the package hash computed with the manifest's sorted hash-line rule, 645 baseline entries, 642 byte-identical baseline files, and exactly 3 declared routing deltas with matching before/after hashes. The 19 Stage 2/3 normative entries were also checked against their recorded design manifests: 19/19 match. All 20 installed migration files and the migration lock are included in the unchanged baseline.

Read in full: `docs/stage4/AGENTS.md`, `README.md`, and `01_SPEC.md` through `06_ACCEPTANCE.md`. Adjacent reads were limited to the applicable routing/workflow and the current authentication, fence/readiness, connection binding, Gateway, context projection, maintenance, and relevant SQL definitions. No code tests, generators, builds, or database operations were run; this is design-only evidence.

## Required findings

### F1 — P1: The exact cleanup grants cannot execute the required row-lock protocol

**Design locations:** `docs/stage4/03_DATA_AND_CONCURRENCY.md:34`, `:66`, `:84`; `docs/stage4/04_PORT_AND_SYNC.md:43`.

The design requires every new transaction, including maintenance, to take `Connection FOR SHARE`, then `State FOR UPDATE`, then `Attempt FOR UPDATE` when involved. The cleanup definer is granted only Connection SELECT and Attempt SELECT/DELETE. Neither permits the specified row-lock SELECT. The document correctly includes a locking-only UPDATE grant for the fence but omits the analogous requirements for these tables. Under the declared exact role, cleanup fails with an insufficient-privilege error before doing its intended work. Broadening grants ad hoc during implementation would contradict the approved exact-privilege contract.

PostgreSQL 17 requires UPDATE on at least one column for **all** row-lock SELECT variants, including FOR SHARE and FOR KEY SHARE. The existing M365 cleanup explicitly accounts for this with Connection `UPDATE(id)` at `packages/graph/runtime-role.ts:52`. [PostgreSQL 17 SELECT privileges](https://www.postgresql.org/docs/17/sql-select.html).

There is the same unresolved issue if the proposed “snapshot locks” mean row-lock SELECT: runtime has no Snapshot UPDATE grant, and the cleanup definer has only Snapshot SELECT/DELETE. A plain protected read is feasible, but it is not what an implementer should have to infer from an exact lock specification.

**Required change:** Specify the actual lock mode/read operation for every table and role. Either provide narrowly justified locking-only column privileges, with immutable-row guards and matching readiness checks, or expressly use reads protected by the already-held fence/state lock where safe. Do not silently expand UPDATE privileges. Also state how cleanup uses the existing fence scope policy: `packages/graph/fence-role.ts:128` currently accepts exactly two fence policies; adding a third role-specific fence policy without a reviewed exact update makes all action admissions unready. Reuse of the existing scoped policy with trusted transaction-local scope is a possible compatible design.

**Acceptance:** Invoke the real cleanup routine through the exact EXECUTE-only runner and confined definer on PG17, including a non-superuser migration owner. Verify successful cleanup, ACTIVE/BUSY, disabled-connection cleanup, races, audit rollback, and bounded timeouts. Test every explicit row lock under the actual grants. Forbidden direct writes, immutable changes, cross-scope access, unexpected grants, and extra helper EXECUTE must fail; Stage 3 fence readiness must still pass.

### F2 — P1: The proposed Gateway integration does not reconcile current bearer authority with the accepted legacy audit/ledger path

**Design locations:** `docs/stage4/02_CONTRACTS.md:5`, `:22`, `:57`, `:77`; `docs/stage4/06_ACCEPTANCE.md:17`.

Stage 4 requires fresh bearer-based authority, exactly one workspace denial with no client audit leakage, and no mutation/client audit for an expired public transaction. The proposed generic Gateway entry is only described as adding all-of permissions and rechecking in the service. That is insufficient for the installed path:

- `apps/api/src/db/tools.ts:30` passes an Actor into the Gateway and reader factory; neither interface carries the bearer/private current-token credential.
- `packages/tools/gateway.ts:53` writes a **client** `tool.denied` audit for missing permissions and never reaches the service. This directly contradicts Stage 4's workspace-only permission-denial contract even without a race.
- `packages/tools/gateway.ts:67` commits STARTED plus client audit before calling the reader. If authority is revoked or the token expires before the Stage 4 reader's last-lock check, the reader refuses, but `:73` then writes FAILED plus another client audit through the cached Actor. A service-level current-auth recheck cannot undo those earlier effects or authorize those later writes.
- The inherited audit metadata contains `tool`, `toolVersion`, and `toolExecutionId` (`packages/tools/ledger.ts:19`), outside Stage 4's stated metadata list. This needs an explicit compatibility decision, not accidental reuse.

The same integration must give Stage 4 errors their required `synthetic:true` envelope; the existing generic authentication guard returns its legacy bare 401 (`apps/api/src/db/auth.ts:15`).

**Required change:** Define a concrete, isolated Stage 4 Gateway/HTTP dispatch contract before implementation: how the authenticated bearer becomes a private credential, where current authorization occurs, which path owns denial auditing, and how ToolExecution/read-success/audit commits work. Preserve existing Stage 1/2 Gateway behavior. A dedicated Stage 4 execution path or a narrowly selected policy/ledger strategy can work, but its authority and audit semantics must be part of the reviewed artifact. If any legacy ledger metadata or denial behavior is intentionally retained, amend the Stage 4 contract explicitly and justify it. Do not solve this by widening Actor authority, weakening all-of checks, exposing bearer data, or changing legacy tools globally.

**Acceptance:** Exercise the actual `/tools/execute` path, not only the reader: missing dedicated permission, split membership permissions, stale Actor after revocation, bearer expiry while waiting on the final lock, inactive actor, wrong client/workspace, failed denial audit, failed success audit, and synthetic authentication errors. Assert exact workspace/client audit and ToolExecution effects, zero returned financial payload on refusal, and unchanged legacy Gateway tests.

### F3 — P2: The specified tool name is rejected by the installed Gateway name contract

**Design location:** `docs/stage4/02_CONTRACTS.md:58`.

`get_poweroffice_summary` contains no dot. `packages/tools/registry.ts:38` requires two to four dotted segments, and `packages/policy/tool-policy.ts:22` rejects other names before registry lookup. Advertising the specified name would therefore create an uncallable tool. Relaxing the shared pattern would change accepted behavior unnecessarily.

**Required change:** Freeze a valid dotted canonical name in the normative contract and use it consistently for discovery, policy, execution, and tests. Preserve the legacy name grammar.

**Acceptance:** The chosen name is advertised to an eligible client membership and executes successfully through the real Gateway. The old invalid undotted spelling remains rejected unless an explicit, separately specified alias is deliberately introduced.

### F4 — P2: Starting a new refresh erases the failed-refresh freshness warning before a new snapshot exists

**Design locations:** `docs/stage4/01_SPEC.md:43`; `docs/stage4/03_DATA_AND_CONCURRENCY.md:13`; `docs/stage4/04_PORT_AND_SYNC.md:44`.

The read rule makes a young snapshot FRESH whenever the latest attempt is not FAILED/ABANDONED. Consider: A1 publishes; A2 fails two minutes later, making A1's snapshot STALE with a visible safe failure; A3 is then admitted as ACTIVE. A3 is now the latest attempt, so the stated rule returns A1 as FRESH before A3 publishes anything. Repeatedly starting a refresh can mask the previous failure, and the single `lastAttemptId/state/code` tuple no longer exposes the last completed failure. This conflicts with preserving the prior snapshot as STALE with visible failure status and with showing the last synchronization outcome.

**Required change:** Separate current in-flight progress from the last completed refresh outcome, or define an equivalent persistent/read rule that does not clear failure-induced STALE until a new complete snapshot commits. Define the precedence for “previously successful but purged/expired” plus subsequent failure/ACTIVE states at the same time. The table/query choice is an implementation detail; the externally visible precedence is not.

**Acceptance:** Test success → failure → ACTIVE → success and success → ABANDONED → ACTIVE. STALE and its safe failure remain visible until successful publication; an ACTIVE attempt alone never repairs freshness. Include purged snapshot plus lastSuccessAt plus failed/pending refresh, and verify EXPIRED/null remains distinguishable from never-successful MISSING/ERROR and from valid empty `[]`.

## Whole-contract assessment and required implementation evidence

Subject to the findings above, the principal boundaries are coherent and do not require a LIVE account to assess:

- **Authority:** Bearer-hash-only current-token lookup, clearing the hash before Actor lookup, one-membership all-of permissions, the installed workspace fence, and DB-clock checks after final locks are appropriate. Sharing the current-token helper verbatim is a bounded refactor; preserve ApiToken policies/grants and Stage 3 expiry/replay/denial behavior. Test expiry after each blocking lock, not just after the fence. Private failure continuation after revocation must remain a separate capability, with no read/page/publication authority.
- **Privacy:** Dedicated financial tables and explicit service paths keep invoice/customer identifiers, raw responses, credentials, and amounts out of generic context, observations, Decisions, and audit. Stage 1 PowerOffice credential resolution must fail before invoking any resolver. Do not resolve the fixture secretRef. Prove the boundary in actual API/Gateway/CLI capture and a network trap with a working positive control.
- **DTO and arithmetic:** Strict normalized MOCK DTOs, exact two-decimal strings, BigInt sums, separate positive credit magnitudes, fixed currency groups, bounded counts/bytes/pages, duplicate-ID rejection, and a claim-fixed Oslo business date are implementable. Enforce detached/immutable validated values so later mutation cannot change a validated page or completed fact. TS and SQL must agree on exact aggregate shape, integer/count bounds, distinct sorted currency groups, total count limits, and no additional fields. Check midnight/DST, invalid Gregorian dates/Unicode, max money/sum values, and the empty export case.
- **Source contract:** A private complete-export session tied to the synthetic company/connection/version/attempt/asOf is an honest MOCK contract. Every page needs current authority, no transaction spans port work, page and original pass deadlines are fixed, and results after cancellation/expiry are inert. Real waits, lock/pool delays, cancellation before/after work, and revocation between pages need evidence. Private fault seams do not substitute for tests of the actual built-in source.
- **Persistence and concurrency:** Compound scope FKs, immutable attempt identity, one ACTIVE claim, exact deadlines, immutable snapshots, scoped Actor FK, deferrable publication checks, atomic audit, explicit recovery, and bounded known-rollback retries provide a workable basis. At implementation review, verify both directions of pointer/claim consistency: an ACTIVE claim must remain discoverable/recoverable; a published snapshot must correspond to its owned SUCCEEDED attempt and allocated snapshot identity. State outcome metadata, attempt sequence, and pointers must not diverge or rewind. No partial snapshot or stale/abandoned result may commit.
- **Replay:** “Identical” must compare the fixed complete fact and owned identity, not merely find a matching ID. An altered fact with reused identity must fail. Only known 40P01/40001 rollbacks may retry, at most three total transaction attempts, with fresh authority/deadline/binding checks and zero new port calls. Unknown/ambiguous outcomes must never trigger a new export. A receipt/read after lost commit acknowledgement must not become a financial-data authorization bypass after revocation, binding drift, or expiry.
- **Recovery and retention:** It is appropriate that recovery and purge can operate after Connection DISABLED/lifecycle drift in the same immutable synthetic binding. Fresh public recover authority remains required; the private failure capability is narrower. Purge's admitted-maintenance boundary permits completion after later revocation as explicitly stated. Its separate runner/definer must be paired to the runtime database and confined independently, with schema-qualified object resolution, safe search_path, exact ACLs, no membership/auth/credential access, bounded deletion before materialization, a combined 1000-row budget, a real 10-second rollback bound, and correctly scoped morePending.
- **Compatibility:** The baseline preservation is verified. Implementation must keep the installed migrations and all frozen normative/history artifacts byte-exact, add new migrations, preserve the Stage 3 PUBLIC routine allowlist, and prove exact role readiness after provisioning and on populated upgrades. New helper functions need explicit grants only where required and no unexpected PUBLIC EXECUTE. No automatic assignment of the new permissions is permitted.

The architecture amendment should add the finding-specific cases to `06_ACCEPTANCE.md`. Each implementation checkpoint still requires fresh independent review of its actual source and evidence. The final command set already specified in `06_ACCEPTANCE.md:26` is appropriate: unit/PGlite tests, schema validation/generation, typecheck, API build/smoke, real PG tests, PG17 migration checks, zero schema drift, and tracked/untracked whitespace checks. Preserve focused failures/negative controls and use the resulting exact source identity for acceptance. This design review does not substitute for any of those runs.

## Public-source and residual limits

The official authentication and migration documentation supports treating each client integration/environment credential separately; it does not prove the Atlas client binding required for LIVE. [PowerOffice authentication](https://developer.poweroffice.net/documentation/authentication), [v1-to-v2 transition](https://developer.poweroffice.net/documentation/from-v1-to-v2).

The request documentation confirms x-pagination and replicated reads. Neither establishes an immutable complete export across pages. Keeping that guarantee synthetic and requiring a new LIVE contract is correct. [PowerOffice requests](https://developer.poweroffice.net/documentation/requests).

The payment documentation relates invoice balance to matching and includes credit notes and unmatching changes. That supports deferring real balance/credit semantics rather than inferring them from the normalized MOCK fields. [PowerOffice invoice payments](https://developer.poweroffice.net/workflow/usecase/reporting/retrieving-invoice-payments).

Remaining limits after a future corrected design approval: there is no implemented Stage 4 code yet; correctness depends on actual PG role/RLS/constraint and race evidence. Explicit maintenance means physical retention can lag until invoked, though read-time expiry must never lag; the 1000-attempt cap may intentionally block further sync before rows are old enough to delete. Workspace fencing serializes affected work within a workspace. The status-plus-invoice scope is the package's explicit product assumption; the offered organization-only alternative remains a product decision, not a reason to demand account access. LIVE schema, completeness, company proof, financial semantics, onboarding, operational retention/scheduling, and owner admission remain deferred and unapproved.

Stop: resolve F1–F4 in a newly identified normative package and obtain the required independent approvals of that same package before implementation.
