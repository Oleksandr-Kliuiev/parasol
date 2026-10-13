# S5ASK-DESIGN-rc2 — Independent architecture review (Fable)

**Verdict: CHANGES_REQUIRED** (five bounded contract corrections; no architectural rejection; OFF/MOCK direction is sound and implementable once closed).

## Artifact identity (verified read-only, 2026-10-10)
- Package `S5ASK-DESIGN-rc2`, packageHash `bbed28ec187d7846ff5a292d7c40992dea496913f0361b0d555abe6450873854` — recomputed from the six file hashes per `hashRule`: match.
- Manifest `verification/stage5/S5ASK_DESIGN_RC2_MANIFEST.json` sha256 `2dcc3a0305b5bc67235fc3f2d43c90d8fe9bfeacbe0d07e6ad138d99826912ae`: match.
- Archive `S5ASK_DESIGN_RC2_PACKAGE.zip` sha256 `e55830c1345d3a6f6c0a71faa3ba6e018bc4db58d0ae9ff4de179b5ea9879cde`: match; six entries byte-equal to working `docs/stage5/ask/{AGENTS,README,01_SPEC,02_CONTRACTS,03_SECURITY_AND_STATE,04_PLAN_AND_ACCEPTANCE}.md`.
- Baseline `S5ASK_BASELINE.json` sha256 `fcf598c3…eec22e`: match. HEAD `916a4d69…` on `planning/stage2-m365`: match.
- Reviewed exactly the six normative files; `DESIGN_STATUS.md`, all Ask review reports/dispatch/execution files and other reviewers' verdicts were not read.

## Reviewer qualification
Requested `claude-fable-5-1`, requested effort high, native Anthropic subscription session, no delegation, no network/vendor/model calls, no tests/builds/env/credential reads, no repository or scratch writes. Self-declaration is not identity proof; the coordinator's stream check governs. Effective effort not observable from inside the session.

## Bounded source verification (what the contract assumes vs. what the checkout shows)
- Bearer/currentToken: `packages/auth/token.ts:8-16`, `transaction-token.ts:18-25` (digest-only lookup, DB clock expiry) — reusable as stated.
- Fence: `prisma/actions.prisma:10-14` (`version Int`), `packages/graph/fence-role.ts:18` runtime `UPDATE(workspaceId)` — privilege-sufficient for `FOR SHARE`; readiness SQL `fence-role.ts:162`. Accepted Stage 3 admission sequence `packages/actions/authority.ts:84-116` sets `app.workspace_id` to the hint *before* the lock, uses `FOR UPDATE`, and `Number(version)` (the Ask contract's exact-integer capture is a correct tightening).
- Stage 3 frozen text `docs/stage3/03_DATA_AND_CONCURRENCY.md:28-29`: fence is locked `FOR UPDATE`, "never … shared/key-share lock". RC2 introduces `FOR SHARE` (03:16, 03:22) without recording the deviation (R5).
- Current authority: `packages/auth/authority.ts:11-17` (ACTIVE actor + membership permissions, transaction-local actor GUC).
- Context reader/mapper: `packages/graph/prisma-context.ts:31-53`, `context-mapper.ts:41,44-45,52,70-85` — confirms the repairs the Ask contract must pre-empt: `asSystem` unknown→'atera', `kind` default, `summary` non-string→'' and 300-slice, non-array items→ERROR SNAPSHOT_INVALID, M365 filtered in query.
- Denial path: `apps/api/src/db/auth.ts:43-67` (malformed → `INVALID_SCOPE_ID`; Ask deliberately uses `SCOPE_DENIED`, see O9).
- Audit: `packages/audit/sanitize.ts:10-37` allowlist contains `provider, ruleVersion, itemCount, outcome, safeErrorCode`; `prisma.ts:27-30` `clientAuditData` — the Ask audit needs no allowlist change, as claimed.
- Parsers: `apps/api/src/main.ts:20-29` (no `bodyParser:false` today; operator middleware is `app.use`d before `listen`, so it precedes Nest's parser registration at init — Host-gate-first order is preserved by construction). Nest 11.1.6 registers `express.json(getBodyParserOptions(rawBody))` and `express.urlencoded({extended:true})` (`node_modules/@nestjs/platform-express/adapters/express-adapter.js:200-208`); body-parser 2.3.0 default limit 100kb (`lib/types/json.js:61-63`) and skips only an already-finished stream (`lib/read.js:40`). Existing JSON POST consumers: `apps/api/src/db/tools.ts:30`, `atlas.module.ts:76`.
- Schema: `Connection @@id([workspaceId, clientId, id])`, unique `(workspaceId, system, externalTenantId)` — several Atera connections per client are legal (drives R1).
- Console caps parity: `docs/stage5/S5B_IMPLEMENTATION_BRIEF_RC2.md:42` people/devices/links 1000, resources 100, items 1000 — the Ask read caps are inherited, not new.

## Required findings (contract corrections before ASK-A)

**R1 — SOURCE_STATE is unsatisfiable by the planner contract when a client has two same-system connections.** `02_CONTRACTS.md:106-107` descriptors carry only `{ref,kind,source,type,severity?,route?,status?,entityState?}`; `02:127` demands the single RESOURCE_STATE ref matching the focus observation's exact `source/resourceType/connectionId` tuple. With two Atera connections the planner sees two indistinguishable descriptors; a correct question yields 503 `ASK_PLANNER_INVALID` or forces an undocumented "first matching in bank order" coupling (02:65 "focus … first"). Closure: add boolean focus flags to descriptors (e.g. `focusObservation`, `focusTuple`, `focusEntity`), still "enums/flags only"; state that the mock planner selects the flagged descriptor; add a Q4 case with two same-system connections.

**R2 — Mock SUMMARY ref selection is unspecified.** `02:116-118,125` define the phrases and the cardinality 1..8 but not which refs the mock planner returns for SUMMARY. Implementers will invent (severity-first? observations only? include resources?), making Q8 goldens and the user-visible "What needs attention?" answer implementation-dependent. Closure: one sentence, e.g. "SUMMARY refs = first up to 8 OBSERVATION descriptors in bank order (focus first, then source order); if none, first up to 8 RESOURCE_STATE descriptors; ascending E order."

**R3 — ENTITY "matching entity link" is undefined.** `02:88-90`: confirmation comes "from one CONFIRMED matching entity link with the SAME entityId AND entityKind … chosen in existing link-ID order". "Matching" can mean (a) any CONFIRMED Atera/Huntress non-M365 link of that entity, or (b) a link whose resourceType/connection matches the focus observation. The two readings produce different `confirmation` tuples and can flip CONFIRMED↔UNRESOLVED (entity confirmed only via a link of another resource type). Since the browser re-validates state and tuple (02:152-154), server/browser parity depends on this. Closure: define exactly; recommended (a) with lowest link id, consistent with `contracts.ts:149` (entityId already resolved through the matching link) and the accepted S5B rule.

**R4 — Raw-parser handoff and parity baseline are not specified.** `02:36-45`, `04:18-20` order the Ask raw parser before re-registered JSON/urlencoded parsers but do not say (i) how the Ask controller receives the validated body when `bodyParser:false` leaves `@Body()` undefined, (ii) how the generic parsers are prevented from re-reading the Ask stream, (iii) what "identical existing defaults" are. Today the only thing stopping a second read is body-parser 2.3.0's `isFinished` check (`read.js:40`): a 413 cut at 16KiB that ends the response without finishing the stream, or a future body-parser bump, hangs or double-parses. Closure: require that the Ask middleware fully consumes or terminates the request stream, attaches the validated body under a private request property consumed by the controller (never `@Body()`), and that the re-registered parsers are `express.json()` and `express.urlencoded({extended:true})` with unchanged defaults (100kb, strict, `application/json`), registered after the Ask middleware and excluded by exact Ask path/method shape; Q1 golden must prove no second read and the 100kb/strict/syntax 400 behaviour of `tools/execute` in OFF and MOCK.

**R5 — `FOR SHARE` on the fence deviates from the frozen Stage 3 fence invariant and is undocumented.** `03:16,22` lock `ActionAuthorityFence` `FOR SHARE`; `docs/stage3/03_DATA_AND_CONCURRENCY.md:28-29` and `prisma/actions.prisma:9` state the runtime locks the fence `FOR UPDATE` and "never a shared/key-share lock". The choice is privilege-valid (`fence-role.ts:18`) and sensible for ≤4 concurrent readers, but it blocks the definer's version UPDATE (every auth mutation in the workspace) and Stage 3 `FOR UPDATE` admissions for up to one 2s phase per Ask, and conversely waits behind them. Closure: record the deviation as Ask-only in 03 (no change to Stage 3 text, roles, readiness SQL or ACL), state the blocking consequences, confirm Ask takes no other row lock after the fence (no deadlock cycle; Stage 3 FABLE_DESIGN_RC1 lock-order note), and require phase 1 to set `app.workspace_id` to the token hint before the lock (fence RLS is workspace-scoped; `authority.ts:88`).

## Optional notes (refinements, not gates)
- O1. Ref numbering: fix E1.. order (observations, then resources, then entity) and state whether `evidence`/`urgentRefs` are returned for UNSUPPORTED/INSUFFICIENT (recommend yes, so the urgency notice is always rendered).
- O2. Read minimisation: the bank uses only the focus entity and its links, and no snapshot items; reading all people/devices/links (≤1000, 4MiB) and validating up to 100×1000 items that are never emitted turns large-client questions into 413 and burns budget. Permit a narrow read (focus entity row + CONFIRMED links; resource status fields + `jsonb_typeof(items)`) while keeping full validation of what is read. Caps are inherited from the console, so not blocking.
- O3. 16KiB vs 2000 codepoints: a legal 2000-astral-codepoint question sent `\u`-escaped is ~24000 bytes → 413. Document, or raise raw limit to 32KiB.
- O4. Define "no body" for capability GET (absent/0 Content-Length, any Transfer-Encoding → 400) and that HEAD/OPTIONS on Ask shapes fall through to ordinary Nest handling.
- O5. Tabulate the exact `ASK_SOURCE_INVALID` predicates (unknown system, non-array items with OK/STALE, non-string summary, non-ISO times, enum/scope violations) so Q3 goldens are not inferred from mapper code; note Ask shows summary up to 4000 codepoints while the console slices at 300.
- O6. `provider='fixture'` in DB-mode completion audits is honest about the planner but can be misread as sourceMode; consider documenting in RUNBOOK.
- O7. 64 actor-budget entries: a 65th distinct actor gets 429 while idle unexpired entries exist; state the idle expiry (60s) so operators understand the window.
- O8. Capability 200 has no body `correlationId` but every other Ask response does; fine, but say the browser must not require it.
- O9. Malformed path IDs audited as `SCOPE_DENIED` diverge from existing `INVALID_SCOPE_ID` (`apps/api/src/db/auth.ts:56`); intentional uniformity, worth one line for security-audit readers.
- O10. ACTION_FENCE_READY_SQL is a heavy catalog query run twice per question; acceptable under 2s phases, but goldens should time it on PG17.

## What this design honestly does and does not deliver
Implementable and useful in MOCK: a real free-text HTTP/UI path, two-phase current authority with epoch check, server-derived cited evidence, deterministic compiled claims, honest coverage/uncertainty, bounded budgets with permit retention past public timeout, no persistence of questions. Not delivered and not claimed: any language understanding beyond eight exact RU/EN phrases, external inference, tool orchestration, finance/M365, data egress, deployment. No flag, key, Decisions mode or registry entry can activate remote inference; ASK-REMOTE requires a new dual-reviewed data/provider/billing amendment. Approval of this package would mean "approved to implement ASK-A", not code acceptance and not remote/live readiness.

## Gate and implementation boundaries
- Both independent approvals of the same current package precede ASK-A; ASK-B needs accepted ASK-A identity; ASK-REMOTE NOT_STARTED.
- Shared-source deltas allowed by this contract: `apps/api/src/main.ts` bootstrap parsers only; no schema/role/migration/registry/provider/audit-allowlist change (verified unnecessary).
- Accepted console S5B-rc1 (`0346dc12…0f6b`) and Stage 1–4 contracts remain controlling elsewhere; parent Stage 5 eight norms frozen.

## Preservation (before/after)
- Working inventory 1048 files all match manifest hashes; `workingInventoryHash` recomputed match. Built inventory 197 files unchanged vs baseline (0 diffs).
- Baseline 1032 → working 1048: 5 changed files exactly the declared `preparationAdminDeltas` (AGENTS.md, AI_CONTEXT_MAP, DEVELOPMENT_WORKFLOW, stage5 IMPLEMENTATION_STATUS, REVIEW_STATUS); 16 added files are the Ask docs and Ask verification/review artifacts; no application/test/build change.
- Accepted S5B seal `S5B_APPROVED.json` sha256 `2e6b7b27…637e4` and closure `S5B_CLOSURE_VERIFICATION.json` sha256 `4b52961d…acb5b2e` match the manifest; seal records packageHash `0346dc12…0f6b`, ACCEPTED, same HEAD/branch.
- Dirty tree (281 porcelain lines) is accepted prior-stage work; not treated as Ask work. No files written by this review.

## Elapsed / usage
Wall-clock not observable. Context counter moved from 15.00M to ≈14.86M tokens (≈0.14M consumed) across 12 tool calls; subscription quota unknown.