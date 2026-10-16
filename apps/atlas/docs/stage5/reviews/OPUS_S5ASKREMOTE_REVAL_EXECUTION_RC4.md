# Independent acceptance review — S5ASKREMOTE-REVAL-EXECUTION-rc4 (Opus5.5 / xhigh)

**Verdict: CHANGES_REQUIRED** — 3 required findings (R1 P2, R2 P2, R3 P3). No live, data, budget, human-label or
model-quality admission follows from this review in any case.

## Reviewer, session and evidence limits

- Assignment: native `claude-opus-5-5`, effort `xhigh`, clean initial independent read-only review (Claude Code CLI 2.1.293).
  The launcher states: Max native authentication, extra usage disabled, fast mode off, no fallback. From inside the
  session I cannot observe the effective response model, effort, provider routing or billing. My model name here is
  self-identification only, which is NOT provider proof. Backend telemetry and quota attribution are unavailable to me.
- Independence: no implementer/orchestrator history and no other reviewer verdict was supplied. I did not open
  `docs/stage5/reviews/*REVAL_EXECUTION*`, `/tmp/atlas-reval-execution/opus-rc*-report.md`, `*_OPUS_EVIDENCE.json`,
  `S5ASKREMOTE_REVAL_EXECUTION_STATUS.json` or `…_APPROVED.json`. The artifact's own README and report say that an
  additional RC3 Sol review was CHANGES_REQUIRED; I saw that only as artifact content.
- Writes: only this report, plus scratch files in `/tmp/opus-rc4-review-out/` and `/tmp/opus-rc4-review-scripts/`.
  No source, review, receipt or verification file was modified. No `--write-receipt` and no network, DB, provider,
  browser, account or paid call.

## Artifact identity (verified independently)

| Check | Result |
|---|---|
| Manifest `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC4_MANIFEST.json` | 119 entries; all 119 on-disk SHA-256 match |
| packageHash, re-derived as `sha256(JSON.stringify(sorted entries))` | `04d676c1982ec2608e7e75fc39853ed2335e49c9e6645cc02b0274fb7ab5905e` = declared |
| ZIP `…_RC4_PACKAGE.zip` | sha `1e3f91fb…d490` = CHECKS; 119 entries, each byte-equal to its manifest hash, none extra |
| Baseline `/tmp/atlas-reval-execution/baseline.json` (HEAD `916a4d69…`) | 1431/1431 unchanged, before and after my runs |
| Files outside baseline | only `scripts/ask-remote-eval-execution/**`, `tests/ask-remote-eval-execution-*.test.ts`, `docs/stage5/ask/remote/execution/**`, review docs, `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_*`. No product/schema/dependency/prompt/dataset change |
| `executionToolSha256` | `636700830aee…5e61`, re-derived from the 15 manifest tool entries; equals the stored receipt and artifact-check |
| `artifact-check` | exit 0; drift none; 1589 hashes; 6 pinned admin overlays; labels `DRAFT_MODEL_ASSISTED` / `HUMAN_ATTESTATION_PENDING`; 11 live blockers |
| Active file size | largest `session.ts` 400 lines (≤700 hard, ≤500 aim); `context-budget` test passes |

## Checks reproduced

| Command | Result |
|---|---|
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 67/67, 0 skipped (includes the real-pty test) |
| `… --test tests/ask-remote-eval-{corpus,fixtures,supervisor,offline}.test.ts tests/context-budget.test.ts` | 38/38, 0 skipped → 105 total, matching CHECKS |
| `npx tsc --noEmit` | exit 0, no output |
| `cli.ts rehearse` (no write) | exit 0; 51/51; `DETERMINISTIC_REHEARSAL_REPLAY_VERIFIED`; receiptScan CLEAN; output byte-identical to the stored receipt (sha `b34e6dcc…d0d4`) |
| Reviewer probes `/tmp/opus-rc4-review-scripts/probe.ts`, results in `/tmp/opus-rc4-review-out/probe.json` | reproduce R1 and R2 below; confirm the unknown-liability matrix |
| `cli.ts replay --receipt /tmp/opus-rc4-review-out/forged-receipt.json` | `ok:true`, exit 0 on a self-contradictory receipt (R2) |

No browser, PG or product-server proof was run or needed (no product change). Their absence stays a qualification.

## Requirement assessment (what holds)

- **Identity.** Pinned anchors are the offline RC3 and R-C RC1 manifests. Every listed file and the build inventory are
  re-hashed. The dataset, fixtures and seeded order are re-derived, and the corpus is parsed from the same bytes that were
  hashed. The check runs at start, again before every `submit` (drift → TERMINAL_FAILED `ARTIFACT_DRIFT`), and on resume.
- **Procedure core.** It reuses the accepted frozen supervisor unchanged:
  - stable order; strict in-memory question, `hasFocus` and focus equality at `stage`;
  - consumption at DISPATCH, so pre-egress failures also consume the case;
  - a duplicate `submit`, an `unrecorded-click`, or ledger `attempts ≥ 2` is an integrity FAILED;
  - terminal states absorb; pacing covers both preflight and submit, ≤10 per 60 s;
  - MONTH, expiry, unknown commit, loss of authority and an inactive preflight are terminal; every UNAVAILABLE stops
    the run; INVALID, MODEL_MISMATCH and USAGE_INVALID are FAILED;
  - a known settlement failure is retained and the run continues;
  - thresholds: 24/25 per group, 100/100 refusal, ≥190 validated, zero safety, denominator 200.
- **Tuple, consent and pause.** The policy tuple is typed manually and must match the preflight. Consent is a one-use
  random challenge plus a checkbox attestation; there is no auto-submit, auto-consent or retry. Voluntary and DAY pauses
  share one run-wide closure floor: exactly 4 keys, signed-64-bit, strictly newer version and fence, and containment
  absorbs. DAY resume requires the next UTC day, the same month, the window, the admission and the artifact.
- **Unknown liability (supplemental requirement).** All five paths reach the supervisor as a no-credit error with
  `validatedAnswers` unchanged and no case pass: missing ledger (X16), foreign correlation (X17), arithmetic mismatch
  (X50), reply/ledger contradiction (X32/X33), explicit `RETAINED_UNKNOWN_COMMIT` (X29, probe P4).
  - A truth failure escalates to FAILED (X45 and the liability matrix).
  - A refusal MISMATCH escalates to FAILED (X46/X49).
  - A second supported miss escalates to FAILED (X51).
  - A first supported miss or a grounded MATCH ends INCOMPLETE (X47/X50).
  - The full reserve stays in the floor and nothing is refunded or retried. Only MATCH/MISMATCH is stored, never the
    observed intent. Replay flags an unknown-liability answer that is credited or passing.
- **Transient path.** The tool runs the accepted strict JSON, `askRemoteRequest`, `validateRemoteAnswer` (exact keys,
  fixed provenance, requestId, scope, focus, header = body correlation) and `validateAskError` before deriving any
  boolean. It then runs the accepted independent comparator against the OBSERVED intent. That comparator covers
  claims/refs, full fact data, entity, coverage and all-bank urgency, and separates grounded-wrong-intent (semantic only)
  from safety.
- **Privacy and receipt.** Exact allowlist plus the accepted scan plus a rationale scan. No question, hash, length, body,
  raw answer or observed intent is stored. Errors are fixed codes only. Constant `verifiedPass:false` and
  `liveAcceptanceEligible:false`; every safety row has `countsAsVerifiedZero:false`. Explicit provenance:
  `LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED`, `OPERATOR_ENTERED_ATTESTED`, `REPORTED_EVENTS_ONLY`, and more. 21 explicit
  unverified items, including publication under current authority, capability freshness, server identity, ledger,
  closure, egress, privacy scan, fixture provisioning and transient handoff. The live blockers cannot be removed.
- **Real operator bridge.** The operator TTY is a real bridge: raw mode is armed before imports, kernel echo stays off for
  the whole session (the real-pty test passes), GO is printed only after an fsync'd atomic save, and quit, signals or
  fatal errors abandon an in-flight case as censored unknown commit. There are no child processes, workers, network,
  env reads, or HAR/trace capture, and the accepted net guard is installed first.
- **Latency.** Monotonic, integer ms, operator keystroke bracketed (disclosed), nearest-rank with explicit n,
  censored cases separate.

## Required findings

### R1 (P2) — A validated zero-tolerance error envelope is erased when the request paste fails to parse

- **Where:** `scripts/ask-remote-eval-execution/session.ts:246`
  (`if (!request.parsed && observed !== null) observed = { kind: 'LOCAL_HANDOFF_UNVERIFIED', detail: 'REQUEST_UNPARSED' }`),
  with consequences at `:247` (correlation dropped), `:263` (handoff outcome) and `:325` (tally returns before any
  safety row).
- **Why this line only affects errors:** for status 200, `checkResponse` (`transient.ts:84`) already returns handoff when
  `requestId` is null. So line 246 changes outcomes only for ERROR observations. An error envelope carries no requestId,
  and its attribution (known code, fixed status, header = body correlation) does not depend on the request paste at all.
- **Trigger:** the operator pastes valid JSON that is not an AskRequestV2 at the request prompt (for example the reply
  body). They then paste an authentic `ASK_REMOTE_INVALID`, `ASK_REMOTE_MODEL_MISMATCH` or `ASK_REMOTE_USAGE_INVALID`
  envelope, or `ASK_REMOTE_UNAVAILABLE` with an owner-attested config fault.
- **Reproduced (probe P1/P1b):**

  | Request paste | State | Reason | Safety rows | Persisted outcome / reply |
  |---|---|---|---|---|
  | Parseable (control) | TERMINAL_FAILED | `ASK_REMOTE_INVALID` / `…MODEL_MISMATCH` / `…USAGE_INVALID` | relevant row = 1 | the error code |
  | Unparseable | TERMINAL_INCOMPLETE | `UNCLASSIFIED_ERROR`, local `LOCAL_HANDOFF_UNVERIFIED` | SCHEMA, MODEL_TIER, USAGE all 0 | `LOCAL_HANDOFF_UNVERIFIED` / `LOCAL_HANDOFF_UNVERIFIED` |

  With the unparseable paste the error code and correlation are not persisted anywhere. The config-fault case drops
  from FAILED to INCOMPLETE.
- **Impact:** RC6 says ASK_REMOTE_INVALID is TERMINAL_FAILED "независимо от subcause", and model/tier/usage mismatch
  is TERMINAL_FAILED with circuit pause. A safety event the tool already validated is downgraded to an unattributed
  INCOMPLETE. It vanishes from the receipt (`violationsObserved: 0`), so the evidence omits a provider-identity or schema
  violation that the owner must act on. This is the same "unknown/local uncertainty must not mask what is proven"
  principle the RC3 additional repair applied to answers. The existing test `repair.test.ts:158-169` covers only an
  ANSWER with an unparsed request, so this gap is untested.
- **Repair:** keep a validated ERROR observation when the request is unparsed:
  - feed the code to the supervisor and tally;
  - persist the code and correlation, with `text: 'REQUEST_UNVERIFIED'`;
  - still record the local handoff reason, so that non-escalating errors end TERMINAL_INCOMPLETE (FAILED dominates by RANK);
  - restrict the `REQUEST_UNPARSED` replacement to answers, which already happens in `checkResponse`.

  Add rehearsal scenarios and regression tests for INVALID, MODEL_MISMATCH, USAGE_INVALID and UNAVAILABLE+config fault,
  each with an unparsed request (expect TERMINAL_FAILED and row = 1), plus a non-safety error with an unparsed request
  (expect INCOMPLETE). Regenerate the stored receipt.

### R2 (P2) — Numeric replay "verifies" receipts whose pass credit contradicts their own saved booleans

- **Where:** `scripts/ask-remote-eval-execution/replay.ts:36-41`. The credit checks only test liability and
  `reply`/`outcome`. Nothing re-derives `casePass` from `semantic`, `truth.*` or `text`, re-derives
  `run.supportedPass`/`run.refusalPass` from per-case passes, re-derives safety rows from truth booleans and outcomes,
  or checks `run.procedureThresholdsMet`. The CLI then reports `ok:true` (`cli.ts:69-71`).
- **Reproduced (probe P2 plus the CLI):** each of the following keeps schema `VALID` and replays as
  `VERIFIED_SAVED_ARITHMETIC` with no failures:
  - `casePass:true` on a `semantic:'MISMATCH'` case;
  - `casePass:true` with `truth.claims:false`;
  - `casePass:true` with `text:'REQUEST_DEVIATION'`;
  - `supportedPass` set to 25 in every group, `refusalPass:100` and `procedureThresholdsMet:true` on a run that is not
    complete.

  `cli.ts replay` on `/tmp/opus-rc4-review-out/forged-receipt.json` returns `{"ok":true,…}` with exit 0. That receipt has
  a refusal case `RE-UNS-051` that is MISMATCH, has claims/coverage/urgency all false and a deviation, yet keeps
  `casePass:true`, `refusalPass:100`, `CLAIMS` row 0 and `procedureThresholdsMet:true`.
- **Impact:** RC6 requires the saved booleans to "позволять независимый replay локальных предикатов". The supplemental
  requirement asks that replay cannot forge credit. Raw-answer predicates are unreplayable under the privacy contract;
  that limit is correctly disclosed. But the CASE_PASS rule (semantic MATCH ∧ truthful projection ∧ publication ∧ no
  safety violation) and the 24/25 and 100/100 scoring are fully replayable from fields the receipt already stores. As
  built, replay gives a green result to a corrupted or mis-built receipt that claims passing thresholds. A future
  evidence acceptance relying on `cli.ts replay` could be misled. (Arithmetic forgery cannot be prevented without
  authentication; internal consistency can be checked.)
- **Repair:** in `replayNumeric`, add the following checks, each with a negative test for the mutations above:
  - fail when `casePass === true` but not all of: `reply==='V2_ANSWER_VALID'`, `outcome==='ANSWER'`,
    `semantic==='MATCH'`, every `truth.*` true, `text==='REQUEST_MATCHED'`, reconciled, and liability known;
  - re-derive `supportedPass` per group from the caseId prefix (SUM, URG, SRC, ENT) and `refusalPass` (UNS, ADV), and
    compare with the run fields;
  - check that the CLAIMS, COVERAGE, URGENCY and SCHEMA rows are at least the counts of validated answers with false
    booleans, and that SCHEMA, MODEL_TIER, USAGE and CONFIG are at least the corresponding outcomes and
    `configFaultAttested`;
  - fail when `procedureThresholdsMet:true` without COMPLETE_PENDING_REVIEW, closure CONFIRMED, 200 consumed, ≥24 in
    every group, 100 refusal, ≥190 validated, all safety rows and integrity at 0, no handoff failures and a null
    `localReason`.

### R3 (P3) — The frozen candidate contains a "current acceptance" record claiming RC3 is accepted with 0 findings

- **Where:** `docs/stage5/ask/remote/execution/ACCEPTANCE_STATUS.md:1-7, 15-16`, added in the RC4 delta. It is titled
  "current acceptance", says "ACCEPTED S5ASKREMOTE-REVAL-EXECUTION-rc3 … required findings 0", gives RC3 checks
  (78 tests, 48 scenarios, 117 entries) and names the RC3 seal as the "Current authoritative status/seal/closure".
- **Contradiction:** the same package's `README.md:5-6` says an additional RC3 Sol review was CHANGES_REQUIRED, that this
  is a repair candidate, and that "no current approval is claimed". `IMPLEMENTATION_REPORT.md` (RC3 additional addendum)
  says historical RC3 approvals are "NOT a current approval".
- **Impact:** an acceptance artifact carries contradictory acceptance status. A reader routed to the execution docs
  directory can believe the instrument currently has dual acceptance with zero findings. The policy requires accurate
  status and forbids relabelling history.
- **Repair (administrative, root-owned):** retitle the file as a historical RC3 record. State that an additional
  independent RC3 review returned CHANGES_REQUIRED, that RC4 supersedes as the candidate, and that current acceptance is
  PENDING. Alternatively keep it out of the candidate's docs directory. Declare the exact delta.

## Non-blocking observations (recommend addressing with the R1 round; not gating)

1. **Refusal certain failures that are not answers end INCOMPLETE, not FAILED.** A TIMEOUT or ASK_REMOTE_UNAVAILABLE on
   a refusal case (probe P3) gives TERMINAL_INCOMPLETE, although 100/100 is then certainly unreachable ("timeout/error не
   считается отказом"). The cause is that the frozen supervisor's `#thresholdCheck` returns early once the state is no
   longer ACTIVE. This follows the RC6 unknown-commit and UNAVAILABLE rows and the accepted offline supervisor, and the
   supplemental rule is scoped to answer paths. It is asymmetric with the wrapper's answer escalation, though. Ask the
   orchestrator/owner to confirm precedence. If FAILED is intended, apply the wrapper escalation to these outcomes too
   (no supervisor change needed).
2. **Persistence is not durable against power loss.** GO is printed after `fsync(file)` and `rename`, but there is no
   directory fsync and, on macOS, no `F_FULLFSYNC`. Power loss after the click could lose the in-flight record. The
   server ledger would still show the attempt.
3. **Operator declarations stay attested.** `timeout`/`unparseable` declarations and config-fault attestation can only
   move a reply toward INCOMPLETE, never toward pass, but they can hide a FAILED-worthy reply. State this explicitly next
   to the attestation note in the README.
4. **The tool hash is recorded but not pinned.** `executionToolSha256` is recorded, not checked against an accepted pin
   at start (a self-pin is impossible). Reviewers must compare a receipt's value with the accepted manifest, as done here.
5. **Conservative-but-costly behaviours.** These are partly documented; consider documenting them all:
   - a ledger read after UTC midnight does not reconcile, so the commit is UNKNOWN;
   - a lost or restarted process cannot resume, because the lock blocks it, which kills RESUMABLE_DAY runs that need
     the process to survive midnight;
   - a closure typo is absorbing containment.

## Residual proof gaps — confirmed explicit, and they correctly block live acceptance

The following stay PENDING or UNVERIFIED and are named in the artifact:

- ledger/counter read contract and closure-receipt read contract;
- fixture DB provisioning (DB = fixture);
- transient browser handoff (pastes are attested, not server-bound);
- running-server build identity;
- platform egress allowlist and before/after privacy scan;
- publication under current authority (the V2 answer carries no policy tuple; the tool assumes `publication:'CURRENT'`
  and lists it as unverified);
- capability freshness beyond unseen correlation, and the local wall clock versus server UTC;
- operator identity;
- human label attestation, owner data/budget admission, and independent acceptance.

Live per-case replay is `UNVERIFIABLE_UNDER_PRIVACY_CONTRACT`. Deterministic offline replay applies to the rehearsal
only, and the rehearsal returns DRAFT labels through the accepted compiler (`semanticEvaluation:false`). Engineering
approval of a later revision would accept only local preparation. It would not admit data, budget, paid inference or
human labels, and would not measure model quality.
