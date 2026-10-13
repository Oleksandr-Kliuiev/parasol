# Independent architecture review — R-EVAL server RC2

**Verdict: CHANGES_REQUIRED. One required finding (R1).**

Artifact: `S5ASKREMOTE-REVAL-SERVER-DESIGN-rc2`.
Package SHA-256: `3438a5917dfecf978b3ad4308c7a89c15af442bf1c97521434ef91e1150edf90`.

This was a clean independent static review. I received the common requirements and exact artifact, not the author's conversation or another reviewer's verdict. The eight normative documents were read; relevant frozen financial, HTTP, browser, fixture and evaluation dependencies were checked narrowly. No implementation, runtime/DB/browser/provider/network test, paid call, activation or account operation was performed. The repository remained read-only; this report is the only file written.

Identity checks: all 38 manifest entries match the checkout and packaged ZIP; all 29 dependency-reference hashes match. Recomputed package hash matches the stated hash. ZIP SHA-256 is `5d9e539281270aee8fb16a72ae5d5cd545e1c8fd94c0f72aad482eb7abd31afb`. A final pre-report check found no artifact drift. Referenced remote DESIGN RC2, preparation RC6, offline RC3 and execution RC5 package identities agree with their pinned metadata. This does not independently accept execution RC5 or any later repair.

Requested reviewer assignment: native Codex `gpt-6-astra`, `xhigh`, fresh context. Backend response-model identity, effective effort, provider-routing/billing telemetry and attributable usage are not independently exposed to this review session. Requested identity and this report's authorship are not proof of those facts; the orchestrator must retain that qualification when recording the named-model gate.

## R1 — Required: make manual question/focus preparation reachable

**Location:** `docs/stage5/ask/remote/reval-server/04_TRANSIENT_HANDOFF.md:109`–`113`; conflicting intended journey at lines89–91 and inherited reset semantics in `docs/stage5/ask/remote/02_CONTRACTS.md:68`–`69`.

The new reset rule explicitly includes both question edits and choice changes among events that clear the draft **and manual choice**. It then requires reselecting the choice after a question edit. A literal conforming implementation therefore cannot reach the state required before GO: typing clears the draft/choice; selecting or reselecting clears the draft and the choice again. Even interpreting a choice change as installing its new choice after clearing the old one still leaves a cycle: typing clears choice, while reselecting clears the typed question. This affects every fixture, including the explicit NONE choice, and blocks the required 200-case manual path. Implementing the intended usable behavior would require inventing an exception to the normative reset rule.

**Required repair:** specify an explicit event transition contract distinguishing newly entered state from stale state. One coherent option is: a question edit retains the newly typed draft, clears manual choice/consent and old pending answer/handoff; a deliberate selection of the fixed evaluation choice retains that draft and the newly selected choice, clears consent and stale pending answer/handoff, and advances the evaluation generation. External context/scope/queue/policy/pair/lifecycle invalidations continue to clear both draft and choice. Declare any synthetic-only departure from ordinary focus-change draft clearing explicitly; ordinary console behavior remains unchanged. An alternative is acceptable if it gives an unambiguous, reachable manual preparation sequence while preserving fresh consent, stale-result isolation and no automatic selection/submission.

**Required acceptance evidence:** the repaired contract must require browser tests demonstrating actual typing/editing and manual selection can produce a ready request for NONE, FOUND and FX10 MISSING; editing after selection follows the declared reset/reselection sequence; no stale callback restores consent/choice or retargets a submitted request. Keep the all200/15-FX10 matrix.

## Other conclusions and retained obligations

No other required finding emerged from this static review. In particular, the proposed atomic full census and original-period accounting, private no-dispatch proof separation, fence-first pause versus drain distinction, registration-lifetime ingress claim, source-only synthetic clock, distinct safe terminal-fault channel, and closed transient READY/TRANSFER/ACK/COMMIT protocol preserve the stated critical boundaries at the design level. Known authenticated faults retain FAILED precedence under unknown financial/publication outcomes; missing evidence supplies neither zero nor positive credit.

The design correctly leaves actual physical database isolation, role/grant confinement, immutable launch/peer measurement, complete platform coverage and privacy scanning to independently accepted implementation evidence. The FX08 future-relative synthetic reference and inability to replay raw truth/intent after cleanup are explicit qualifications, not live guarantees. Preserve RS-A through RS-D dual Sol/Opus acceptance, exact resealing and the separately pending human/account/data/budget/evaluation gates. This review grants no implementation scope, paid inference, activation, deployment, verifiedPass or liveAcceptanceEligible transition.

After R1, re-freeze the exact artifact and obtain the required independent architecture verdicts on that same identity. This report does not approve RC2 conditionally.
