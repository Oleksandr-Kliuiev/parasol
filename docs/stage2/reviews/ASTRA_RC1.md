# Independent Astra review — Stage 2 RC1

- Date: 2026-10-08.
- Reviewer: Codex, configured model `gpt-6-astra` (explicit parent dispatch confirmed; not a runtime self-identification claim).
- Package: `1.0-rc1`.
- SHA-256: `2c253b35664fcf68a67ccad285db371f7e57f22c9c4ae9cb2edf4566deb97ea3`.
- Verdict: **REQUEST_CHANGES**.

All 11 manifest file hashes and the aggregate package hash were independently recomputed and matched. I read the normative package before issuing this verdict, without reading Fable's review. Scope is Stage 2 design and roadmap sequencing, not implementation, live integration, production readiness, or detailed architecture for Stages 3–9.

## Obligatory findings

### A1 — P1: Define publication authority for overlapping sign-in rereads and split windows

**Files/sections:** `02_CONTRACTS.md` §3 (`M365SignInWindow`, `M365WindowEvidence`), §5; `03_CONNECTOR_SYNC.md` §5; acceptance B5/C4.

**Failure:** Routine rereads intentionally overlap. An already COMPLETE hour can coexist with a new read of the same interval or two completed half-hour children after splitting. The contract permits only nonoverlapping COMPLETE leaves, but defines neither persistent parent/child lineage nor which published leaves are authoritative across rereads. Reusing one window row is also insufficient as specified: changing COMPLETE to RUNNING hides last-good data, while deleting or replacing its memberships can destroy the published result before the new traversal completes. Separate rows avoid that problem but leave publication precedence undefined. Consequently a reader can select old evidence, mix refresh attempts, or attach a fresh retrieval time to evidence not covered by that traversal; cursor fingerprints have no defined publication authority to bind.

**Required fix:** Specify one bounded publication model: immutable attempt memberships plus a scoped published revision/selection, or equivalent. Define persisted split ancestry/container state, how overlapping completed runs are selected, preservation of last-good data during retry/failure, stale-attempt fencing, and how evidence/freshness/coverage and cursor fingerprints derive from the same selection. Preserve immutable conflicting evidence without representing its older retrieval as newly verified. This requires no scheduler or delta protocol.

**Required test:** Publish an hour, start a reread, crash/fail it, then reread with a split where one half succeeds and one fails. Race older/newer completions. Verify deterministic items, last-good visibility with truthful freshness, exact gaps, no mixed staging, and cursor invalidation when the authoritative selection changes.

### A2 — P2: Cleanup authority cannot execute its required transaction

**Files/sections:** `02_CONTRACTS.md` §6; `05_ACCEPTANCE.md` C5.

**Failure:** The maintenance role is restricted to SELECT/DELETE on new payload/membership tables, yet cleanup must atomically clear expired `M365ResourceState.activeGenerationId` and record `retention.completed`. The pointer update and audit insert are not authorized by that role. With a restrictive pointer FK, deleting the expired active generation fails; doing the operations through an owner connection would violate the confinement design. Scope-only RLS and unrestricted DELETE within scope also do not establish C5's promise that maintenance can delete *only expired* payload.

**Required fix:** State the actual confined execution mechanism, including narrowly permitted pointer mutation and allowlisted audit insertion (or a carefully constrained routine), transaction boundaries and concurrency with publication. Specify whether expiry is enforced by SQL privileges/policies/routine or service logic, and align C5 with that guarantee. Preserve the ordinary runtime role's lack of DELETE and prohibit deletion of existing audit/event/link rows.

**Required test:** Using the real maintenance identity, expire an active generation, clean it and verify pointer/state/audit atomically; inject rollback and race a fresh publication. Verify fresh payload and another scope cannot be deleted through the promised boundary, and the ordinary runtime cannot delete payload.

### A3 — P2: ACTIVE-only outbound rule prevents initial activation

**Files/sections:** `02_CONTRACTS.md` §1; `03_CONNECTOR_SYNC.md` §§2–3; existing `packages/connections/connections.ts`, `resolveConnectionForActivation` and `resolveCredential`.

**Failure:** Both normative files require ACTIVE before secret lookup and every outbound call. Foundation binding starts DISABLED and deliberately issues a distinct activation-purpose capability for probing that DISABLED binding. Stage 2 activation must verify tenant/users/devices before marking it ACTIVE, so literal compliance prevents the first token request; marking ACTIVE first would expose an unverified connection.

**Required fix:** Explicitly preserve a narrowly scoped activation-purpose exception for a bound, DISABLED, non-FIXTURE connection. Limit it to token acquisition, tenant verification and bounded capability probes; recheck binding and activation authority before calls and atomic activation. Ordinary sync/publication/correlation still requires ACTIVE. Distinguish an authorized activation from subsequent revocation so an old issued capability cannot revive a revoked operation.

**Required test:** Start from a newly bound DISABLED connection and successfully activate through mock tenant/capability verification; test wrong tenant, FIXTURE, revocation during the probe, and replay of an old activation capability. None may expose normal reads or publish evidence before successful activation.

## Nonblocking notes and limits

The canonical/source-reference separation, guest handling, id versus deviceId distinction, no-PII Decisions boundary, old-surface filtering requirement, and approval-before-write roadmap are sound directions. Existing context and mapping source inspection confirms filtering and permission changes really are required; the package already schedules them.

I spot-checked the official [List signIns](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-1.0) and [deviceDetail](https://learn.microsoft.com/en-us/graph/api/resources/devicedetail?view=graph-rest-1.0) documentation. The documented user-sign-in subset and optional query parameters support the deliberately limited source contract. This is not tenant capability or live join verification.

No implementation was changed, application tests run, database migrated, tenant contacted, or account modified. Existing source was inspected narrowly for scope, mapping, context, connection activation and audit compatibility. Resolve A1–A3 and submit the new manifest hash for rereview; this verdict does not transfer to revised files.
