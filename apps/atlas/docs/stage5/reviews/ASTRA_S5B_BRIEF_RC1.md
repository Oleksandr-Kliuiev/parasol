# Independent S5-B implementation-brief review — RC1

**Verdict: CHANGES_REQUIRED.** Two bounded brief corrections are required before implementation. This is a source-backed review of the concrete S5-B brief, not actual-code acceptance. No S5-B source implementation was present or approved.

Reviewer assignment: fresh native Codex subagent `/root/astra_s5b_brief_rc1`, explicitly assigned **gpt-6-astra / xhigh**. Effective effort remains **xhigh**. The supplied native task assignment establishes the requested reviewer identity; this interface does not expose independent underlying response-model telemetry or attributable subscription usage. No CLI/API fallback, paid-credit route, external reviewer, provider/vendor request, or other reviewer's current-brief verdict was used.

Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`. Review date: 2026-10-10 UTC.

## Reviewed identity and preservation

- Brief: `docs/stage5/S5B_IMPLEMENTATION_BRIEF_RC1.md` (129 lines), SHA-256 `a627b9e1b3b83974a7fdaed4cc25f45823edb3ab4a907f63c5edf5725d09ce67`.
- Nine-file package: `ef0d78ed5f2d10e658ca59f397d5225a7b37be63ffe167e0e171827aca056963`.
- Manifest: `verification/stage5/S5B_BRIEF_RC1_MANIFEST.json`, SHA-256 `71a5063e504e6a2c7cb961173a7a373c9b7f25432184187451d6e17e44110d4f`.
- Archive: `verification/stage5/S5B_BRIEF_RC1_PACKAGE.zip`, SHA-256 `ceef55cbccf178bc3cc59768d5292da4b75618f85af397dc26178c46115c32e6`.
- Baseline: `verification/stage5/S5B_BASELINE.json`, SHA-256 `ad0f8b6677bd4a4662c58d7362a3bf05b62692ff304dd12e9e1b43cd4cc969ad`.
- Working inventory: 986 files, hash `67313d58d0005061eae460133210034cd03665ca417617fc35d36129d91fd7ca`; built inventory: 181 files, hash `c621ace2398a4916695b6e953bef9143ef777fb21dc823b4bcb76ebc316f72c8`.
- Controlling eight-file architecture package: `b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7`; design seal SHA-256 `bd6e49ac7f20692d242c744062f7ae780fedee413f41d5759e912108f6220c60`.
- Accepted S5-A seal SHA-256: `93fe2b27aad04bdfc257ee920b566a81099370dbd5c75792b222d3675f998aa7`; accepted S4-C seal SHA-256: `0a7f21f676edb3d3f07c921214254003d2625a478a9bc9c0a79f243860b1573b`.

Before and after review, all nine package files, 986 working files, 181 built files and the archive matched. No added/missing working or built paths. All 984 preparation-baseline files matched. Independently checked the 978-file S5A-rc2 inventory against its four recorded administrative closure deltas; all other files and all 181 built files were unchanged. S5-A and design archives/manifests/seals matched; all eight normative files and the design archive members matched. Package/inventory hashes were independently recomputed using the manifest's SHA-256/two-spaces/path/newline rule.

## Required findings

### R1 — Specify the accepted evidence POST success status (P2)

**Brief location:** lines 55–68, especially line 68's extension of the existing transport to POST.

The brief defines the POST body, headers, bounds and validation but never specifies its successful HTTP status. The accepted transport is GET-only and rejects every status except 200 (`apps/operator/src/transport.ts:48–55`). Both accepted evidence controllers use `@Post('execute')` without an `@HttpCode` override (`apps/api/src/atlas.module.ts:76–84`; `apps/api/src/db/tools.ts:30–42`). Their actual pinned Nest behavior is HTTP **201**; the existing HTTP/PG test already asserts 201 together with the resulting diagnostic headers and successful ledger row (`tests/pg/api-input.pg.test.ts:89–96`). Reusing the current success predicate would discard every successful evidence response after the Gateway has executed and audited it, breaking B3/B8.

**Independent reproduction:** `/tmp/atlas-stage5/astra-s5b-brief-rc1/status-probe.mjs` imports the frozen compiled controllers and pinned Nest response-status resolver without starting a server or making requests. Both controller methods resolve to POST/201 with no override. A synthetic response through the frozen browser transport succeeds at 200 and returns `HTTP_ERROR` at 201. Output: `status-probe.json` in the same directory. This demonstrates the source-contract integration gap; it does not claim that unimplemented S5-B code already contains the bug.

**Bounded fix:** state the closed operation-specific response policy explicitly: existing GETs require 200; evidence POST accepts the existing controllers' 201 JSON ResourceView response. Preserve the existing content-type/redirect/body/deadline/validation guards and 401/403 treatment. Do not change either server controller, broaden all GETs to arbitrary 2xx, or change accepted audit semantics. Require fixture and DB positive evidence journeys to exercise the actual 201 response, plus a focused regression that preserves the GET success rule.

### R2 — Resolve the screenshot/evidence prohibition (P2)

**Brief location:** lines 121–128, especially line 126: “No screenshot/trace/HAR/video/log/token artifacts”.

That wording prohibits screenshot artifacts outright, while the same brief requires responsive visual review and visual evidence, and controlling B9 explicitly requires screenshots at 320/768/1440 (`docs/stage5/06_ACCEPTANCE.md:28–32`). The established visual test captures synthetic ready-state screenshots only after the password input is empty (`tests/ui/console-visual.spec.ts:27–36`). “After token cleared” at line 122 is also ambiguous: disconnecting/clearing the memory credential would synchronously remove the S5-B queue/detail/evidence that the screenshots must inspect.

**Reproduction:** read the two contradictory instructions in the same reviewed package. This is an instruction-level contradiction; no application run is needed.

**Bounded fix:** explicitly allow and require synthetic screenshots at the three widths after the password **input** has been cleared and the DOM/artifact is verified token-free. Keep traces/HAR/video and credential-bearing captures prohibited. Clarify that safe check reports/log evidence may be retained while tokens, Authorization, private URLs and raw sensitive diagnostics may not. Preserve the memory-only credential boundary; do not require disconnecting before an authenticated synthetic UI screenshot. This restores the existing B9 and evidence requirements without adding a new capability.

## Source-parity and completeness assessment

Apart from R1/R2, the brief provides an implementable concretization of the approved scope:

- **B1 / queue:** fixed fixture GET with no query matches `atlas.module.ts:63–65`; DB query options match `http-boundary.ts:30–47` and `db/clients.ts:26–30`. Defaults, cursor resets, bounded page replacement, source order and non-atomic counts are covered. The controlling requirement in `02_CONTRACTS.md:37–38` still requires every returned DB item to match the captured status/severity selection and page length to fit the requested limit. Include those assertions when extracting the standalone validator; the brief's 100-item ceiling is not a replacement for that request-specific rule.
- **DTOs / B2/B5:** listed fields correspond to the core Person, Device, ExternalLink, ObservationSummary, SnapshotItem, ResourceView and ObservationPage DTOs. Existing S5-A identifier/enum/time/nullable checks, whole-context validation and array/byte bounds are retained. Free-text snapshot status/priority is not incorrectly converted to Atlas enums. Explicit projections exclude email, normalized facts/externalDevice/receivedAt and undisplayed additions. Exact unambiguous entity IDs and confirmed links prevent name/hostname inference; missing rows stay unresolved. Source urgency remains independent of confidence/route/priority text. Safe DOM construction remains mandatory under controlling `03_SECURITY_AND_STATE.md:44–46`.
- **B3/B4 / evidence:** the operation allowlist matches `registry.ts:100–108`. Alert list filtering uses DB `externalId` versus fixture `externalEventId`; ticket get uses DB `externalId` versus fixture `id`. The fixture Huntress exclusion correctly accounts for `registry.ts:74–78` selecting only `externalId`/`id`. Request references are validated unshortened, tuple/scope/mode are bound, and malformed/unsupported selections send no request. Null/empty/truncated/STALE/FIXTURE and independent times retain accepted meanings. No broad fallback or vendor link is added.
- **B3/B7 / server effects:** actual Gateway execution and existing ToolExecution/client/security audit outcomes remain required; GET success audits are not invented. DB readers use the existing scoped stored context (`prisma-ledger.ts:49–52`). No source call, authority cache, financial/M365 path, business mutation, generic executor or new server contract is introduced.
- **B6 / isolation:** synchronous resets, credential/scope/panel generations, selected observation/source binding, stale success/error/401/403/finally rejection, current 401 disconnect and current 403 full scope reset/picker refresh are specified. Context validation gates queue/evidence. Abort is explicitly insufficient by itself.
- **B8/B9 / verification and S5-A regressions:** the brief calls for real fixture and disposable DB journeys, browser DOM/storage/network checks, ignored-abort races, negative controls, all established checkpoint checks and fresh production install/build/serve verification. Original-deadline enforcement through synchronous validation and fixture pagination rejection are explicitly preserved. R2 must be fixed so the visual evidence instructions can be followed consistently.

## Gate decision and residuals

The brief stays inside the accepted eight normative documents. **Neither required correction changes architecture, authority, data boundaries or public server contracts, so these fixes do not require a new dual Astra/Fable architecture amendment.** A revised exact package should receive bounded re-review before code. Any actual material boundary change still requires both architecture reviewers. Initial actual-code S5-B acceptance must use a separate fresh explicit Astra/xhigh reviewer; this brief review cannot satisfy it.

No build/generate, full application suite, database, browser server, migration or source mutation was run at this source-free design gate. The only runtime probe read frozen compiled code and used synthetic in-process Responses. All review outputs were written under `/tmp/atlas-stage5/`; repository and dist remain frozen. Verification script and final result: `/tmp/atlas-stage5/astra-s5b-brief-rc1/verify-frozen.py` and `final-freeze-verification.json` (2026-10-10T14:32:24Z). Application correctness, rendered UX, restored-byte negative controls and audit/DB outcomes remain for actual implementation acceptance. Accepted memory-only credential, abort/server-work, bounded-context and fixture limitations remain; Ask Atlas and LIVE/pilot/deployment are excluded.
