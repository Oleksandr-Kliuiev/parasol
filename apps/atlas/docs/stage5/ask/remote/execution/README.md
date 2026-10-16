# ASK-REMOTE R-EVAL — local execution instrument (preparation)

Status 2026-10-11: **LOCAL PREPARATION ONLY. Live admission BLOCKED.** Data/budget NOT_ADMITTED, paid product calls 0,
labels DRAFT_MODEL_ASSISTED, human attestation PENDING. Historical RC3 approvals stay frozen as history; an additional independent
Sol review of RC3 was CHANGES_REQUIRED (unknown-liability priority); independent RC4 reviews (Sol, Opus) were CHANGES_REQUIRED
(replay validity/consistency, error envelope with unparsed request). This is the RC4 repair candidate; fresh independent acceptance
is PENDING and no current approval is claimed. Normative basis: `../S5ASKREMOTE_REVAL_PLAN.md` (RC6),
`../S5ASKREMOTE_REVAL_ADMISSION.md`; accepted offline package `../eval/` (S5ASKREMOTE-REVAL-OFFLINE-rc3). No product code,
contract, data or norm is changed by this instrument.

## What it is

A local supervisor/measurement/assertion tool for the future MANUAL run. It ingests typed operator actions and transient V2
values, validates them with the ACCEPTED validators, keeps exact frozen-question/focus equality in memory, compares every
validated answer with the frozen fixture for the OBSERVED intent (independently of the expected label), enforces the RC6
procedural rules and emits only an allowlisted safe receipt. It never sends a request, consents, submits, retries or schedules.

```
node --experimental-strip-types scripts/ask-remote-eval-execution/cli.ts artifact-check
node --experimental-strip-types scripts/ask-remote-eval-execution/cli.ts rehearse [--write-receipt]
node --experimental-strip-types scripts/ask-remote-eval-execution/cli.ts session --receipt-dir <existing dir>
node --experimental-strip-types scripts/ask-remote-eval-execution/cli.ts replay --receipt <receipt file>
node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts   # includes a real-pty test (needs `script`)
```
Exit 0 ok, 1 check failed, 2 usage. There is no `--live`, key, env or paid path. `session` refuses a non-TTY input/output.

| Part | Behaviour |
|---|---|
| Identity | Pinned SHA-256 of the offline RC3 and R-C RC1 manifests; re-hash of all listed source/build files, dataset/order (seed `S5ASKREMOTE-REVAL-ORDER-v1`, all 200 holdout), tool/comparator/validator/projection hashes, at start and before EVERY submission; drift → TERMINAL_FAILED. The in-memory corpus is parsed from the same bytes that are hashed and must equal the identity. |
| Admin overlays | Six routing/status paths are pinned at their EXACT current SHA-256 (`ADMIN_OVERLAYS`, digest `adminOverlaySha256` in the identity); other bytes = `ADMIN_OVERLAY_DRIFT`. Provenance: `docs/AI_CONTEXT_MAP.md`, `docs/DEVELOPMENT_WORKFLOW.md` — RC6 closed list plus root routing delta of this instrument; `AGENTS.md` — role-policy delta `verification/ROLE_POLICY_20261011_ADMIN_DELTA.json` (hash also in the offline RC3 manifest); `docs/stage5/{IMPLEMENTATION_STATUS,REVIEW_STATUS}.md`, `docs/stage5/ask/remote/DESIGN_STATUS.md` — `administrativeOnlyDeltas` of `verification/stage5/S5ASKREMOTE_RC_CLOSURE_VERIFICATION.json`. |
| Procedure core | The accepted `supervisor.ts` unchanged (absorbing terminals, consumed-first, pacing ≤10/60 s over reported preflight+submit events, DAY resume next UTC day, MONTH/expiry/unknown commit/loss of authority terminal, any UNAVAILABLE terminal, authentic INVALID/model/usage FAILED, stop-on-certain-failure 24/25 per group, 100/100 refusal, ≥190). |
| Gates | Local wall-clock window `start ≤ now < expiry` in the admitted UTC month at counters, preflight, submit and resume (`LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED`); a before-start/outside-month refusal records nothing. One-use consent challenge + checkbox attestation. Counters before each submit, same UTC day. |
| GO/NO-GO | `submit` is the gate. Only `GO_CLICK_ASK_NOW <caseId>` — printed after the in-flight receipt was persisted — allows the browser click; every other output says `DO_NOT_CLICK`. A click without GO (or a second click) must be reported with `unrecorded-click`: consumed, UNKNOWN liability, permanent integrity failure. Repeat `submit` of a consumed case = integrity failure. |
| Persistence | Receipt rewritten (fsync + atomic rename) after every command, including the in-flight case right after DISPATCH. A save failure stops supervision (only `export`/`quit` work; previous receipt stays). quit/Ctrl-C/SIGTERM/SIGHUP/fatal with a case in flight → `ABANDONED_IN_FLIGHT` (censored, unknown commit, TERMINAL_INCOMPLETE, closure pending) then save. The per-admission lock blocks a restarted process. |
| Terminal echo | `cli.ts session` puts the TTY in RAW mode (kernel ECHO, ICANON and ISIG off) right after installing the network guard and BEFORE its dynamic imports, banner and artifact/corpus verification; it stays raw for the whole session (prompts, command processing, re-hashing, fsync) and the prior mode is restored only at exit/cleanup. If raw mode cannot be armed the session refuses (`TTY_RAW_MODE_UNAVAILABLE`, exit 2) before displaying anything. Type-ahead is buffered unechoed and consumed by the next prompt (bytes after Enter/Ctrl-D in one chunk are kept, not dropped). Ctrl-C is a byte read as ABORT at the next prompt (no kernel SIGINT bypass) and finalizes; an external SIGINT/SIGTERM/SIGHUP also finalizes and restores the terminal. Residual: bytes typed during Node's own process start-up, before the CLI's first statements run, can still be echoed — start the command and wait for the banner before pasting anything. |
| Liability | Ledger metadata must bind to the reply correlation, agree with the reply kind (an answer or upstream INVALID/model/usage error needs exactly one dispatched attempt; model/usage retains the reserve) and reconcile `pre + charged = post`; otherwise UNKNOWN commit (reserve retained, run ends). A validated answer whose liability is not established — ledger missing, bound to a foreign correlation, arithmetically unreconciled, contradicting the reply kind, or explicitly `RETAINED_UNKNOWN_COMMIT` — gets NO case pass and NO validated-provider credit (`ANSWER_LIABILITY_UNKNOWN`, or `LEDGER_REPLY_CONTRADICTION`); the reserve stays retained (an explicit unknown commit keeps the full 300000 in the floor), never retried or refunded. Unknown liability never masks what the validated answer proves: a truth (claim/coverage/urgency/schema) failure stays TERMINAL_FAILED (`SAFETY_VIOLATION_UNDER_UNKNOWN_LIABILITY` / `…_UNDER_CONTRADICTORY_LEDGER`), and a semantic mismatch/deviation that makes a threshold unreachable (any refusal, or a second failure in a supported group) stays TERMINAL_FAILED (`THRESHOLD_UNREACHABLE_UNDER_UNKNOWN_LIABILITY` / `…_UNDER_CONTRADICTORY_LEDGER`); a grounded match or a first supported mismatch otherwise ends TERMINAL_INCOMPLETE. Only MATCH/MISMATCH and truth booleans are persisted. The supervisor-level reason for these no-credit cases is `UNCLASSIFIED_ERROR`; `run.localReason` names the precise cause. Numeric replay also checks that no unknown-liability answer is credited or passing. Accounted floors persist across cases: MONTH never decreases; DAY resets only when the UTC day advances; a lower counter read stops the run (`COUNTERS_BELOW_ACCOUNTED_FLOOR`). No refund is ever inferred. |
| Closure | One run-wide floor for voluntary and supervisor DAY/terminal closures: exact four keys, this admission, `paused:true`, signed-64-bit decimals strictly above every observed version and confirmed fence. Anything else → absorbing CONTAINMENT_UNCONFIRMED (no resume, no thresholds). |
| Transient evidence | Request: accepted strict JSON + `askRemoteRequest`; a parsed request with different question/focus/tuple → consumed CASE_FAIL. Reply: whole browser V2 answer/error validators BEFORE any boolean, then the accepted comparator. An ERROR envelope validated by the accepted validator keeps its code, correlation and safety tally even when the pasted request cannot be parsed (text `REQUEST_UNVERIFIED`, handoff detail `REQUEST_UNPARSED`, counted as a handoff failure; the run stops INCOMPLETE unless the code itself is FAILED). A paste that fails local parsing/validation/correlation is `LOCAL_HANDOFF_UNVERIFIED`: unattributed, TERMINAL_INCOMPLETE, counted separately, never an observed ASK_REMOTE_INVALID or schema violation. A capability/answer/error correlation already seen in this session is refused (`CORRELATION_REUSED`); this guards stale pastes only and proves no server freshness. |
| Latency | Integer ms: the clock is floored at the session boundary; `submit` → `arrived` keystrokes (operator-bracketed), nearest-rank p50/p95/max with explicit n; timeouts/abandoned censored; denominator 200. |
| Receipt v2 | Exact allowlist + accepted offline scan. Per case: IDs/enums, duration, liability, correlation, submitted policyVersion, UTC day, pre/post counters, attempts, settlement, charged, reconciliation, handoff detail, truth booleans, `verifiedPass:false`. Run: effective/supervisor state, reasons, closure, in-flight, totals, closure history (versions/fences). Never question, hash/length, bodies, raw answer or observed intent. `liveAcceptanceEligible:false`, `verifiedPass:false`, readiness BLOCKED are constants. |
| Replay | `replay.numeric` (`cli.ts replay --receipt`) first re-validates every saved bound ledger and counter with the SAME ingestion rules (admitted caps, DAY ≤ MONTH, attempts, settlement/charge bounds — CONFIRMED 1…9434, retained = full 300000 — and reply-class consistency); then re-derives arithmetic, floors, totals, closure progression, consumption, each `casePass` (validated answer ∧ MATCH ∧ all truth booleans ∧ request matched ∧ reconciled known liability), group/refusal pass counts, safety rows, compared/handoff/integrity counts, and refuses a `procedureThresholdsMet` claim without the complete-run conditions. It proves internal consistency of the saved evidence only, not authenticity: a fully consistent forgery is not detectable. Live answer predicates stay `UNVERIFIABLE_UNDER_PRIVACY_CONTRACT`; the rehearsal replays them deterministically. |

## Operator session (future manual use; still UNADMITTED)

Start the command, wait for the banner, then type. The terminal stays raw (no kernel echo) until the session ends; lines end
with Enter, pastes with Ctrl-D; output is fixed codes and validated IDs only. Order:
`admission` → `confirm` → per case: `counters`, `capability` (paste of a fresh reply = preflight), `next`, `stage` (focus +
question paste), tick the browser checkbox, `consent` (type the challenge), `submit` → click Ask only on `GO_CLICK_ASK_NOW`,
`arrived`, `outcome` (request body, reply, owner-read ledger numbers). Also `unrecorded-click`, `deviation`, `closure`, `pause`,
`resume-day`, `resume-pause`, `export`, `quit`. Pastes are NOT hidden from the clipboard, devtools or recorders; never put
questions/bodies in shell commands, history, files or logs. Copy one request/response from the devtools response view; never
save HAR or "Copy as cURL". The tool never prints a question. A TTY and the challenge resist casual piping, not a pty driver:
operator identity stays ATTESTED. Pacing counts only reported events; browser fetches not reported here are not counted.

## Missing contracts (named blockers, not built)

| Blocker | What is missing |
|---|---|
| `LEDGER_METADATA_READ_CONTRACT_MISSING` | Accepted read-only owner path: attempt count, settlement, charged micro-USD, DAY/MONTH counters per correlation |
| `CLOSURE_RECEIPT_READ_CONTRACT_MISSING` | Accepted owner fence-first pause receipt export |
| `FIXTURE_DB_PROVISIONING_CONTRACT_MISSING` | Provisioning the 11 frozen fixtures (one shared client scope) into the synthetic DB and proof DB = fixture |
| `TRANSIENT_RESPONSE_HANDOFF_CONTRACT_MISSING` | Reviewed browser→instrument handoff; manual devtools copy is attested, not server-bound |
| `SERVER_PROCESS_IDENTITY_UNVERIFIED` | Proof that the running server loaded the verified build |
| `EGRESS_PLATFORM_PROOF_ABSENT`, `PRIVACY_SCAN_NOT_MEASURED` | Platform allowlist evidence; before/after destination scan |
| `OPERATOR_IDENTITY_ATTESTED_ONLY`, `HUMAN_LABEL_ATTESTATION_PENDING`, `OWNER_DATA_BUDGET_ADMISSION_ABSENT`, `EXECUTION_ARTIFACT_ACCEPTANCE_PENDING` | Identity, human labels, owner admission, independent acceptance of this artifact |

Every safety row reports `countsAsVerifiedZero:false`; unattributed handoff failures are counted separately and never as zero.

Qualifications: operator declarations stay attested and can HIDE an unreported failure (declaring `timeout`/`unparseable`, or not
attesting a config fault, moves a reply toward INCOMPLETE and never toward a pass, but may mask a FAILED-worthy reply). Non-answer
uncertainty (timeout, UNAVAILABLE without proven fault, unparsed reply) on a refusal case ends INCOMPLETE as the frozen RC6
supervisor prescribes; the proof-based FAILED escalation is deliberately limited to validated answers. `executionToolSha256` is
recorded, not pinned: compare it with the accepted manifest. GO follows fsync + rename but no directory fsync/`F_FULLFSYNC`
(power loss may lose the in-flight record; the server ledger still shows the attempt). A ledger read after UTC midnight does not
reconcile (unknown commit); a lost/restarted process cannot resume (the lock blocks it), which also ends a RESUMABLE_DAY run;
a closure typo is absorbing containment.
Accepted validators show POTENTIAL enforcement, not an observed run. No flag in this version can mark a run admitted.

## Offline fake-V2 rehearsal

`rehearse` plays 56 scripted scenarios (X01–X56) through the SAME session class with a fake server/ledger/clock (incl.
fractional clocks, contradictory/erasing ledgers, DAY rollover, before-start, voluntary/DAY fence reuse, out-of-range closure,
unrecorded click, abandoned in flight, re-pasted capability, unparsed request, authentic model mismatch, false claim or refusal
mismatch with a contradictory ledger, pre-start counters, refusal/second-supported mismatch and grounded match under unknown
liability, validated errors with an unparsed request), checks every
scenario receipt validates and replays numerically, then repeats everything and requires byte-identical results. The fake
returns the DRAFT label and accepted compiler output: measurement/assertion integration only (`semanticEvaluation:false`).
