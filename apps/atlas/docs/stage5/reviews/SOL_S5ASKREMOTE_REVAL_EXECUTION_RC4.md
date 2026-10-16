# Independent Sol acceptance review — execution RC4

Verdict: **CHANGES_REQUIRED**. One required P2 finding concerns saved numeric replay. The current session ingestion implements the supplemental unknown-liability and safety-priority rules correctly in the inspected paths and tested matrix, but the replay verifier accepts financially impossible credited answers.

## Artifact and review identity

- Artifact: `S5ASKREMOTE-REVAL-EXECUTION-rc4`.
- Package hash: `04d676c1982ec2608e7e75fc39853ed2335e49c9e6645cc02b0274fb7ab5905e`.
- HEAD: `916a4d69853ff6da636e8609a2e0bd33aa787f66`.
- Independently recomputed compact sorted-entry SHA-256: matches. All 119 manifest files match current bytes.
- ZIP SHA-256: `1e3f91fbc3ff541b4b31c15add56da0a24ec5a4a49485e4da0f19c083a14d490`; all 119 entries equal the checkout.
- All 1,431 files in `/tmp/atlas-reval-execution/baseline.json` remain byte-identical; repeated after review checks. No reviewed file edited.
- Fresh independent native Codex review session, explicitly assigned `gpt-6.1-sol` / `xhigh`. No other current reviewer verdict was supplied or consulted; no reviewer contacted and no repairs performed.
- Backend response-model/provider/billing telemetry is not exposed to this reviewer. The explicit assignment is recorded, but self-identification and the assignment alone are not independent proof of backend model identity. No model, billing, credit or fallback setting was changed; attributable subscription usage is unavailable.

## Required finding

### R1 [P2] Apply the session's ledger validity rules during saved numeric replay

Primary location: `scripts/ask-remote-eval-execution/replay.ts:33-39` (also numeric arithmetic/totals at lines 14-23). Related schema: `scripts/ask-remote-eval-execution/receipt.ts:139-144`.

Trigger: take the safe one-case grounded-answer receipt produced by `rig(loadContext())`, `playNext(r)`, `buildReceipt(...)`. Keep the answer, one attempt, reconciliation flag, case pass and validated-answer count; change settlement/charge and both post counters so `pre + charged = post`, and update the liability totals. Each of these independent mutations passes `assertReceipt` and returns `VERIFIED_SAVED_ARITHMETIC` with one provider credit and `casePass:true`:

| Mutation | Session contract | Observed replay |
|---|---|---|
| `CONFIRMED`, charged `0` | `ledgerMatchesReply('ANSWER', ...)` rejects; a dispatched answer requires positive validated cost | VERIFIED, credited, passing |
| `CONFIRMED`, charged `9435` | `ledgerValues(...)` rejects; maximum validated cost is `9434` | VERIFIED, credited, passing |
| `RETAINED_KNOWN`, charged `1` | `ledgerValues(...)` rejects; retained settlement requires the full `300000` reserve | VERIFIED, credited, passing |

These were independently reproduced using only in-memory copies; no mutated receipt was written. For each, the schema accepted it, the session ledger contract rejected it, and numeric replay accepted it. This is not a request to authenticate raw answer predicates from persisted booleans. The impossibility is already decidable from the allowed numeric evidence, settlement and reply class. Replay checks arithmetic, attempt count and a few settlement enums, but omits the charge/settlement constraints enforced by `validate.ts` and `book.ts`. Consequently its credit check can certify a credited answer with invalid liability or an underreported retained reserve. This misses the explicit requirement to prevent forged credit and preserve conservative liability during replay. Live readiness remains blocked, so the immediate impact is integrity of local execution/replay evidence.

Required repair: before deriving reconciliation, totals or provider credit, validate persisted bound ledger values against the admitted caps, settlement/attempt/charge rules and reply-class consistency used during session ingestion. Any invalid or contradictory numeric evidence must produce replay `MISMATCH` and cannot retain credited/pass status. Add regressions for the three mutations above (and relevant cap/counter violations), retaining the existing unknown-liability credit regressions. No product or frozen offline-supervisor change is needed.

## Verified behavior and checks

- `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts`: **67 passed, 0 failed, 0 skipped**, including the real macOS `script` pseudo-terminal test.
- Accepted offline corpus/fixtures/supervisor/offline tests plus context-budget test: **38 passed, 0 failed, 0 skipped**. Total reproduced: **105/105**.
- `npm run typecheck`: exit 0.
- Execution `artifact-check`: exit 0; no drift; 1,589 source/build/overlay checks; accepted offline package `d706a437b2e77ccb215080d4676d2ae70fee53376636d3d9040590d5d8f2dc3a`, accepted R-C package `9ae0c2b813388af58ee7d12e4df7f59521ba8cff417a4124ea9ddb2bff1c7fe1`.
- Execution rehearsal without write flag: **51/51**, byte-identical stored receipt; SHA-256 `b34e6dcc9ed8f5e272e6689d41954056201f367a09cd9ffe9b5c48b5b979d0d4`.
- Accepted offline `cli.ts all` without write flag: `ok:true`.
- New source/test files are below 700 lines; largest execution source is 400 lines. Product/source/build/schema/dependencies/prompt/dataset baseline is unchanged.

The five unknown-liability answer paths (missing, foreign correlation, unreconciled arithmetic, reply contradiction, explicit unknown settlement) are conservatively transformed into non-passing, no-provider-credit outcomes in `session.ts:252-291`. Validated truth failures escalate to FAILED; refusal mismatches and second supported-group mismatches escalate to FAILED; grounded matches and first supported mismatches remain INCOMPLETE. MATCH/MISMATCH and truth booleans survive without raw observed intent. The 25-cell matrix exercises these distinctions; the explicit unknown case retains the full reserve. Known reconciled settlement failure still permits continuation within the admitted gates; unknown commit does not permit retry/refund/resume.

Inspected code and tests also support frozen ordering and identity rechecks, strict in-memory question/focus staging, exact tuple/preflight and one-use per-question consent, consumed-first behavior, duplicate integrity failure, shared reported-event pacing, absorbing terminal/containment states, unified closure version/fence floors, next-UTC-day/same-month resume, threshold arithmetic, accepted V2 request/response/correlation/scope/provenance validation, independent OBSERVED-intent fixture truth comparison, and nearest-rank end-to-end latency with explicit n/censoring. Receipt and error paths use fixed enums/allowlisted metadata; TTY raw mode covers imports/processing and type-ahead after it is armed. The documented Node-startup-before-raw echo interval remains a qualification.

## Scope and residuals

This is local execution preparation only. No provider/product call, network dispatch, policy/key/account/budget activation, DB mutation, deployment or background schedule was performed. Paid product calls: 0. No broad PostgreSQL/browser suite was required or run because the product baseline is unchanged; tests here do not establish actual server/DB/browser observation.

Labels remain DRAFT_MODEL_ASSISTED with human attestation pending. Manual admission, counters, ledger, closure, identity and clock values remain attested/unverified. Server-process identity, fixture provisioning, actual authority/publication, ledger/closure/handoff read contracts, egress/platform/privacy proofs and owner data/budget admission remain explicit live blockers. Every verified-pass/live-readiness flag stays false/blocked. Deterministic fake-V2 rehearsal does not measure model quality; saved booleans cannot replay the original live predicates under the privacy contract. Repairing R1 would permit another local-preparation acceptance review, not live execution or data/budget admission.
