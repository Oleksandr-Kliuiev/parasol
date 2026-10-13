# Independent architecture re-review — R-EVAL server RC4

**Verdict: APPROVE_ARCHITECTURE. Required findings: 0. R1 CLOSED.**

Artifact: `S5ASKREMOTE-REVAL-SERVER-DESIGN-rc4`.
Package SHA-256: `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`.

This verdict applies to this exact RC4 architecture artifact. It is a bounded re-review in my own independent RC2 reviewer context. RC3 was interrupted/withdrawn without a verdict; no RC3 approval is inherited. No other reviewer's verdict, author conversation or administrative DESIGN_STATUS was used in this re-review.

## Identity and scope

Recomputed manifest hash matches. All 38 entries match both checkout and ZIP; all 29 dependency hashes remain unchanged from RC2 and match their files. ZIP SHA-256: `367fc6927f05fa77fcf0d6390e4881599a3557a336ba3afa2a07afee46ab5843`. All eight normative Markdown files have balanced code fences; largest is335 lines. The final pre-report hash check found no drift.

I reviewed the complete RC2→RC3 and RC3→RC4 normative deltas plus affected surrounding contracts. The changes clarify the original intended manual preparation, one-use arm and authority boundaries; they introduce no new inference, owner privilege, financial/refund capability, source-data scope or persistence channel. A bounded same-session re-review is appropriate; these repairs do not require a fresh architecture review on account of new critical scope.

The checkout remained read-only. This report is the only file written in this re-review. Checks were static; no runtime, PostgreSQL, browser, provider, network, account, paid-call or activation operation was performed.

## Finding closure and nearby regressions

**R1 closed:** `04_TRANSIENT_HANDOFF.md:154`–`183` now defines reachable event transitions. Repeated typing preserves the latest draft; manual fixed-choice selection preserves that draft and the newly selected choice. Editing clears the old choice/consent and requires manual reselection/fresh consent. External invalidations clear both inputs. Submission captures an immutable tuple before clearing the form without invalidating its own pending identity; stale events cannot mutate newer state. The synthetic-only departure from ordinary focus-change draft clearing is explicit. The journey at lines136–138 and fixture-switch procedure agree. `05_PROOFS_AND_ACCEPTANCE.md:164`–`165` requires actual typing/readiness/edit/reselection and generation tests for NONE, FOUND, FX10 MISSING, all15 FX10 cases and all200 frozen paths.

**First-current-GO clarification is coherent:** `04_TRANSIENT_HANDOFF.md:56`–`120` distinguishes the newly consumed current case from prior-consumed cases. I records consumption and single issuance before writing ARM_CASE; C/S record seen/current state before fallible arm checks. Existing authenticated frame/PRE bindings support one forward/arm without new caller authority fields. Failed sends/checks, duplicate frames or fresh-sequence duplicate cases, lost ARM/READY acknowledgements and continuity loss cannot re-arm or advance to another case. Consumed/seen sets survive pair/fixture/policy/day changes. The required first-arm acceptance row covers these schedules. Source/provider deadlines, original liability and closure obligations remain intact.

**Other bounded clarifications are consistent:** the separate exact `atlas_reval_snapshot()` ACL avoids enlarging the existing nine-routine remote allowlist; table-owner credentials remain in an explicitly initiated short-lived owner executor, outside resident C/I/S state. Post-authentication registered workspace/client/actor equality precedes phase1/source/reservation and creation of a registered Binding. Manual pairing entry is confined to sealed dedicated console assets without extending AskCapabilityV2. The source-only clock and consume-before-ARM departures from frozen RC6 wording are now named explicitly while preserving accepted dependency bytes and requiring later integration resealing.

The unchanged atomic census/original-period accounting, private dispatch-proof separation, fence-first pause versus drain, terminal-fault precedence, transient handoff schemas, strict frame bounds and persistence allowlists remain compatible with these repairs. No new required finding was found.

## Qualifications and remaining gates

Approval is architectural only. RS-A–RS-D still require separately authorized implementation, exact source/build manifests and independent Sol/Opus acceptance. Target-platform immutable-image/peer/process proof, actual PG17/grant/concurrency evidence, browser/PTY/privacy tests and measured journal/ARM latency remain implementation obligations. Synthetic FX08 time semantics, unknown-liability no-credit and raw-evidence replay limits remain explicit. Human labels, account/retention, data, budget, actual evaluation and deployment admissions remain separate. No verifiedPass/liveAcceptanceEligible flag is approved to change here.

Requested reviewer assignment is native Codex `gpt-6-astra`/`xhigh`, continuing the same independent review session. Backend response-model identity, effective effort, provider routing/billing and attributable usage are not independently exposed to this session. Requested identity/self-identification cannot establish those facts; this content verdict does not certify the named-model/billing telemetry gate. Preserve this limitation alongside any launcher-side evidence.
