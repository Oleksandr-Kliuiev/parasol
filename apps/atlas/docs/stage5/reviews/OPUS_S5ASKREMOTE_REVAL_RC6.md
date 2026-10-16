**Verdict: APPROVE_PREPARATION** for exact RC6. This approves the preparation docs only. It grants no spending, activation or live acceptance.

**Hash checks**
- `verify-rc6.py` reported: artifact `S5ASKREMOTE-REVAL-PREP-rc6`, packageHash `66dcc033c71f5836e8904b289c0aeb493b5de96264098f884eded931e01b6fa7`, manifestSha256 `6ee13df86634d0042387262cf59b2057b65c600ab842c439cb1ebd622e87a665`. All 18 entries matched, with no mismatches.
- The manifest has the same head (`916a4d6`) and the same 13 reference hashes as RC5. The only administrative deltas are `AI_CONTEXT_MAP.md` and `DEVELOPMENT_WORKFLOW.md`, and the gates are still PENDING / NOT_ADMITTED / NOT_READY.
- This round I ran only the verifier. I read the manifest and the current plan.

**Closure of my required finding: CLOSED**
- **`ASK_REMOTE_INVALID` now ends the run.** It is TERMINAL_FAILED whatever the subcause (`S5ASKREMOTE_REVAL_PLAN.md:204`, `:247-249`). It is explicitly a zero-tolerance schema/envelope violation, never a permitted semantic failure. That matches the strict reading of 05's "zero schema… violations."
- **`ASK_REMOTE_UNAVAILABLE` always stops the run** (`:205`, `:240-246`):
  - A confirmed circuit or config fault gives TERMINAL_FAILED; anything else gives TERMINAL_INCOMPLETE.
  - There is no next dispatch, no automatic reactivation, and no raw upstream diagnostics.
  - The case is consumed and its liability retained.
- **Precedence is explicit.** These special rows override the generic provider-error CASE_FAIL (`:245`), and the outcome stays in the denominator.
- **Preflight before every submission is in place** (`:236-238`). A read-only capability check confirms the policy is active and the version tuple matches the one the operator confirmed. A version change, a pause, or an unavailable preflight blocks the submission without consuming the case. The plan also says this can't rule out a concurrent revoke, so the server's own checks remain the authority.
- **No architecture changes.** No adapter, error surface or threshold changes, and no billable probing.

**Nearby consistency (residuals, non-blocking)**
1. Row `:206` still says "transport error" leads to a consumed CASE_FAIL and the run continues. Under 02, upstream and transport failures show up as `ASK_REMOTE_UNAVAILABLE`, so the precedence clause makes the run terminal. In practice row 206 now only covers `ASK_DEADLINE` timeouts. The wording should be tidied in the execution artifact.
2. If preflight finds the policy unexpectedly paused or inactive, the submission is blocked but no run state is named. It falls under the existing "revocation / loss of authority" stop, so the run ends TERMINAL_INCOMPLETE.
3. Stopping on any `UNAVAILABLE` means a transient 429 or 5xx now ends the run as incomplete. That is conservative and consistent with 05 ("incomplete eval does not pass"), but it raises the chance of needing a new admission and budget.
4. My earlier non-blocking points remain execution-artifact items, not accepted implementation:
   - what "independent replay" can actually verify;
   - how timed-out cases count in latency percentiles;
   - supervisor pacing to avoid `ASK_BUSY`, and whether a text mismatch blocks the submission;
   - supported-case labels having only one labeller;
   - voluntary same-day pause and resume;
   - citing the feasibility calculation in the admission Budget row.

**Still PENDING:**
- frozen dataset, rubric and labels;
- supervisor or runner and offline rehearsal, each needing Sol/Opus acceptance;
- EU project, ZDR/MAM retention, key, current price and its expiry;
- owner data and budget admission;
- live evidence.

The required pair is Sol6.1/xhigh plus Opus5.5/xhigh. This is the Opus half, and the Sol verdict is still pending. No Fable gate applies.

**Reviewer identity:** the system reports the model as `claude-opus-5-5`. I can't observe my own xhigh effort. The launcher and message-stream evidence establish model and effort.
