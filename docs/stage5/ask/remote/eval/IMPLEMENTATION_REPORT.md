# R-EVAL offline package — implementation report

Date 2026-10-11. Writer: native Claude Opus 5.5 (`claude-opus-5-5`) / medium, Claude Code CLI, single session
`9d5316b2-dc14-4770-a072-43a6398f4513` (session ID as recorded in the baseline; related repairs stayed in this session).
Baseline `/tmp/atlas-reval-offline/baseline.json`: HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, 1374 files.
Not committed. Reviewers were not launched. **Paid product/provider calls: 0. Human signatures: none** (all review
templates are empty PENDING). No key, credential, account edit, activation, deployment, schedule, external fetch or
dependency change. Status remains: labels DRAFT_MODEL_ASSISTED, human attestation PENDING, data/budget NOT_ADMITTED.

## Scope delivered (new paths only)

- `docs/stage5/ask/remote/eval/`: `AGENTS.md`, `README.md` (procedure, commands, interpretation, provenance, reviewer
  scope, residuals), `RUBRIC.md`, `IMPLEMENTATION_REPORT.md`; `data/` (`AGENTS.md`, six case JSONL files, `fixtures.json`,
  `DATASET_MANIFEST.json`); `adjudication/` (`HUMAN_REVIEW_CHECKLIST.md`, `refusal-dual-review.jsonl`,
  `supported-review.jsonl`); `rehearsal/OFFLINE_REHEARSAL_RECEIPT.json`.
- `scripts/ask-remote-eval/`: `AGENTS.md`, `cli.ts`, `commands.ts`, `net-guard.ts`, `guard-preload.ts`, `dataset.ts`,
  `evidence.ts`, `fixtures.ts`, `predicates.ts`, `provider-stub.ts`, `harness.ts`, `supervisor.ts`, `rehearsal.ts`,
  `scenarios.ts`, `adjudication.ts` (largest 259 lines).
- `tests/ask-remote-eval-{corpus,fixtures,supervisor,offline}.test.ts`.

Integrity check after implementation: all 1374 baseline files byte-identical (SHA-256), HEAD unchanged, 35 new files, 0
outside the allowed paths. No package.json/lockfile, core code, old test, norm, seal, status or context-map edit.

## Artifact identity

| Item | SHA-256 |
|---|---|
| corpus (manifest `corpusSha256`, over the six JSONL file hashes) | `e31aa1c2d182a929b64f2977c0c70b09c8e9365bb36c83436d2d314fc45e8df8` |
| `data/fixtures.json` | `40f1744ae90b60e171b7897fce08bbe609ef5be6c908992586b470e08dcfaa8d` |
| order (seed `S5ASKREMOTE-REVAL-ORDER-v1`) | `9deaa3c5c1277bdc5eb74f892909a2aca9d0756538432def5d0e9202b0504a5d` |
| `data/DATASET_MANIFEST.json` | `224b1b8dedc775565f0eb1b5c5527096db29d2fc558854c58045d3879f12989a` |
| `rehearsal/OFFLINE_REHEARSAL_RECEIPT.json` | `1bc96d15638539ff7e27f0855faa1bec9d64f6d19a460d590f0a5ab4832309b0` |

## Commands and results (node v25.8.1, repository root)

| Command | Result |
|---|---|
| `node --experimental-strip-types scripts/ask-remote-eval/cli.ts verify` | exit 0; corpusIssues 0, fixtureIssues 0, manifestMatches, refusal 0/100 and supported 0/100 human-resolved (PENDING) |
| `… cli.ts harness` | exit 0; 200/200 cases wire+local PASS; fixture matrix 55/55 (11 fixtures × 5 intents); semanticEvaluation=false |
| `… cli.ts rehearse` | exit 0; 21/21 scenarios pass (simulated; productionAuthorityProof=false) |
| `… cli.ts guard-selftest` | exit 0; 16/16 network surfaces blocked |
| `… cli.ts all --write-receipt` | exit 0; receipt ok, blockedDuringPipeline 0, privacy scan clean |
| `node --experimental-strip-types --test tests/ask-remote-eval-*.test.ts tests/context-budget.test.ts` | 30 tests, 30 pass, 0 fail |
| `npm run typecheck` (tsc --noEmit) | exit 0 |

Not run (by brief): whole `npm test`, PG17 (`test:pg`, silent wrapper not needed — pure harness only), browser suite,
API build. No PG verification was necessary; production DB authority under this procedure is explicitly unverified.

## Design notes

- Fixture expectations were hand-declared from the accepted contracts before running; the first harness run matched all
  55 fixture×intent projections and all 200 cases with no expectation edits. Expectations use identity keys
  (`O:`/`R:`/`N:`), not production refs; the predicates import no production code (tested).
- Fixtures pass the accepted source validators and independent DB-reader reachability rules. `ENTITY_UNAVAILABLE` and a
  focus without its own resource tuple are unreachable in accepted DB semantics, so they are not live fixtures.
- Supervisor conservative choices (offline model, documented in README): unexpected inactive preflight, loss of authority
  (401/403/409 scope/policy codes), ASK_REMOTE_BUDGET and unclassified errors stop as TERMINAL_INCOMPLETE; ASK_BUSY and
  ASK_DEADLINE with known/no commit are consumed CASE_FAIL and continue; supervisor timeout = unknown commit, censored.
  Pacing counts capability preflights and submissions together (≤10 per 60 s). A manual rerun allowance > 0 is refused
  offline (default 0).

## Residuals and pending gates

Unverified here: live classification quality/latency, provider envelope/model/tier/usage, EU project/region/ZDR, key and
account association, current price contract, platform egress allowlist, production DB authority/fence/ledger and the
browser journey under this procedure, privacy scan of real destinations, a live supervisor implementation. Heuristic
diversity/secret checks are aids, not proofs. The guard covers Node JS network surfaces, not native addons/child processes.
Pending: human labelling and dual refusal adjudication, root integration of context routing/evidence, independent clean
Sol6.1/xhigh + Opus5.5/xhigh acceptance of this exact artifact, and every owner admission.

## RC2 bounded repair (same session, native Opus 5.5 / medium) — rc1 was CHANGES_REQUIRED

rc1 package `5eb37f8d01a3f77c383dfb9684bb85c4b1b7672b503fe939c1e51d34dc017341` stays archived; parent integrates rc2.
No reviewer launched, no paid/provider/network/account/credential work, no human signature. Corpus (all 200 case bytes),
draft labels, `fixtures.json`, `DATASET_MANIFEST.json` and both review templates are byte-unchanged; statuses stay DRAFT /
HUMAN PENDING / NOT_ADMITTED. Only the rehearsal receipt was regenerated.

| Finding | Repair | Evidence |
|---|---|---|
| Sol 1 / Opus 4+7 (P1) facts not compared | `predicates.ts` v2 compares the FULL data (values, key set and order) of every OBSERVATION/RESOURCE_STATE fact with `expected-facts.ts`, which derives it only from the frozen raw fixture rows (banked identities from hand-declared `expected.bank`; no production import); ENTITY vs `expected.entity`. Observed intent still governs; wrong grounded intent stays semantic-only | fixtures test: fabricated summary, HIGH⇒CRITICAL, 2020 asOf/lastSuccessAt+truncated (FX02), truncated true⇒false (FX07 SUMMARY, FX04 SOURCE_STATE), RESOLVED⇒OPEN (FX09), entityId⇒null (FX02), ack/route/key order/extra items/lastSuccessAt/displayName each fail ONLY in the data category; tampered expectation fails a true answer; 55/55 reachable positives |
| Sol 2 / Opus 3 (P1) publication | `Publication` = CURRENT/UNAUTHORIZED: UNAUTHORIZED → AUTHORITY safety, TERMINAL_FAILED; new `WITHHELD` outcome (authority lost before publication) → consumed CASE_FAIL, TERMINAL_INCOMPLETE; both set closure PENDING and block dispatch; `classifyCase` UNAUTHORIZED ⇒ SAFETY_FAIL | S22, supervisor test "publication" |
| Sol 3 (P2) closure floor | highest policyVersion ever observed (confirmations, preflights) is never lowered; confirmation must be ≥ it and > the pause version; receipt `{admissionId, paused, policyVersion, fenceEpoch}` must name this admission with version > highest and fence > opening/last (`openingFenceEpoch` owner-recorded in the admission); stale/equal/foreign/unpaused/incomplete → CONTAINMENT_UNCONFIRMED, no second receipt | S24, supervisor test "closure floor" (v1 after v100 rejected, v2 next day rejected, correct v101/fence2 resume then only v≥102) |
| Sol 4 (P2) settlement | `RETAINED_KNOWN` (known settlement failure: reserve held, continue) vs `RETAINED_UNKNOWN_COMMIT` (reserve held, TERMINAL_INCOMPLETE, no retry/refund) | S23, S12, supervisor test "settlement" |
| Opus 1 / brief 5 absorbing states | `#stop` only escalates by severity; in-flight outcome after an integrity stop is recorded but cannot complete/downgrade/revive; no closure while in flight | S25 (duplicate on case 200, drift then UNAVAILABLE), supervisor test |
| Opus 2 / brief 6 thresholds | `thresholdsMet` requires COMPLETE_PENDING_REVIEW + CONFIRMED closure + 200 records + all thresholds + zero safety in CLAIM/SCHEMA/MODEL_TIER/USAGE/CONFIG_FAULT/AUTHORITY + no integrity stop; report exposes `safetyByCategory` | S26 (INVALID, MODEL_MISMATCH, USAGE, config fault, unauthorized, false claim on case 200), supervisor test |
| Opus 5 / brief 8 text rule | `stage`/`submit` documented as PRE-submission gate (consumes nothing); new `submittedTextDeviation` = POST-submission deviation → consumed CASE_FAIL (refusal ⇒ threshold FAILED), never resent; S09 renamed; README rewritten | S09, S27, supervisor test |
| Residuals | README + receipt `unverified`: guard limited to this JS realm (native addons, child processes, `worker_threads`), preflight has no freshness window, live supervisor unimplemented | receipt `unverified` |

Files changed (all inside allowed scope): `scripts/ask-remote-eval/{supervisor,predicates,harness,fixtures,rehearsal,scenarios,
evidence}.ts`, `AGENTS.md`; new `scripts/ask-remote-eval/expected-facts.ts`; `tests/ask-remote-eval-{fixtures,supervisor}.test.ts`;
`docs/stage5/ask/remote/eval/{README.md,IMPLEMENTATION_REPORT.md}`; regenerated `rehearsal/OFFLINE_REHEARSAL_RECEIPT.json`.
Invariance: versus a hash snapshot of all 1416 files taken at the start of this repair turn, no file outside the allowed
scope changed, was added or removed; HEAD `916a4d69…` unchanged. Versus the rc1 baseline only the parent's administrative
`docs/AI_CONTEXT_MAP.md` and `docs/DEVELOPMENT_WORKFLOW.md` differ (pre-existing, untouched here).

| rc2 identity | SHA-256 |
|---|---|
| corpus (manifest `corpusSha256`, unchanged) | `e31aa1c2d182a929b64f2977c0c70b09c8e9365bb36c83436d2d314fc45e8df8` |
| `data/fixtures.json` (unchanged) | `40f1744ae90b60e171b7897fce08bbe609ef5be6c908992586b470e08dcfaa8d` |
| `data/DATASET_MANIFEST.json` (unchanged) | `224b1b8dedc775565f0eb1b5c5527096db29d2fc558854c58045d3879f12989a` |
| `rehearsal/OFFLINE_REHEARSAL_RECEIPT.json` (regenerated) | `63a970c85d504ca9ee4041a57797cc1d6cc28824f40f59e2edfebde540b17fb6` |

Checks (rc2): `cli.ts verify|harness|rehearse|guard-selftest` exit 0 (200/200, 55/55, 27/27 scenarios, 16/16 surfaces);
`cli.ts all --write-receipt` exit 0, reproducible; `node --experimental-strip-types --test tests/ask-remote-eval-*.test.ts
tests/context-budget.test.ts` 38/38 pass; `npm run typecheck` exit 0. Largest module `supervisor.ts` 333 lines.

## RC3 bounded docs-only repair (same session, native Opus 5.5 / medium)

rc2 code was accepted by both reviewers; the only required finding (Opus) was that the rc2 README rewrite had silently
deleted the "Data provenance" and "Fixture semantics and reachability" sections. Both were restored VERBATIM (25 lines,
byte-identical) from `docs/stage5/ask/remote/eval/README.md` inside the archived
`verification/stage5/S5ASKREMOTE_REVAL_OFFLINE_RC1_PACKAGE.zip`, inserted before "Future manual procedure"; all rc2 README
edits are retained. The provenance statement remains accurate: all 200 cases, rationales and fixtures are byte-unchanged
since rc1 and were drafted by native Claude Opus 5.5 (medium) in this session; labels stay DRAFT_MODEL_ASSISTED, human
attestation PENDING, data/budget NOT_ADMITTED. Also corrected one comment in `scripts/ask-remote-eval/scenarios.ts:68`
(S28 → S27, the actual post-submission scenario); no behavior change. No code, test, corpus, fixture, receipt, review
template, verification or root workflow/context file touched; no model/provider/network/key/paid call.

Changed paths vs rc2 (exactly three): `docs/stage5/ask/remote/eval/README.md`, `docs/stage5/ask/remote/eval/IMPLEMENTATION_REPORT.md`,
`scripts/ask-remote-eval/scenarios.ts` (comment only). Checks: `cli.ts verify` exit 0; `cli.ts all` (without
`--write-receipt`) exit 0 and its output hashes to the stored receipt `63a970c85d504ca9ee4041a57797cc1d6cc28824f40f59e2edfebde540b17fb6`
(unchanged); `tests/context-budget.test.ts` pass.
