# Independent Stage 5 design review — RC2

**Verdict: CHANGES_REQUIRED.** Both RC1 findings are closed. One localized inconsistency in the newly specified DTO projection remains; it requires only a precise design correction, not API/source changes or broader scope.

## Reviewed identity

- Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`; branch: `planning/stage2-m365`.
- Scope: same eight normative Stage 5 files (AGENTS, README, 01–06). Compared exact RC1 archive bytes against RC2; seven files changed.
- Package hash: `45ae1eba60c0278c7831670c3589c9c0c05d62780e743337b74e0e0458ebccf1`.
- Manifest SHA-256: `fee9b7d073959db05ce369238c03422be7c5cc4daaf1e1514ce5b699fdd2fca2`.
- Archive SHA-256: `937f9d4bb868f92d15d2e51668bcfda914c314bca1a2791b645d76e34e174893`.
- Baseline SHA-256: `bad263dc48eafaa571a0e84c7995b6a9813ae1f96b30671d28d128af46d20b4d`.
- Assignment: bounded continuation of the original explicitly assigned native `gpt-6-astra` reviewer; effective effort remains `xhigh`. Provider response-model telemetry remains unavailable; no provider-level identity attestation is claimed. No other reviewer's current verdict was read. No external model/vendor calls, API billing, credits or fallback were invoked.

## Closure

**R1 CLOSED.** `01_SPEC.md`, `02_CONTRACTS.md` and B1/B8 now explicitly make fixture observations a fixed demo page with unsupported filter/page-size/pagination controls unavailable and no ignored-query claim. DB mode carries the complete filtering/pagination/count journey. A4 assigns equality-token testing to fixture mode and stored-token expiry/revocation testing to PG. Existing API behavior is preserved.

**R2 CLOSED.** The evidence table explicitly makes fixture Huntress lookup unavailable with no tool call, broad-list fallback or absence claim. Positive fixture evidence uses the Atera alert list with validated `externalEventId`, scope/source/resource/connection matching; DB mode proves get-tool positives. Diagnostic headers are optional and the known fixture header omission is acknowledged. These address the original retrieval defect without changing accepted source.

## Required finding

### R3 — Make the new fixture field projection consistent with its source and unknown-field policy (P2)

`docs/stage5/02_CONTRACTS.md:53–54` lists the normalized fixture item fields as including `summary/severity/occurredAt`. The actual `NormalizedEvent` field is **`sourceSeverity`**, not `severity` (`packages/core/contracts.ts:112–126`; `connectors/atera/normalizer.ts:13–15`; `connectors/huntress/normalizer.ts:10–12`). These normalized objects are precisely the items stored by the actual fixture context. The new allowlist therefore names a nonexistent input field and omits the source's actual severity field. A literal validator would reject the required positive Atera fixture journey or lose its severity; a compliant implementation should not have to invent an undocumented rename or fallback.

The new `02_CONTRACTS.md:57` also requires undisplayed additive fields to be ignored after validation, while retained `04_ARCHITECTURE_AND_UX.md:40–41` says unknown fields fail validation. This leaves strict rejection versus allowlisted projection contradictory, including how to handle the fixture event's undisplayed `facts`, `receivedAt` and `externalDevice` and genuinely new additive properties.

**Closure:** Name `sourceSeverity` in the normalized fixture input allowlist. If the UI's private view model calls it `severity`, explicitly define that mapping and validate the original source enum without accepting a different input field as a substitute. Align 04 with 02: unknown item shapes and invalid/missing projected fields or recognized enum values fail; undisplayed additive keys are ignored and never rendered, treated as identity/authority, or used to override projected fields. Preserve the existing no-raw-object rule. The later implementation checks should cover an actual fixture alert, malformed `sourceSeverity`, and an additive field that cannot override the validated projection. No application tests are needed for this source-free correction.

## Nearby review

The explicit root/browser TypeScript partition, DOM-free parity constants, separate browser typecheck, selected-context validation at S5-A, bounded picker search, full current-403 reset, nested scope/confirmed-link checks, returned resource tuple validation, omitted email, no-slash 404 and optional diagnostics introduce no further mandatory finding. The browser build still requires actual import-graph and packaging evidence at implementation acceptance.

The existing same-origin/Host/CSP/static-path boundary, memory credential and bfcache lifecycle, response caps, deadline, generation guards, server-owned permission/audit boundary and preserved in-flight authorization semantics remain coherent. No stronger Stage 1 transaction semantics, vendor calls, new permission/endpoint/schema, LIVE/pilot/deployment or Ask Atlas implementation is required or approved here.

## Preservation and residuals

Verified the supplied manifest hash, all eight file hashes, recomputed sorted-line package hash, and ZIP identity/entry bytes. Verified accepted S4C seal/review hashes against the baseline metadata without reading those reviews. Of 894 baseline files, 891 are byte-exact; the other three match the declared administrative-routing before/after hashes. There are no new source files.

End checks confirm all 894 current baseline hashes, eight design hashes, manifest/archive, HEAD/branch and repository path inventory remained unchanged throughout review. Evidence is under `/tmp/atlas-stage5/astra-design-rc2/` (`identity-before.json`, `identity-after.json`, baseline snapshot and exact design diff).

No repository writes, builds, generation, database work, application tests, status edits or seals were performed. This is a source-based architecture re-review, not implementation acceptance. Correct R3, freeze the next exact package, and obtain both required approvals on that identity before code begins.
