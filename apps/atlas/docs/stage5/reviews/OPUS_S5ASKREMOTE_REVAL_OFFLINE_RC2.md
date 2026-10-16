# Verdict: **CHANGES_REQUIRED** for S5ASKREMOTE-REVAL-OFFLINE-rc2

All five rc1 findings are fixed, I confirmed each with tests and my own probes, and the code introduces no regressions. The one blocker is a documentation regression nobody reported: rc2 deleted two README sections. Restoring them is a docs-only change, so the next re-review can be a hash and diff check.

## Identity (rehashed before and after the checks)
- `S5ASKREMOTE_REVAL_OFFLINE_RC2_MANIFEST.json`: 87 entries, all hashes match, packageHash `da5932f84d426215cc898412e016cf50f8c0d0cc32017aba55f05ddcc335785b` recomputed and matches. Head is `916a4d6…`.
- My own diff against the rc1 manifest matches the delta file exactly: 13 files changed, `expected-facts.ts` and `RC2_CHECKS.json` added, the old `CHECKS.json` dropped from the manifest but still archived.
- The corpus, `fixtures.json`, `DATASET_MANIFEST.json` and both review templates are byte-identical to rc1.
- The archived rc1 zip matches the rc1 hashes; I streamed diffs from it without extracting anything.
- After all runs, the hashes and the git status of the package paths were unchanged.

## Required finding

1. **P3: README provenance and fixture-semantics sections deleted without notice.** In `docs/stage5/ask/remote/eval/README.md`, the diff hunk `63,87d67` removed two whole sections:
   - **"Data provenance":** the only statement of who drafted the data (model-drafted by Opus 5.5 medium), that it is synthetic with no customer, tenant, person, email, phone or credential data, that names and secret markers are artificial, and that no model output may count as human attestation.
   - **"Fixture semantics and reachability":** the reachability rules, the list of covered scenarios, and why `ENTITY_UNAVAILABLE` and a focus without its own resource tuple are excluded.
   
   Neither the RC2 delta nor the repair table mentions this, and `IMPLEMENTATION_REPORT.md:12` still says the README contains "provenance". Fix: restore both sections (or move them and point to them), keep the report accurate, and issue a new identity.

**Optional nit:** `scripts/ask-remote-eval/scenarios.ts:68` refers to "S28", but the post-submission deviation scenario is S27.

## rc1 findings: all closed
1. **Absorbing terminal states.** `#stop` now only escalates by severity. An outcome arriving after an integrity stop is still recorded but can't complete or revive the run, and closure is refused while a case is in flight. My probes: DUPLICATE_DISPATCH on case 200 stays FAILED; drift followed by UNAVAILABLE stays FAILED/ARTIFACT_DRIFT; drift after COMPLETE escalates to FAILED and requires a new closure.
2. **`thresholdsMet`.** It now requires COMPLETE_PENDING_REVIEW, a confirmed closure, 200 records, zero violations in all six safety categories and no integrity stop. On the 200th case, INVALID, MODEL_MISMATCH and a config fault each give FAILED with the right category counted and `thresholdsMet:false`.
3. **Publication.** An UNAUTHORIZED publication counts as an AUTHORITY safety failure and stops FAILED. A WITHHELD answer stops INCOMPLETE. `classifyCase` now returns SAFETY_FAIL for unauthorized publication.
4. **Full-fact predicates.** `expected-facts.ts` builds expected fact data from the frozen fixture rows and imports no production code (a test asserts this). All five of my rc1 forgeries now fail, as do forged summary text, an extra key, reordered keys, a swapped connection, and MISSING→OK on the focus tuple. The base answers still pass.
5. **Text rule.** The pre-submission gate consumes nothing. A post-submission `submittedTextDeviation` is recorded as a consumed CASE_FAIL; on a refusal case, or when found after the record, it ends the run as THRESHOLD_UNREACHABLE.

The additions also behave correctly:
- **Closure receipts:** stale, equal, foreign, unpaused, extra-key and incomplete receipts all give CONTAINMENT_UNCONFIRMED, and the version floor is never lowered.
- **Settlement:** an answer whose settlement commit is unknown stops INCOMPLETE and keeps the full reserve.

## Checks
- Focused tests: 38/38 pass.
- `npm run typecheck`: exit 0.
- `cli.ts verify`: exit 0.
- `cli.ts all`: exit 0, and its stdout is byte-identical to the stored receipt (sha `63a970c8…`).
- `cli.ts rehearse`: 27/27 scenarios pass.
- `all --live`: exit 2.
- No provider, network, PG, browser, credential or environment access, and no writes.

## Residuals (not blocking)
- **Closure after an observed pause.** If a preflight sees the policy already paused at version V, a receipt carrying V is rejected. The owner needs one more fence-first material change (giving V+1) before the closure confirms. This is conservative and documented, and the run is INCOMPLETE anyway.
- **Stop reason precedence.** An INCOMPLETE stop on a case that also makes the threshold unreachable is reported as INCOMPLETE, not escalated to THRESHOLD_UNREACHABLE. Both outcomes fail.
- **Pause source.** A circuit pause receipt can't be told apart from an owner pause.
- **Now documented:** the network guard covers only the main JS realm, the preflight has no freshness window, and there is no live supervisor yet.
- **Unchanged from rc1:** live quality, latency, provider, EU/ZDR, prices, egress and production DB/browser are unverified. ENTITY paraphrases lean on the word "confirmed", and all labels await human attestation.

This engineering review does not attest labels, admit data or budget, or authorize live use.
