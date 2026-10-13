# ASK-REMOTE R-B RC1 independent acceptance

**CHANGES_REQUIRED — R1 and R2 must be repaired before R-B acceptance.**

Reviewer: explicitly assigned **gpt-6-astra**, effective effort **xhigh**, fresh independent session. No other reviewer verdict was supplied. Review covers actual code and evidence, with all writes/builds/tests restricted to the isolated sealed-source scratch copy.

Candidate `S5ASKREMOTE-RB-rc1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`.
Package `5b711d7f2f365cffb0d68add4c3718fe1df2efc5af1ba4cc0a8eefa9ecda7d0f`.
Manifest SHA-256 `22687532791224ba20767a6fc860c9da73fcd08b74073e8d7a30c2030205acf2`.
Source ZIP SHA-256 `6da6f0a13011ea9c386028d353d05de84311b4801f12e2f2da1d3008819a239a`.

Initial/final complete identities match:1279 working paths,1219 archived files,244 compiled files. Approved DESIGN RC2 ten norms, dependency seals and exact baseline/delta were verified. Native implementation identity is actual `claude-opus-5-5`/high, firstParty/claude.ai subscription routing, session `d7982c45-9ae5-4da2-9568-3c31a1d6c269`; native stream model/hash checked by candidate verifier.

## Required findings

### R1 [P1] — packages/ask/remote/dispatch.ts:82

The last original-4500ms floor check is in service.provide before dispatchIntent resolves the secret and copies prepared bytes. At lines80-83 dispatch checks only terminal/provider-phase expiry, then consumes the capability. A controlled 1ms advance during secret resolution changes original remaining4500 to4499; the actual service+dispatch path still calls the transport, settles usage and publishes200. This violates the explicit post-COMMIT floor immediately before capability consumption; production synchronous work or scheduling/GC time can cross the same boundary.

Required fix: Carry the original task-bound deadline/floor authority into the private consumption boundary, and recheck it after secret resolution/prepared-byte work immediately before consumption. Below4500 must remain undispatched, produce ASK_DEADLINE504 and allow only private known-no-dispatch settlement. Preserve one provider phase starting before resolution, opaque task/one-use capability and the fixed adapter input boundary. Add exact4500/4499 and resolver/preparation delay regression tests through production orchestration, including owner/drain and no-wire assertions.

Evidence: `adversarial.test.mjs:42`, `adversarial-results.json`, `logs/adversarial.log`.

### R2 [P1] — packages/ask/remote/transport.ts:58

The direct transport discards the already received HTTP status on overflow/error/abort and produces RESPONSE(status) only after end. A known401 response with65537 bytes yields OVERFLOW, so orchestration returns ASK_REMOTE_INVALID, settles DELIVERY_UNKNOWN, leaves the local circuit open and never attempts durable pause. The same401 with a small body correctly returns ASK_REMOTE_UNAVAILABLE, settles UPSTREAM_REJECTED and closes/pauses. An unending or failed error body likewise loses an already known status. This violates the fixed non-200 mapping and mandatory401/403 configuration-fault circuit.

Required fix: Preserve and classify non-200 status as soon as response headers arrive within the active provider phase; do not depend on successful body completion to recognize upstream rejection/auth faults. Keep all non-200 public replies ASK_REMOTE_UNAVAILABLE,401/403 immediate local close plus separate owner-held durable pause, full conservative reservation and zero retry. Bound/abort body cleanup while retaining the physical request+response ownership; never consume new late content after timeout. Add direct-transport-to-orchestration tests for401/403 and other non-200 statuses with oversized, stalled, aborted/error bodies, plus200 cap/late-body regressions.

Evidence: `adversarial.test.mjs:47`, `adversarial-results.json`, `logs/adversarial.log`.

## Independent verification and evidence limits

- Focused PostgreSQL **71/71 passed**, including real confined runtime/nonsuperuser provisioning, reservation lock waits, before-return/after-INSERT timing, terminal/unknown-COMMIT handling, accounting, circuit, HTTP/process and nearby accepted Ask helper/physical ownership behavior. Only disposable test databases were used via the silent approved wrapper.
- Typecheck/API/operator build passed. All **244 compiled files** reproduce exact candidate hashes; extracted **1219 source files** remain unchanged. Independent dependency directory is a recursive copy, not a root symlink.
- Full unit/PGlite run **392/393**, with one extraction-environment failure explained below. The affected unchanged suite subsequently passed **8/8**. The context-budget test passed.
- Three independent adversarial assertions: **two required failures**, one positive401control. R1 uses a deterministic original clock advanced1ms in the synthetic secret resolver; R2 drives the actual direct transport with an in-process response stream. Both go through actual remote service/dispatch/settlement selection. All three task owners fully drained.
- Inherited implementation evidence: **164 referenced proof objects hash/size verified**; all14checks recorded passing,393unit/PGlite,684PG17,73browser; clean production install/generate/build/dev-prune and foreigncwd OFF/MOCK/remote-inactive checks,244outputs reproduced. These checks were inspected/verified, not all independently rerun. Mutation16/17qualification below.

The floor SQL addition takes the existing fixed-order financial locks before the floor decision, preserves R-A confinement and calls the unchanged reserve routine; real-PG rollback/role checks pass. Private dispatch/refund states, per-statement phase guards, financial drain and post-audit current authority are present. The two defects concern the later adapter boundaries and remain acceptance blockers despite the existing green suite.

## Failed-probe disposition and nonblocking notes

- Original sealed-source unit run392/393: unchanged action-canonical protected-output test requires a Git checkout. Missing.git allowed its synthetic verification/never-written.json marker. Isolated git init fixed the boundary; the first focused recheck then exposed that already-created marker. Preserved marker as unit-initial-created-file.txt, moved it out of source, and final unchanged suite passed8/8. All three logs retained. This is an extraction/environment disposition, not a candidate product finding; no assertions or source files were changed.
- Inherited mutation results16/17 detected are supported by hash-bound logs. M12a is a redundant terminal-layer survivor, with combinedM12b detected. M03a is detected through rolling admission side effects; it is not evidence that removal bypassed SQL consent checks. The independent R1/R2 probes expose boundaries those mutations did not cover.
- Focused source modules satisfy the hard700-line check. Shared phase/auth extraction and pure selector preserve the reviewed boundaries; existing whole-plan compiler/local facts code remains unchanged. The additive floor routine does not establish floor enforcement by the legacy R-A reserve routine, nor does SQL establish process continuity for NO_DISPATCH.

## Residual gates

- CHANGES_REQUIRED; R-B is not accepted and dependent R-C must not advance. Required repairs stay in native Opus session d7982c45-9ae5-4da2-9568-3c31a1d6c269; renewed independent critical-boundary acceptance is required.
- Offline engineering review only. Zero paid/product/provider calls and no account/key provisioning, foreign credential reads, data/budget admission, browser R-C activation, deployment or other model invocation by reviewer.
- Real EU provider networking/TLS/account/project/retention eligibility, actual response shape, latency and semantic quality remain unverified. Transport evidence uses controlled in-process request seams, not vendor HTTP.
- No claim that abort retracts admitted egress or billing, that application reservations cap the provider invoice, or that unknown commits/refunds are reconciled. Unknown delivery retains the reserve. In-process holds last until physical promises/callbacks finish; never-settling work retains capacity.
- Full684PG,73browser, schema/drift/PG17 and clean install/dev-prune/foreigncwd production checks are inherited hash-verified implementation evidence, not newly rerun wholesale here. Independent copy uses copied dependencies, not an independent registry install.
- Native reviewer explicitly assigned gpt-6-astra/xhigh. Independent provider response telemetry and attributable subscription quota for this reviewer are unavailable; no alternate model/billing was used.

## Ownership and cleanup

All reviewer subprocesses finished. Metadata-only PostgreSQL baseline/final inventories match; four unknown preexisting `atlas_it_*` databases were untouched, and no test-owned resource remains. Original working and compiled identity is unchanged. Codex retained root write ownership throughout; the isolated copy, proof logs and scripts remain in this scratch directory. No paid product call was made.

Evidence schema and hash-bound proof inventory: `EVIDENCE.json`.
