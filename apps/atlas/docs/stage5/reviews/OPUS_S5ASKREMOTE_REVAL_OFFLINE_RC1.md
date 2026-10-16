# Verdict: **CHANGES_REQUIRED** for S5ASKREMOTE-REVAL-OFFLINE-rc1

The corpus, fixtures, wire isolation, network guard, privacy and budget arithmetic hold up. The blockers are four P2 defects in the simulated supervisor and the local truth predicates, each reproduced with a pure in-memory probe. All four contradict the RC6 plan's stop and zero-tolerance rules. None of the fixes needs to touch the corpus or fixture bytes, but they will change the package identity and need a re-review.

## Identity (rehashed before and after the checks)
- Manifest `verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_RC1_MANIFEST.json`: all 86 file hashes match.
- Recomputed packageHash = `5eb37f8d01a3f77c383dfb9684bb85c4b1b7672b503fe939c1e51d34dc017341` (matches). Manifest head `916a4d6…` equals git HEAD.
- Dataset: corpus `e31aa1c2…8df8`, fixtures `40f1744a…aa8d`, order `9deaa3c5…4a5d`.
- After all runs, the hashes and the git status of the package paths were unchanged. Nothing was written.

## Required findings

1. **P2: a TERMINAL_FAILED run can be overwritten.** `scripts/ask-remote-eval/supervisor.ts:210-213` (`integrityViolation`) can be called while a case is in flight, `#stop` (`:87-91`) leaves that case in flight, and `outcome()` (`:171-206`) never checks the current state.
   - Probe 1: DUPLICATE_DISPATCH while case 200 is in flight, then its answer arrives. The run ends as `COMPLETE_PENDING_REVIEW` with `thresholdsMet:true`.
   - Probe 2: ARTIFACT_DRIFT while in flight, then ASK_REMOTE_UNAVAILABLE. The run ends as `TERMINAL_INCOMPLETE/UNAVAILABLE`.
   - The plan (`S5ASKREMOTE_REVAL_PLAN.md:203`) makes duplicate paid case and artifact drift TERMINAL_FAILED, and says an owner fix does not cure the run.
   - Fix: make terminal states absorbing (still record the in-flight case) and add a test.

2. **P2: `thresholdsMet` can be true on a failed run.** `supervisor.ts:245-246` ignores run state and closure, and the safety counter (`:181`) only counts failed truth checks (`truthPass`), not schema/model/tier failures.
   - Probe: ASK_REMOTE_INVALID, MODEL_MISMATCH, or UNAVAILABLE with a proven config fault on the 200th case gives `state:TERMINAL_FAILED` with `thresholdsMet:true`.
   - This contradicts plan `:91` (0 schema/model/tier/authority violations), `:204` and `:247-248` (INVALID is always FAILED), and `:208` (PASS/FAIL only after counting and review).
   - Fix: require `COMPLETE_PENDING_REVIEW` (plus confirmed closure) and count these codes as safety-category violations. Add a test.

3. **P2: publication without current authority is treated as an ordinary case failure.**
   - In `supervisor.ts:182`, `publicationCurrent:false` only fails the case: no safety count and no stop. `predicates.ts:93-97` reports it as `PUBLICATION_FAIL`, separate from `SAFETY_FAIL`. `rehearsal.ts:108` always passes `true`, so no scenario or test exercises it.
   - Probe: the 200th case answered with `publicationCurrent:false` gives `COMPLETE_PENDING_REVIEW`, safety 0, `thresholdsMet:true`.
   - Plan `:118-119` makes this a zero-tolerance safety FAIL, `:169-172` requires an immediate stop, and `:222` lists Authority as a safety category.
   - Fix: make it a safety stop (TERMINAL_FAILED), or remove the field if an ANSWER always implies current publication. Add a scenario.

4. **P2: the predicates don't check the contents of answer facts.** `predicates.ts:68-75` compares fact identity, resource `status`, entity data and severity (through urgency) only. In-memory forgeries of real `remoteAnswer` output all still **pass**:
   - FX07 SUMMARY and FX04 SOURCE_STATE: resource `truncated:true` changed to `false`.
   - FX02 SOURCE_STATE: `asOf`/`lastSuccessAt` shifted.
   - FX09: the focus observation changed from RESOLVED to OPEN.
   - FX02: the focus observation's `entityId` set to null.
   
   A SOURCE_STATE answer consists of exactly these stored read times and truncation flags, and the plan forbids false completeness and requires a truthful projection (`:92-93`, `:114-119`, `:225`). `fixtures.json` already declares all these values, so the expectations can be derived without changing data bytes. Fix: compare the full resource and observation fact data, and add forged-answer negative tests.

5. **P3: wrong submitted text vs. plan line 195.** The plan says a wrong submitted text means the case is FAIL and consumed. The model only blocks before dispatch (`supervisor.ts:150`), and scenario S09 (`scenarios.ts:67-80`) and `README.md:94` assert the opposite for "wrong submitted text". Either add a post-submission "text deviated → consumed CASE_FAIL" event, or explicitly document `submit()` as a pre-submission gate.

## Checks that passed
- **Matrix:** 200 cases, RU 100 / EN 100, every group and language count exact. All 8 unsupported and 5 adversarial categories appear in both languages, and every group has both `hasFocus` values.
- **Variety:** paraphrases within each group are genuinely different, not ID swaps. Boundary cases (980–1981 code points, up to 2025 bytes), zero-width and bidi characters, code blocks and emoji are all in bounds.
- **Draft labels:** consistent with the exact `intent-prompt.json`; I found no clearly wrong label.
- **Fixtures:** all 11 are reachable, and the spot-checked expectations match the selection rules in 03 (FX05 doesn't substitute another connection's tuple, FX04 keeps a candidate-only link UNRESOLVED, FX08/FX11 keep urgency beyond the 8 shown, FX09 sets focusExtra).
- **Wire, independence, privacy:**
  - The payload has exactly the expected keys, the developer message equals the prompt text, and no fixture marker reaches the wire.
  - The predicates import types only.
  - The network guard is installed before the dynamic import and blocks 16 surfaces; nothing was blocked during the pipeline run.
  - The receipt is scanned for question text and forbidden keys.
- **Supervisor numbers and rules:**
  - Plan numbers match: 6 fully reserved attempts per empty day, 33 per month, 181 sequential at the cost ceiling, 3,049,064 and 4,792,460 microUSD.
  - Admission shape matches: one UTC month, ≤7 days, reserve fixed, DAY ≥ reserve, MONTH ≥ DAY, rerun allowance 0.
  - The remaining stop-table rows, closure/containment/resume rules and latency handling (nearest-rank, explicit n, censored timeouts separate, denominator 200) are correct.
- **Commands run:**
  - Focused tests: 30/30 pass.
  - `npm run typecheck`: exit 0.
  - `cli.ts verify`: exit 0.
  - `cli.ts all`: exit 0, and its stdout is byte-identical to `OFFLINE_REHEARSAL_RECEIPT.json`.
  - `all --live` and `verify --write-receipt`: exit 2.
- No provider, network, PG, browser, credential or environment access.

## Residuals (not blocking)
- **Corpus notes for the human attestors:**
  - 24 of 25 ENTITY questions contain "confirmed"/"подтвержд", so they test the keyword more than paraphrase.
  - AMBIGUOUS cases are all short generic phrases.
  - Only one supported case quotes harmless text.
  - Borderline labels: RE-URG-007/017 (urgency vs. root cause), RE-URG-012/020 (advice-like), RE-SUM-008/024.
- **Supervisor model:**
  - `close()` doesn't require the pause receipt's version to be newer than the version in use.
  - A preflight has no freshness window.
  - ASK_REMOTE_BUDGET after submission ends as TERMINAL_INCOMPLETE (conservative).
- **Network guard:** `worker_threads` should be added to the stated residuals; native addons and child processes are already listed.
- **Unchanged from the README:** live quality and latency, actual provider envelope/model/tier/usage, EU/ZDR, key/account association, prices, egress allowlist, production DB authority/fence/ledger and browser journey, the live supervisor, and human attestation.

This engineering review does not attest labels, admit data or budget, or authorize live use. The repair changes scripts and tests (and the receipt if scenarios are added), so it needs a new manifest and renewed independent acceptance.
