# Independent Sol acceptance — S5ASKREMOTE-REVAL-EXECUTION-rc1

Verdict: **CHANGES_REQUIRED**.

Scope: local manual supervision/measurement/assertion instrument and offline fake-V2 rehearsal only. No live evaluation, data/budget admission, human attestation, model-quality measurement or deployment is accepted.

Review assignment: fresh native Codex review task `/root/reval_execution_sol`, explicitly requested `gpt-6.1-sol` / `xhigh`, separate from orchestration/implementation. The assignment file records those settings. Backend response-model/provider telemetry is **UNAVAILABLE**; this report does not use self-identification or the requested model string as proof of effective backend identity. Attributable subscription usage is unavailable. No other current execution reviewer verdict was supplied or consulted.

## Artifact and verification

- Artifact: `S5ASKREMOTE-REVAL-EXECUTION-rc1`.
- Manifest: `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC1_MANIFEST.json`.
- Recomputed compact sorted-entry SHA-256: `d23084ec0f7e9cd55823e7a0484b6f9425559e6d27e20ed65829f63260418f77`; all 110 listed files match.
- Package ZIP: `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC1_PACKAGE.zip`, SHA-256 `9761932af5996332ed6c3151ec96ba04424a3c88e0e6c2544236c7167869a52a`; all 110 ZIP entries match their manifest hashes.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`. All 1,431 updated-baseline files match `/tmp/atlas-reval-execution/baseline.json`. Comparing original and updated baseline inventories yields exactly the two declared routing deltas: `docs/AI_CONTEXT_MAP.md` and `docs/DEVELOPMENT_WORKFLOW.md`.
- Actual accepted-dependency verification passes: offline RC3 package `d706a437b2e77ccb215080d4676d2ae70fee53376636d3d9040590d5d8f2dc3a`; R-C package `9ae0c2b813388af58ee7d12e4df7f59521ba8cff417a4124ea9ddb2bff1c7fe1`; source/build/dataset/order/overlays are checked by the actual artifact verifier.
- Re-ran the declared focused suite: **59 passed, 0 failed**. `npm run typecheck`: exit 0.
- Re-ran `cli.ts rehearse` without write flags: exit 0, 30 scenarios, deterministic replay, byte-identical to the committed receipt, SHA-256 `1ea04722b1f338e07dda8835bc2fd262fd67df7f61b28e709a2074d88d0e3abd`.
- Additional in-memory and read-only TTY probes below expose gaps not covered by that suite. Manifest and baseline hashes were rechecked afterward; no mismatches. No reviewed files were edited, no live/provider/DB calls were made, and no admission/lock/receipt was created by the TTY probe. This report is the sole review output file.

## Required findings

### R1 — [P1] Real monotonic durations cannot be exported

Location: `scripts/ask-remote-eval-execution/operator.ts:89`, `scripts/ask-remote-eval-execution/receipt.ts:87-92,115-116` (the unchanged supervisor computes the direct difference at `scripts/ask-remote-eval/supervisor.ts:234,263`).

Trigger: the operator path supplies `performance.now()`, whose millisecond values and differences are fractional, but receipt latency summaries and per-case durations require non-negative safe integers. An in-memory probe using the real session/rehearsal path with `latencyMs:700.125` records duration `700.125`; `buildReceipt` rejects it with `RECEIPT_UNSAFE`.

Impact: ordinary operator answers/errors leave the session advanced but make every subsequent export fail. `save` only prints the error, so the on-disk receipt remains stale. The integer-only fake clock hides a failure in the central deliverable.

Repair: establish one explicit latency precision contract at the execution boundary (for example canonical integer milliseconds), preserve consistent summaries/records, and cover fractional monotonic timestamps through the operator-equivalent session and export path.

### R2 — [P1] Successful answers accept impossible no-attempt/no-dispatch ledgers

Location: `scripts/ask-remote-eval-execution/session.ts:177-189`, with `scripts/ask-remote-eval-execution/validate.ts:95-103`.

Trigger: pair a valid 200 AskAnswerV2 with matching correlation and either `{attempts:0,settlement:NO_RESERVATION,chargedMicro:0}` or `{attempts:1,settlement:NO_DISPATCH,chargedMicro:0}`, keeping pre/post counters unchanged. Both pass ledger validation/reconciliation. Reproduced results are `ACTIVE`, `casePass:true`, `ledger:BOUND`, `reconciliation:RECONCILED`, with the contradictory liability retained in the receipt.

Impact: the instrument credits successful validated provider answers while simultaneously asserting there was no provider dispatch/reservation. It can understate liability and contribute passing/provider-budget counts from internally inconsistent evidence. This is a local cross-field contradiction, independent of the explicitly missing server-bound read contract.

Repair: reconcile reply kind against permitted attempt/settlement states. A successful remote answer requires exactly one attempt and a dispatched settlement state; contradictory metadata must not become a reconciled passing case. Preserve conservative unknown/integrity handling and add both negatives.

### R3 — [P1] Current counters can erase a previously retained reserve

Location: `scripts/ask-remote-eval-execution/session.ts:133-138,180-184`.

Trigger: record a successful answer with `RETAINED_KNOWN` and a 300000 reserve. On the same UTC day, supply zero DAY/MONTH counters before the next case, then supply its normal 337 charge and post-counters of 337. Reproduced behavior: counters return `RECORDED`, submit returns `DISPATCH`, and the second case becomes `RECONCILED` while the run stays `ACTIVE`.

Impact: per-case arithmetic is checked against a freshly supplied baseline that can contradict this session's own prior ledger. A known retained reserve silently disappears, defeating the no-reset rule and the local cap/headroom assertion. Unknown or externally adjusted counters cannot be silently treated as reconciled.

Repair: retain and enforce a conservative same-run accounted liability/counter floor and UTC bucket identity across cases/resumes. DAY may roll only at the actual UTC boundary; MONTH cannot silently reset. Any legitimate adjustment needs explicit, accepted reconciliation evidence rather than an arbitrary new number. Test a retained reserve disappearing, decreasing confirmed charges, and correct next-day behavior.

### R4 — [P2] Safe receipts discard the financial and closure evidence they must preserve

Location: `scripts/ask-remote-eval-execution/session.ts:29-33,194-198,226-242` and `scripts/ask-remote-eval-execution/receipt.ts:51-73,115-119`.

Trigger: record any reconciled ledger and close/pause an interval. The receipt retains only a liability enum and `BOUND`/`RECONCILED` flags; it does not retain the ledger's actual attempt count, charged micro-USD, pre/post DAY/MONTH counters, captured submission policyVersion, or the confirmed closure policyVersion/fence tuple. The closure values are discarded after raising private floors.

Impact: a reviewer cannot reconstruct even the attested arithmetic, total actual charges/retained liabilities, or fence/version progression from the allowed saved evidence. A boolean alone substitutes for billing/closure evidence. RC6 expressly requires each attempt's allowed numeric ledger metadata and recording the pause policyVersion/fence tuple. The truthful live-proof qualification does not excuse dropping privacy-safe evidence already ingested.

Repair: preserve the validated bounded numeric ledger values and permitted admission/policy/fence/correlation metadata in exact allowlisted per-case/closure records, with explicit unknown values/provenance. Keep raw question/answer/observed intent out. Add replay checks over those persisted numbers and tuples.

### R5 — [P2] A future admission permits submissions before its start

Location: `scripts/ask-remote-eval-execution/session.ts:142-156` (delegates to the unchanged supervisor's expiry-only check at `scripts/ask-remote-eval/supervisor.ts:188`).

Trigger: create the normal admission beginning `2026-10-12T06:00:00Z`, then use clock `2026-10-11T06:00:00Z`. The complete next-case procedure returns `outcome:ACTIVE` and consumes one case before the admission starts. A clock in an earlier calendar month is likewise not excluded by the submission gate.

Impact: the manual instrument can count an out-of-window case as valid and consumed. The declared start/window and same-month assertions are not enforced, although expiry is. Server authority remaining unverified is correctly documented, but this locally available timing condition still must be checked.

Repair: enforce `start <= now < expiry` and the admitted UTC month at submission and relevant resume boundaries, without changing accepted production or frozen offline artifacts. Add before-start/at-start/expiry and month-boundary tests.

### R6 — [P2] Untrusted metadata is printed before validation

Location: `scripts/ask-remote-eval-execution/operator.ts:41-64,78,81,86-88,119-125`.

Trigger: all non-hidden prompts write every received character to stdout at line 57 before field validation. Correlation headers, ledger metadata, focus IDs, version values and commands therefore echo arbitrary pasted text. A read-only pty probe, without creating an admission, sent `confirm UNTRUSTED_METADATA_MARKER 7`; the marker appeared in output before the fixed rejection `NO_ADMISSION_YET`.

Impact: a question/body or hostile text pasted into the wrong metadata field reaches terminal output/scrollback/capture even though validation subsequently returns only a fixed code. This contradicts the required reject-without-content-echo property and the module's stated fixed-code-only output guarantee. Echo-off question/body prompts do not cover these adjacent fields.

Repair: read all untrusted values without echo, or echo only characters/values that have already passed the field's closed validator. Keep output to validated allowed metadata and fixed codes. Test hostile/sensitive marker input in each metadata prompt, not only module exceptions.

### R7 — [P2] Closure versions bypass signed-64-bit bounds

Location: `scripts/ask-remote-eval-execution/session.ts:226-242`.

Trigger: after `voluntaryPause`, supply policyVersion and fenceEpoch `9223372036854775808` (one above the accepted signed-64-bit maximum), matching admissionId and `paused:true`. The method returns `CONFIRMED`. It uses only a 19-digit regex and BigInt comparison instead of the bounded `decimal` validator used for admission/confirmation.

Impact: an impossible owner closure tuple is accepted as confirmed containment and installed as the new private floor; it also makes normal bounded confirmation impossible. A terminal/DAY closure has the same missing bound through the imported supervisor. This violates the closure-validation guarantee even in an attested local session.

Repair: validate exact closure fields and both decimals with the common bounded validator, translating invalid closures to absorbing `CONTAINMENT_UNCONFIRMED` as required. Add max/max+1, stale, foreign and extra-field coverage without echoing values.

## Correctly qualified behavior and residual boundaries

The actual transient path uses the accepted strict JSON/request parser and whole V2 browser validator with request/correlation/scope/focus checks, then the accepted independent truth comparator for the observed intent. The comparator checks displayed facts, references, claims, coverage and all-bank urgency independently of semantic labels. Wrong but grounded intent remains semantic failure. The observed tests correctly exercise terminal absorption, consumed-first accounting, duplicate integrity, the stated thresholds/denominator, failure modes and deterministic offline replay.

The tool installs the accepted network guard before dynamic imports and has no live/paid submission path. Receipts permanently set live acceptance false, live readiness BLOCKED and every safety row's verified-zero flag false. Missing server/ledger/closure/fixture/handoff/egress/privacy contracts are named, and manually entered values remain attested. Human label slots stay pending/DRAFT_MODEL_ASSISTED. Those qualifications are appropriate and must remain after repairs.

No production browser/DB proof was attempted; the absence remains qualified, and broad PG/browser suites are unnecessary for this unchanged-product checkpoint. Repairs should stay within the new execution instrument/tests/docs; changing accepted architecture/production/frozen offline artifacts would require its own gate. Re-review must identify the exact new package/hash and updated checks. This verdict does not fill any human, owner data/budget or live-use admission.
