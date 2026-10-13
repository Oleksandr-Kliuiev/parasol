# Independent Stage 5 design review — RC1

**Verdict: CHANGES_REQUIRED.** The local read-only architecture is feasible, but two fixture compatibility contradictions must be resolved in the normative package before its architecture gate closes. These are design corrections, not a request to reopen Stage 1–4 or add LIVE scope.

## Identity and independence

- Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch: `planning/stage2-m365`.
- Reviewed scope: exactly the eight frozen `docs/stage5/{AGENTS,README,01_SPEC,02_CONTRACTS,03_SECURITY_AND_STATE,04_ARCHITECTURE_AND_UX,05_IMPLEMENTATION_PLAN,06_ACCEPTANCE}.md` files.
- Package hash: `eb2ca966fc4b2487e57bb8e24ed584a846c5eb0516a7ee00032102c32d415388`.
- Manifest SHA-256: `7a1a9ea9bed36dfadedfa0b5eaff15370a1a45c48a7fa5e9db28b86f4fc234dc`.
- Archive SHA-256: `349bea14dae76b7f161679fce04056c6a8700db0baceba5f38077c7a47177f86`.
- Baseline SHA-256: `bad263dc48eafaa571a0e84c7995b6a9813ae1f96b30671d28d128af46d20b4d`.
- Accepted S4C seal SHA-256: `0a7f21f676edb3d3f07c921214254003d2625a478a9bc9c0a79f243860b1573b`; accepted review SHA-256: `db3438cba73b68a1f4cf78b5fd9f6b035ff18272933e18732c6257bafea17bac`. Both verified by hash only.
- Fresh independent native assignment: `gpt-6-astra`, explicit effective effort `xhigh` per native launch assignment. Provider response-model telemetry is unavailable in this agent context; this report does not represent independent provider-level identity attestation. No external model/vendor calls, API billing, usage credits or fallback were invoked.
- No other reviewer's verdict was read. No implementation, builds, application tests, database operations, generation, status edits or acceptance seals were performed.

## Required findings

### R1 — Define the fixture queue capability instead of promising unsupported server filtering (P2)

`01_SPEC.md:8–9`, `02_CONTRACTS.md:21–25` and acceptance B1 describe server-backed status/severity/limit/cursor behavior for a console that includes fixture and DB journeys. At the same time, `01_SPEC.md:22` and `04_ARCHITECTURE_AND_UX.md` require existing API behavior to remain unchanged.

The actual fixture GET controller at `apps/api/src/atlas.module.ts:63–64` takes no query arguments and always returns the fixed `demo.context.observations` page. For example, requesting `status=RESOLVED`, `severity=LOW` or `limit=1` still returns the same two active MEDIUM/CRITICAL observations and their original counts. The DB route does parse and apply those queries (`apps/api/src/db/clients.ts:26–30`; `packages/observations/query.ts:44–60`). The existing filtering helper in `packages/tools/registry.ts:131–141` belongs to a different operation, `atlas.observation.list`, which the Stage 5 allowlist does not permit for this purpose.

Consequently an implementation following RC1 either displays controls that do not work, silently introduces client filtering with different count/page semantics, or changes an API/operation outside the declared preservation boundary.

**Closure:** State a mode-specific fixture limitation in the normative UX/contracts/acceptance: the unchanged fixture is a fixed queue with unsupported filters/page-size/pagination visibly disabled or omitted, while the complete filter/page/count journey is proved on disposable PG. Alternatively, explicitly approve a bounded fixture behavior change in the revised architecture; do not leave that choice to implementation. Allocate authentication acceptance A4 by actual capability as well: fixture authentication is a fixed environment-token equality check (`atlas.module.ts:20–30`), so genuine stored-token expiry/revocation evidence belongs to DB mode. This does not require adding fixture expiry/revocation.

### R2 — The selected fixture Huntress incident cannot be retrieved by the mandatory get action (P2)

`02_CONTRACTS.md:45–54` classifies `huntress/incident` as supported and requires `huntress.incident.get` using the observation's `externalEventId`, with no list fallback. Acceptance B3/B4/B8 expects an honest selected-source evidence journey in fixture and DB modes.

`fixtures/run-demo.ts:20–21,38` stores a `NormalizedEvent` as the fixture incident item. Its identifier is `externalEventId: 'demo-incident-1'` (`connectors/huntress/normalizer.ts:10`; `packages/core/contracts.ts:112–126`); it has neither `externalId` nor `id`. The accepted get implementation at `packages/tools/registry.ts:74–78` filters solely by `item.externalId ?? item.id`. Therefore the mandated fixture request returns `status: 'FIXTURE', items: []` even though that same incident is present in the context resource. Browser field allowlists cannot recover an item already discarded on the server. The passing existing unit test covers a missing resource, and the PG get test covers snapshot items with `externalId`; neither establishes a successful get of this fixture incident.

**Closure:** Define the fixture Huntress route as unavailable with a specific limitation and no misleading absence claim, retaining positive evidence retrieval coverage on a supported fixture source and on PG; or explicitly scope and review a fixture-compatible item/get correction. Do not add a silent broad-list fallback. The S5-B field brief must distinguish real snapshot `SnapshotItem` shapes from the existing normalized fixture alert/incident and small ticket shapes; the Atera local exact-ID filter needs an explicit validated fixture identifier rule.

## Other assessed boundaries

No additional mandatory architecture finding was identified in the following areas:

- The opt-in exact loopback Host gate, browser origin refusal, fixed asset manifest, traversal refusal, missing-assets startup failure, CSP and security headers form a coherent local-serving boundary. A separate DOM-only TypeScript build with valid emitted module extensions is feasible with the pinned compiler. Implementation must demonstrate the actual emitted import graph and production packaging as specified.
- A private credential holder, cleared password field, no persistence, synchronous pagehide cleanup and disconnected bfcache restoration are compatible with the stated local threat boundary. The design appropriately makes no secure-erasure, remote-revocation or production-session claim.
- Incremental 4 MiB response caps, bounded arrays/strings, a total browser deadline, explicit retries and credential/scope/panel generations cover the relevant browser consumption and stale-completion risks. Checks must include stale failure/401/403/finally paths and ignored AbortController, as required by the matrix.
- Existing bearer-to-Actor authentication, per-client access/RLS, all-of Gateway policy, explicit connection selection and ledger/audit settlement remain authoritative. The design correctly preserves accepted in-flight read/revocation semantics and does not infer DB cancellation from browser abort.
- Text-only field projections, fixed request templates, no supplied hyperlinks or arbitrary tool execution, source urgency, unresolved entities, freshness/absence/truncation distinctions and separate observation/evidence times are appropriate. Exact item field validation is a legitimate S5-B brief deliverable, provided the fixture discrepancy above is settled first.
- The S5-A then S5-B stopping points and independent code-acceptance gates are workable. Ask Atlas requires its separate later contract. No production, LIVE, pilot, new endpoint, permission, schema or unrelated dependency upgrade is required by this review.

Nonblocking precision for the S5-B brief: explicitly compare returned ResourceView source/resource/connection metadata with the captured request tuple, check nested scoped graph rows, and treat diagnostic headers as optional when absent. The existing fixture controller emits a correlation header but no tool-execution header; this should not cause fabricated diagnostics or a false validation failure.

## Verification and residuals

Verified all eight file digests, recomputed the documented sorted-line package hash, and verified the ZIP has exactly those eight entries with identical bytes. Checked all 894 baseline files: 891 match exactly; the other three match the declared before/after administrative-routing hashes. No new source file exists outside that baseline.

Repeated preservation checks at the end: all 894 current baseline hashes and eight design hashes unchanged during review; manifest/archive/HEAD/branch unchanged; no added or removed repository path. Scratch evidence: `/tmp/atlas-stage5/astra-design-rc1/identity-before.json` and `identity-after.json` (with a before snapshot).

Findings are established by source inspection, not executed application tests. No code exists to accept at this design checkpoint. R1/R2 need a new frozen package and renewed required approvals on that same artifact. Browser behavior, DTO validators, visual accessibility and runtime integration remain implementation-checkpoint evidence obligations.
