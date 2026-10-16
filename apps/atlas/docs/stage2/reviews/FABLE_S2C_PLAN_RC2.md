# Native Fable S2-C plan RC2 review

Date 2026-10-08. Fresh explicit claude-fable-5-1/high; native Anthropic subscription. Actual assistant message.model: claude-fable-5-1 only. Three permission denials were attempted shell hash recomputation; Read/Glob/Grep review completed, declared hashes independently verified by Codex. No code edits/CLI fallback/credits enabled.

Enough evidence is gathered. I'm now consolidating the assessment and writing the verdict.

**Verdict: CHANGES_REQUIRED** for `docs/stage2/reviews/S2C_IMPLEMENTATION_BRIEF_RC2.md`, three required corrections, all internal to the brief. No RC5 contract change is needed.

## Identity

| Item | Value |
|---|---|
| Artifact | `docs/stage2/reviews/S2C_IMPLEMENTATION_BRIEF_RC2.md`, 228 lines |
| Declared SHA-256 | `32837356f648fb0449ea8a9b680daaebeb3d143132735800bd2496c94087068d` (manifest `S2C_PLAN_RC2_MANIFEST.json`, version `S2-C-plan-rc2`) |
| Baseline | S2-B-rc4 `d122f0ea…6eb841`, HEAD `916a4d6`, normative package `1d3b1064…a1efb` |
| Hash recomputation | Not performed. Shell execution needed approval that was not granted, so the declared hash and the 11 normative hashes are taken from the manifest, not independently verified. The file content reviewed is the current working-tree content. |

Reviewer: native Claude Fable 5.1, high effort, Read/Glob/Grep only. No prior review was read.

## Required corrections

**R1. Subprocess recovery tests have no specified way to reach the mock Graph (lines 168–170, 220).** The brief mandates actual subprocess tests for sign-in `create` (which runs one I/O pass), DISABLED activation probes, and revoke during probe. The connector pins fixed origins (`connectors/microsoft365/contract.ts:8-10`) and the transports call global fetch (`connectors/microsoft365/http.ts:20-21`), and the existing CLI process test states that a child process has no mock transport (`tests/pg/ops-cli.pg.test.ts:59`). As written, an implementer must either add a production origin or transport override (forbidden by 03 §2 and the brief's own "no provider input expansion") or skip the test (forbidden by "zero skip for required behavior"). Correction: specify a test-only preload for the child process (for example `node --import tests/support/<fetch-preload>.ts scripts/ops.ts …`) that replaces global fetch for exactly the fixed authority and Graph origins with the captured mock, and state that no production code path may redirect those origins. For "revoke during probe", state that the preload holds a probe response until the test commits `m365-disable` (in-process or a second child), then releases it.

**R2. The item-match predicate that `total`, keyset and count depend on is never defined (lines 59–67, 89, 99).** "Matching/count" and "matching deduplicated snapshot count" are used without saying which evidence rows match. Two readings differ materially: SIGNIN_USER_REFERENCE as a third selection route (every sign-in of any PERSON-linked user) versus annotation only. Correction: state that selected evidence is the union of the device route (evidence `deviceId` equals the resolved current directory device `deviceId`, only when the device path is RESOLVED) and the assigned-person route (evidence `userId` equals the mapped user's `sourceObjectId` of `Device.personId`'s confirmed selected-connection link, only when that path is RESOLVED); that SIGNIN_USER_REFERENCE and `canonicalPersonId` are computed per selected item and never select; and that with coverage present but neither path RESOLVED the result is `items: []`, `total: 0`.

**R3. The reason-code vocabulary the resolution rules need does not exist in the public contract, and the brief does not authorize extending it (lines 29, 60–66).** `packages/correlation/contracts.ts:16-18` is a closed union with six codes. The brief requires UNRESOLVED/AMBIGUOUS outcomes "with the corresponding code" for cases with no code: no confirmed Huntress DEVICE link, zero or multiple confirmed `m365_device` links, directory pointer absent, directory device with null `deviceId`, duplicate `deviceId`, and assigned person absent, unmapped or multiply mapped. The brief names contracts.ts the public authority, and `docs/DEVELOPMENT_WORKFLOW.md:26-27` treats public contract changes as review-worthy. Correction: explicitly authorize an additive extension of `CorrelationReasonCode` and enumerate the codes (or require the implementer to enumerate them in the checkpoint report), keeping the six existing codes unchanged.

## Verified as feasible and coherent (no correction)

- **Fixed-width timestamp key.** Canonical DTO time is 3–7 fractional digits with mandatory Z (`connectors/microsoft365/dto-common.ts:53-71`), so padding to seven digits gives a fixed-format string whose lexical order equals chronological order. A SQL expression over `dto->>'createdDateTime'` is deterministic for ORDER BY, half-open filtering and keyset, and the ms `occurredAt` prefilter widened to inclusive-upper is sound. Sub-ms rejection at sync creation is consistent with S2-B's millisecond `Date` bounds.
- **Cursor size budgets.** Claims `{v,b,f,p,e}` with two hex digests, a 36-char evidence UUID (cap 128) and an epoch-ms expiry encode to roughly 450 ASCII characters with a base64url HMAC, under 512. The largest tool call (two 128-char IDs, two 28-char instants, limit, 512-char cursor) stays near 950 characters, under the 2048 body cap at `apps/api/src/http-boundary.ts:65`.
- **Fingerprint and `Device.personId`.** `Device.personId` exists (`prisma/schema.prisma:107`) and is RLS-readable by the runtime; including it with null makes reassignment and removal invalidate pages as required.
- **Conflict rule.** Membership bounds guarantee evidence expires no later than its attempt, so "unexpired version with membership in a published attempt" is a well-defined SQL EXISTS; same-attempt duplicate versions are covered by "each CONFLICTED".
- **Stored-read versus activation states.** ACTIVE-only ordinary reads, ACTIVE or DISABLED status reads, and `CONNECTION_ALREADY_ACTIVE` without I/O all match `packages/m365/authority.ts:45-54` and `packages/m365/activation.ts:39-50`.
- **CLI table.** Every command maps onto an existing S2-B service (`windows.ts`, `ingest.ts`, `directory-retry.ts`, `activation.ts`); mode exclusivity and the 512-character cursor exception are implementable in `parseInvocation` per-command specs (`packages/ops/commands.ts:95-115`).
- **Cleanup runner.** `set_config` works for `statement_timeout` and `lock_timeout` inside a Prisma interactive transaction; the routine reads scope and actor from transaction settings (`atlas_app_actor` exists); a runner-perspective check can reuse the definer/ACL CTE fragments from `packages/graph/runtime-role.ts:97-106` without calling the runtime assertion; two-database same-target rejection is testable with the existing harness. The documented admission gap (authority check before a separate runner transaction) is honest and unavoidable given the runner holds no actor-table privileges.
- **Composed registry.** `describeTool` already preserves legacy shapes; `toolsAvailableTo`, `decideToolCall` and `executeTool` accept a registry parameter but both controllers currently rely on the default (`apps/api/src/db/tools.ts:27,37`, `apps/api/src/atlas.module.ts:63,71`), so the brief's injection requirement is correct and necessary. Readers already close over the actor, so no `run` signature change is needed.

## Optional notes

- Line 131, "interval outside seven-day retention": say whether only `to <= now-7d` is rejected (S2-B convention, with clipping for a straddling interval) or any `from < now-7d`.
- Define the outcome when cursor position `p` cannot be found in the reloaded snapshot (suggest `CORRELATION_CURSOR_EXPIRED`).
- Define the directory listing order (presumably `sourceObjectId` ASC) and its envelope fields, since the digest position implies an order the brief never states.
- "Normalized host" in the runner URL comparison should be defined as lowercase textual comparison with default port substitution, not DNS resolution.
- `lock_timeout` of 5000 ms bounds the C5a contention wait; tests holding the Connection lock must release within that bound.
- A service-level `PERMISSION_DENIED` inside a tool run will still complete the STARTED ledger row as `tool.failed` in the client audit; state that this completion is acceptable next to the single workspace denial.
- The sign-in DTO CHECK does not validate the `createdDateTime` format; the read predicate relies on parser canonical form, which is acceptable but worth a regex guard. An additive expression index on the fixed-width key may be needed for count performance.
- `packages/audit/sanitize.ts:10-25` will need additive allowlist keys for `correlation.read` (for example `total`, `coverageStatus`, `ruleVersion`); the brief's "explicit audit allowlist" covers this but does not name it.
