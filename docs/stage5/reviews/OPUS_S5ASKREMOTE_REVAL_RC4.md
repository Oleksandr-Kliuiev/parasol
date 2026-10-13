# R-EVAL PREP rc4: APPROVE_PREPARATION (supplemental review only)

No required findings remain on exact RC4.

**Package identity**
- I ran `verify-rc4.py` once. It returned `S5ASKREMOTE-REVAL-PREP-rc4`, packageHash `fdff112c…a6e9`, manifestSha256 `00c713ce…96d1`, matches=true, 18 files checked, no mismatches.
- The only other thing I did was one Read of `S5ASKREMOTE_REVAL_PLAN.md`. No writes, no other commands, no paid calls.
- Launch evidence (Max, extraUsage false, fast off, no fallback, xhigh) comes from the launcher. From inside the session I can confirm only the model ID, `claude-opus-5-5`.

## Closure

| Item | Status | Evidence |
|---|---|---|
| R1 (CASE_PASS vs 24/25) | **Closed** | See below |
| Note 1 (retained reserve) | **Closed** | See below |
| Notes 3 and 4 (supervisor) | **Closed** | PLAN:209–210 and 228: submission is blocked until a manual refresh and a new consent; no auto-consent, no auto-submit, no HAR, trace or video |

**R1, PLAN:30–31, 110–119, 219**
- Every answer, including a misclassified one, is now checked for truth against the projection for the *observed* intent plus the frozen fixture. That covers claims, refs, coverage and all-bank urgency.
- Labels are frozen for every possible observed intent.
- A grounded wrong intent costs only a semantic CASE_FAIL.
- False claims and unauthorized publication remain zero-tolerance.
- The scoring rule is explicit: at least 24/25 CASE_PASS in each supported group and 100/100 for refusals.
- 401, 403, 409 and 504 count as CASE_FAIL, not as authority violations.

**Note 1, PLAN:144–156**
- The 181-call and 3,049,064 figures are now explicitly conditional on confirmed settlement.
- The bound S×9434 + U×300000 counts every retained reserve, including ones on successful answers.
- I recomputed 190×9434 + 10×300000 = 4,792,460. Correct.
- Real counters plus reserve, headroom and expiry are checked before every submission.

## Non-blocking consistency notes

- **"Independent replay" overstates what is stored (PLAN:107 vs 109).** Neither the answer nor the observed enum is persisted.
  - A replay can re-derive the expected projection only for MATCH cases.
  - For a misclassified answer, the truth result can't be independently replayed. That is at most 4 cases in a passing run.
  - Narrow the wording to "re-derivation of expectations". Alternatively, keep the 5-value observed enum in the restricted local eval report.
- WORKFLOW historical text stays superseded by the current owner section. I accept that as recorded.

## Gates still pending (external status; I didn't infer any of these)

- Astra/xhigh and Fable/xhigh preparation verdicts. This review does not substitute for Fable.
- Sol/Opus acceptance of the dataset, rubric and dual labels, and of the supervisor or procedure and its offline rehearsal.
- All admission rows and the owner's separate data and budget decision.
- Sol/Opus acceptance of the live evidence.

This approval admits no provisioning, activation, spend, live run or interactive use.
