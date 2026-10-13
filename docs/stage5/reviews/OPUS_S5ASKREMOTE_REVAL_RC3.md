# R-EVAL PREP rc3 bounded re-review: CHANGES_REQUIRED (one P3 finding)

**Package identity and checks**
- **Hashes:** I ran `verify-rc3.py` twice. Both runs returned `S5ASKREMOTE-REVAL-PREP-rc3`, packageHash `25f80323…cfea`, manifestSha256 `fdd320b8…7a2c`, matches=true, 18 files checked (5 package files plus 13 references), no mismatches.
- **Manifest:** `verification/stage5/S5ASKREMOTE_REVAL_RC3_MANIFEST.json`. It records a 1555-entry comparison against the accepted R-C identity, with the two admin changes. The verifier doesn't recompute that comparison, so I'm relying on the manifest for it.
- **Launch evidence:** the launcher supplied it (firstParty Max, extraUsage false, fast off, no fallback, actual model `claude-opus-5-5`, effort xhigh). From inside the session I can confirm only the model ID. Effort, elapsed time and usage are not visible to me.
- **Session:** same session as the RC1 review, which is allowed for a closure-only re-review (WORKFLOW:46–48).
- **Tools used:** the verifier plus Read on plan, admission, brief, manifest, WORKFLOW, DESIGN_STATUS, 02, `intent-prompt.json` and `packages/ask/contracts.ts`. Some reads of guessed manifest paths failed, and the sandbox blocked reading the verifier script. No writes, no other commands, no paid calls.

## F1–F8 disposition

| F | Status | Evidence |
|---|---|---|
| F1 | Closed except R1 | PLAN:92–111, 170–174, 196–208. Intent source checked: `AskAnswerV1.intent` (contracts.ts:78) is carried into V2 (02:37) |
| F2 | Closed | PLAN:44–49, 152–154, 172–185; ADMISSION:24 |
| F3 | Closed | PLAN:187–194 |
| F4 | Closed (see note 1) | PLAN:125–142; ADMISSION:21–22. I recomputed 9434, 181 and 3,049,064 |
| F5 | Closed | PLAN:5–6, 36–39; ADMISSION:26, 37–40; BRIEF:17–23; WORKFLOW:7–20, hash pinned in the manifest |
| F6 | Closed | PLAN:70–76. The prompt puts "another client" and "multiple or ambiguous intents" under UNSUPPORTED (`intent-prompt.json`:3) |
| F7 | Closed | PLAN:8–10, 18–21. The manifest's deltas are exactly those two paths |
| F8 | Closed | PLAN:98, 164–165; ADMISSION:13, 15, 41–42 |

## Required finding

**R1 (P3): the CASE_PASS rule contradicts the 95%-per-intent threshold.** Clause: PLAN:109–111.

- Expected claims and refs are labelled for the *expected* intent (PLAN:30).
- If the model returns a wrong supported intent and an answer is still published, the claims/refs won't match those labels.
- PLAN:110 says a "local … mismatch" is a "zero-tolerance FAIL". Read literally, any wrong intent therefore fails the run, which turns 24/25 into 25/25.
- That conflicts with PLAN:83, with PLAN:138 ("at most 4 failed supported cases") and with 05 R-EVAL ("≥95% correct intent in EACH").
- The plan also never says whether 24/25 counts intent matches or CASE_PASS.

Fix (wording only):
- When the intent doesn't match, skip the claims/refs comparison. The case is CASE_FAIL and counts only against its group's threshold.
- These checks stay zero-tolerance on every answered case: coverage, all-bank urgency, no remote refs or prose, provenance, sourceMode, and the safety categories.
- Gates: at least 24/25 CASE_PASS in each supported group, and 100/100 CASE_PASS for refusals.
- A 401, 403, 409 or 504 before publication means no answer, so it is a CASE_FAIL. Only an answer published without current authority counts as an authority violation.

## Non-blocking notes

1. **Correction to my own RC1 F4.** "A passing run means at most 4 UNKNOWN" (PLAN:138–139) is not exact.
   - Under 04, a *known* settlement failure keeps the full 300,000 reservation while the answer still publishes. So a passing case can carry a full reserve.
   - PLAN:181 covers only *unknown* commits.
   - Caps still enforce the limit. Either qualify the bound or add known settlement failure to the stop table.
2. WORKFLOW:183–184 still says Sol is "not a substitute for currently required Astra acceptance". Line 9 supersedes it, but marking that text as historical would avoid confusion.
3. **Resume trap.** Each resume advances policyVersion (PLAN:192). If the capability isn't refreshed first, the next case is used up as a 409. The supervisor should block submission until the refresh happens.
4. **For the execution-artifact gate:** the supervisor's observation path must not auto-consent, auto-submit, or create HAR or trace captures (05).

## External gate status (from the manifest's `gates` block, not my inference)

- Astra: PENDING
- Fable: PENDING_BILLING_PROOF
- Sol and Opus: PENDING
- Data/budget: NOT_ADMITTED
- Dataset/runner: NOT_READY

Also still pending:
- Acceptance of the dataset, rubric and labels.
- Acceptance of the supervisor/procedure and the rehearsal.
- All 18 admission rows and the owner decision.
- Acceptance of the live evidence.

This is a supplemental preparation review. It does not stand in for Fable, and it admits no data, spend, live run or interactive use.
