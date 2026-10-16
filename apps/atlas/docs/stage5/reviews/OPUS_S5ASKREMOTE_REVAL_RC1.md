# R-EVAL RC1 preparation review: CHANGES_REQUIRED

## Review identity and scope

**Package hash not verified.**
- I did not recompute `6fc5fba0…9eff` because you prohibited tools. This verdict applies only to the text you supplied.
- The manifest file list was not supplied, so I can't confirm the package's file set.
- The normative prompt, schema and profile files were not supplied.
- Line numbers are counted from the supplied text.
- The session context shows `docs/stage5/` as untracked on a dirty branch. Package identity therefore rests entirely on the manifest hash.

**Launch evidence.**
- Requested: `claude-opus-5-5` at xhigh effort.
- The system context identifies the model as `claude-opus-5-5`.
- From inside this session I cannot see: effort level, billing route (included subscription, extra usage or API), fast-mode state, elapsed time or usage.
- None of the Opus preflight evidence that ADMISSION:31 requires is visible to me. The launcher must attach it, or this review should be recorded as unattributed.
- Self-identification is not proof of model identity (BRIEF:21).
- This is a fresh session. I used no tools, files, network access or paid calls.

**This review does not count as a gate.**
- PLAN:27–28 and ADMISSION:26 make the preparation review an Astra/xhigh + Fable/xhigh gate.
- An Opus verdict cannot substitute for Fable (BRIEF:19).
- Both architecture gates remain **PENDING**.

**Abbreviations used below** (all files are under `docs/stage5/ask/remote/`):
- PLAN = `S5ASKREMOTE_REVAL_PLAN.md`
- ADMISSION = `S5ASKREMOTE_REVAL_ADMISSION.md`
- BRIEF = `S5ASKREMOTE_REVAL_REVIEW_BRIEF.md`
- 03, 04, 05 = the normative files with those numbers

## Checked and consistent

- **Matrix:** groups total 200, RU 100 / EN 100. The split (25×4, 60, 40) matches 05 R-EVAL.
- **Thresholds:** 24/25 = 96% passes, 23/25 = 92% fails, 190/200 = 95%. The rule "timeout/error is not a refusal" (PLAN:66) is faithful to 05.
- **Reserve:** 1,050,000×$0.275/MTok + 512×$0.825/MTok = $0.2891724, rounded up to 300,000 µUSD.
- **Settlement rates:** 275/825 per 1000 tokens equals $0.275/$0.825 per MTok.
- **Fully reserved attempts:** 6 per empty day and 33 per empty month. 7 UNKNOWN ($2.10) and 34 UNKNOWN ($10.20) are correctly rejected.
- **Other budget statements:** $60 is correctly not treated as a budget. "Available = cap − DB charged" is correct. No TTL reset of UNKNOWN.
- **Status is stated honestly:** PREPARATION_ONLY / NOT_ADMITTED, zero paid calls, runner and dataset absent, launch readiness pending, review ≠ owner decision (PLAN:3–5, 14–15, 26, 29–30; ADMISSION:3–4, 34–35).
- **Privacy:** only the synthetic question plus `hasFocus` leaves the server. The evidence contains no question, hash or raw answer. The dataset is stored separately. Pre-egress rejects are tested offline and kept out of the live set (PLAN:52–54, 78–80).
- **Role mapping matches your override:**
  - Architecture Astra + Fable at xhigh: PLAN:27, BRIEF:16.
  - Checkpoint acceptance Sol + Opus at xhigh: PLAN:28, 37.
  - Implementation Opus/medium: PLAN:26.
  - The orchestrator role is not referenced, which is fine because it has no gate.

## Required findings

### F1 (P2) — The evidence contract cannot support the acceptance criteria

Evidence:
- PLAN:74–79 against PLAN:22, 65–70 and 77.
- 04 §Durable model: attempt fields have no duration and no intent.
- 04 §Egress: "no new audit metadata keys".
- 03 §Projection: persistence is limited to "fixed codes, numeric usage/cost and server correlation … only in the specified ledger".

Gaps:
- **Provider-phase timing (PLAN:74) has no source in the accepted contract.** Capturing it is new instrumentation. That needs a checkpoint (PLAN:13) and a privacy classification.
  - The ≥190/200 count itself needs no timer. Dispatch requires at least 4500 ms remaining, so every validated completion fits the enforced 2000 ms by construction. Count it from outcome enums.
  - Make end-to-end percentiles mandatory, which satisfies 05. Keep provider-phase percentiles only if an accepted instrumentation checkpoint provides them.
- **No source for the observed intent enum (PLAN:78).** It is not stored in the ledger or the audit. Name where it comes from.
- **Local results are labelled and judged but not recorded.**
  - Labels include claims, refs, coverage and urgency (PLAN:22), and PLAN:68 and 70 judge them.
  - The per-case evidence is "only" intent and outcome enums (PLAN:78).
  - Fix: add per-case MATCH/MISMATCH enums computed at run time, or store the synthetic local answer in the restricted store (PLAN:80).
- **No single per-case pass predicate.** PLAN:65 counts intent, while PLAN:77 counts end-to-end success.
  - Define PASS = expected intent ∧ local result matches the expectation ∧ published under current authority ∧ no safety violation.
  - State which gate each failure type falls into.
- **No detection method for the eight safety categories (PLAN:68).** Without one, a result of "0 violations" is unfalsifiable. For privacy, require a post-run scan for synthetic markers across new DB rows, logs, APM and captures, reporting counts only (as in 05 Privacy/audit).
- **No guarantee the submitted text matches the frozen case.** The run is manual (PLAN:31).
  - Require pasting from the frozen artifact and an in-memory equality check on the operator side. No server-side hash is allowed (03).
  - A submission that deviates should consume the case as a failure.

### F2 (P2) — Stop/resume classes and case accounting are undefined

Evidence: PLAN:33–36 and 99–106; 05 R-EVAL ("one request/case", "resume manually", "not filtered samples").

- **Stop conditions need classes.** PLAN:99–101 lists a resumable condition (DAY cap) alongside conditions that must be terminal, but resume is described only for the financial limit. Assign each condition to one class:
  - **RESUMABLE:** DAY cap.
  - **TERMINAL_FAILED:** any safety violation; model/tier/usage mismatch (this also triggers a durable pause, which needs owner reactivation); retention/region invalidity; a duplicate paid case; a change to a frozen artifact.
  - **TERMINAL_INCOMPLETE:** expiry; revocation; price expiry; MONTH cap with no new month inside the validity window.
  - Also classify unknown commit (PLAN:100).
- **MONTH cap:** "next UTC day" (PLAN:34) does not restore monthly headroom.
- **When is a case consumed?** PLAN:33 says both "initial request" and "initial dispatches".
  - Recommended rule: the first server submission of a case ID is its outcome. That includes pre-egress 504/409/401/403 and unknown commit.
  - Any later submission is a rerun under PLAN:105–106.
  - Otherwise pre-egress failures can be quietly resubmitted, which is the filtering that 05 forbids.
- **Early stop should be decided, not optional.**
  - The combined gates allow at most 4 failures: at most 1 per supported intent, and none among the 100 refusal cases.
  - So failure can become mathematically certain early. PLAN:103–104 only says the run "may" stop.
  - Make stop-on-certain-failure an explicit owner-admission parameter, with stopping as the recommended default. It is the main lever for bounding spend on a failing run.
- **Resume does not pin the database.**
  - PLAN:35 pins admission, profile and dataset, but not the synthetic DB baseline from PLAN:20. Add it.
  - If any local predicate (freshness, coverage, urgency) depends on `now()`, the closed expectations can drift over a multi-day run. Either design the synthetic data so no freshness transition falls inside the validity window, or label those expectations time-invariantly.

### F3 (P2) — No disposition for the active policy after the run or between sessions

Evidence: PLAN:36–38 and 102; ADMISSION:21 and 24; 04 §Policy.

- **The problem:** after case 200, or after any terminal stop, the policy stays ACTIVE until expiry (up to 7 days). PLAN:38 forbids interactive use before acceptance, but nothing enforces that.
- **Fix:** on COMPLETE, FAILED or INCOMPLETE, the owner pauses or revokes the policy through the fence-first routine, or removes `ask:remote` from the operator's membership. Record the resulting policyVersion/fence tuple as evidence.
- **Between sessions:** state whether the policy stays active, and that only the designated operator holds `ask:remote`.
- **If pausing between sessions:** note that reactivation advances policyVersion while admissionId stays the same, and that it invalidates captured consent.

### F4 (P2) — Budget arithmetic: one misleading bound, plus a missing ceiling and feasibility facts

Evidence: PLAN:84–97 and ADMISSION:22.

- **PLAN:92 ("42 fully-reserved attempts in 7 days") is a DAY-only bound.**
  - Inside one UTC month, the MONTH cap binds first: 33 attempts ($9.90).
  - Across a month boundary the bound is higher. A 7×24 h window not aligned to 00:00Z touches 8 UTC days, allowing up to 48 attempts ($14.40).
- **The maximum app-accounted liability per admission is never derived.**
  - Formula: Σ over months of min(MONTH, DAY × UTC days touched in that month), minus opening charged.
  - That gives ≤$10 inside one month, and up to $14–$16 across a boundary.
  - ADMISSION:22 asks for an owner ceiling without giving this bound. Require the bound, and either forbid validity windows that cross a month boundary or require the ceiling to be at least the bound.
- **The deadline gate is never binding.** Because a passing run allows at most 4 failures, the ≥190/200 gate in PLAN:67 is always met when the others are. A passing run also holds at most 4 UNKNOWN reservations ($1.20). State this so the owner sees how strict the eval really is.
- **Feasibility (PLAN:94) should use contract bounds, not the expected price.**
  - Worst validated settlement per call: ceil((32768×275 + 512×825)/1000) = **9,434 µUSD**.
  - At that ceiling, only 181 validated calls fit in one empty day. Reserving requires charged ≤ 1,700,000.
  - Worst-case liability for a passing run: 196×9,434 + 4×300,000 = **3,049,064 µUSD**.
- **Lowered caps (PLAN:85):** require DAY ≥ 300,000 and MONTH ≥ DAY.

### F5 (P3) — Gate assignment and role-override traceability

Evidence: PLAN:4, 13, 26–28, 37–39; ADMISSION:11 and 26; BRIEF:16–19; 05 R-EVAL row ("Astra/xhigh evidence acceptance").

- **The supersession is undocumented.**
  - PLAN:37–39 replaces the normative Astra-only R-EVAL gate with Sol + Opus, while PLAN:4 says the normative files are unchanged.
  - Pin the authority ("workflow of 11 October") by path and hash in the manifest.
  - Record the supersession explicitly in ADMISSION:26.
  - State that BRIEF:19 ("never replace … Astra with Sol") covers substitution when a model is unavailable, not this reassignment.
- **The status of Sol/Opus preparation verdicts is ambiguous.** BRIEF:17–18 lists Sol and Opus as reviewers of this brief, but PLAN:27–28 makes preparation an Astra/Fable gate. State whether Sol/Opus preparation verdicts, including this one, are required, advisory or not expected.
- **Non-code artifacts have no acceptance gate:**
  - the frozen dataset, rubric and labels (PLAN:14–15, 21–23);
  - the manual procedure, if no runner code exists (ADMISSION:11; PLAN:28 "if they appear").
  Assign an independent gate before admission.

### F6 (P3) — Dataset freeze timing and label determinability

Evidence: PLAN:49, 56–58; ADMISSION:10; 03 (the adapter sees only `{question,hasFocus}`).

- **Freeze timing conflicts.** PLAN:56 fixes proportions and order "before the first dispatch", while ADMISSION:10 requires those hashes before admission. Align the plan to the admission sheet.
- **Labels must be derivable from what the classifier sees.**
  - "other-client" cases are classifiable only if the other client is identifiable from the question text alone, because the classifier never sees the current client.
  - The rubric must constrain every label to `{question, hasFocus}` plus the normative prompt.
- **Ambiguous and multi-intent cases need confirmation.**
  - PLAN:49 expects UNSUPPORTED for them.
  - 05's 100% gate covers "out-of-scope/injection".
  - Confirm against the normative prompt, which I have not seen, before freezing.
- **"holdout" is undefined** (PLAN:57, ADMISSION:10). Say whether it means the whole 200-case set or a subset.

### F7 (P3) — Undefined "administrative deltas" and rehearsal scope

Evidence: PLAN:5, 12–13, 24–25.

- **"Administrative deltas" (PLAN:12) is an open category.**
  - Make it a closed, hash-listed set of non-runtime paths.
  - Anything that affects runtime, build, dependencies, schema, migrations, roles, prompt or profile goes through a checkpoint (PLAN:13).
- **The rehearsal conflicts with the activation ban.**
  - The rehearsal needs an active policy and real reserve/settle.
  - PLAN:5 forbids policy activation.
  - State that rehearsal activation exists only in the sealed copy's synthetic DB, with no secret reference and no real project identity, and uses PG only through the accepted wrapper (05).

### F8 (P3) — Small fidelity omissions against 05 and 03

Add the following to PLAN or ADMISSION:
- "No inferred subscription savings" in the report (05).
- If quality or latency fails: no timeout widening, model change or fallback without contract/gate review (05). PLAN:112 currently covers only fallback and automatic cap raises.
- For the product key:
  - no hidden API-credit enablement;
  - no reuse of development subscriptions;
  - no subscription, Codex or Claude login credential (05; 03 §Wire profile).
  ADMISSION:28 covers only the reviewers, not the product key (ADMISSION:15).
- "Global-project keys are not admitted" (05), stated explicitly in ADMISSION:13 and 15.
- Re-evaluation is required after any model, prompt, schema or profile change, or after detected semantic drift (03; 05).

## Residuals (non-blocking)

- **The eval is fragile, faithfully to 05.** One timeout, 5xx or provider refusal on any of the 100 refusal cases fails the eval, and reruns don't count. Provider refusals on injection or quoted-secret prompts are plausible, and 03 rejects them rather than treating them as UNSUPPORTED.
- **Synthetic secret markers egress by design.** Avoid real-looking prefixes (`sk-`, `sk-proj-`, `AKIA`, `ghp_`) so they don't trigger secret scanning or collide with real keys.
- **The case-ID ↔ correlation mapping re-links questions to attempts.** That is acceptable only because the data is SYNTHETIC. It must not carry over to non-synthetic evals.
- **There is a single human labeller with no adjudication.** Label errors on the 100% gate decide the outcome directly. I recommend dual labelling of the 100 refusal cases.
- **Accepted contract risks remain:**
  - a model ID is not immutable weights;
  - semantic drift is undetectable;
  - an abort does not prove there was no charge;
  - the invoice and tax are not bounded by the application;
  - EU region, ZDR and price are unverified.

## Still PENDING (not treated as satisfied)

- All 18 ADMISSION rows.
- The frozen dataset and rubric.
- The runner or manual procedure, plus the rehearsal receipt.
- The Astra/xhigh and Fable/xhigh preparation verdicts.
- The owner decision.
- Sol/Opus acceptance of any runner or changes, and of the evidence.

Nothing in this review authorizes provisioning, activation, inference or spend.
