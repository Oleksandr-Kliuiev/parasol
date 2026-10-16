# R-EVAL execution instrument — implementation report (checkpoint)

Date 2026-10-11. Writer: native Claude Code, `claude-opus-5-5` / `medium`, session `70cb5d2b-194a-4039-aef5-f5fae064ec76`
(preflight `/tmp/atlas-reval-execution/implementation-preflight.json`: claude.ai Max, firstParty, extraUsage false, no provider
override, fast mode off). Included subscription only; no API/credits/fast/fallback. Paid product calls: **0**. No human
signature, label attestation or review slot was filled. No commit, no reviewer launched. Independent Sol6.1/xhigh +
Opus5.5/xhigh checkpoint acceptance: **PENDING** (root). No Fable review is required: no architecture changed.

## Readiness, stated precisely

| Question | Answer |
|---|---|
| Ready for LOCAL use (artifact check, offline fake-V2 rehearsal, manual unadmitted observation session)? | Yes, subject to the pending independent acceptance |
| Live admission / readiness? | **BLOCKED** (schema constant; no flag changes it) |
| Live acceptance evidence from this tool? | None possible in this version: every safety row `countsAsVerifiedZero:false` |
| Real V2 integration measured? | **No.** No live or server-backed run happened; the production browser→server journey under this procedure is UNVERIFIED |
| Provider quality/latency measured? | No (`semanticEvaluation:false`; fake returns draft labels) |

## Feasibility assessment (first step)

The accepted V2 public boundary (`02_CONTRACTS.md`, RUNBOOK §15–16) exposes the capability tuple, AskAnswerV2/AskErrorV1
and correlation IDs only. Ledger attempt/settlement/counter reads, fence-first closure receipts, fixture provisioning into
the synthetic DB (all 11 fixtures share one client scope), a reviewed browser→instrument handoff, server process identity,
egress and privacy-scan proof have no accepted contract. Building them needs product authority/data/public-contract changes,
which were NOT made. The instrument therefore accepts those values as ATTESTED operator input, marks provenance, treats
missing/unbound/unreconciled ledger data as an UNKNOWN commit, and names each gap as a fixed admission blocker (README).

## Delivered (new files only)

`scripts/ask-remote-eval-execution/` (AGENTS + 10 modules, largest 273 lines), `tests/ask-remote-eval-execution-{session,
receipt,cli}.test.ts`, `docs/stage5/ask/remote/execution/{AGENTS,README,IMPLEMENTATION_REPORT}.md`, generated
`rehearsal/EXECUTION_REHEARSAL_RECEIPT.json` (sha256 `8d71a0bb5b7e5303886741342ecd9080ef3b55d410be7394206f6ef7904d7ba5`).
Imported unchanged (pure, guard first): offline `supervisor`, `predicates`, `expected-facts`, `fixtures`, `dataset`, `evidence`,
`harness` (prepareFixtures), `net-guard`; production `askRemoteRequest`, `parseStrictJson`, `remoteAnswer`, `capabilityV2`;
browser `validateRemoteAnswer`, `validateAskError`, `validateRemoteCapability`.

Identity at this checkpoint (`artifact-check`): offline package `d706a437…f2dc3a`, R-C package `9ae0c2b8…7fe1`, dataset corpus
`e31aa1c2…8df8`, fixtures `40f1744a…aa8d`, order `9deaa3c5…4a5d`, execution tool `79dfc48d274f9bd4f7cc8499e3ba28a0f9609f53728a7bded38da346f84b0c10`,
comparator `aa43cd8f…667a`, browser validators `b31b21a0…05c1`, projection `940e5daa…3ea5`; 1583 files re-hashed, drift none;
administrative deltas only on the six declared routing/status paths.

## Commands actually run (results)

| Command | Result |
|---|---|
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 20/20 pass |
| `node --experimental-strip-types --test tests/ask-remote-eval-{corpus,fixtures,supervisor,offline}.test.ts` | 37/37 pass (accepted offline) |
| `node --experimental-strip-types --test tests/context-budget.test.ts` | 1/1 pass |
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `cli.ts artifact-check` | exit 0, ok, liveAdmissionReadiness BLOCKED |
| `cli.ts rehearse --write-receipt` | exit 0, 30/30 scenarios, replay `DETERMINISTIC_REHEARSAL_REPLAY_VERIFIED`, scan CLEAN |
| `scripts/ask-remote-eval/cli.ts all` (accepted offline, no write) | exit 0, ok |
| Manual pty smoke (`script -q` → `session`: help/status/admission/next/stage with a marker paste/quit, temp dir) | echo-off verified (marker absent from output and receipt), lock + safe receipt written; not a committed test |
| Baseline check vs `/tmp/atlas-reval-execution/baseline.json` | 1431/1431 files byte-identical, HEAD `916a4d6…`; 17 new paths, all inside the allowed scope |

Not run (no product code changed): `npm test` in full, PG17, browser/Playwright, API build. Production journey UNVERIFIED.
Defect found and fixed during the session: `process.exit` after a large stdout write truncated piped output at 64 KiB; the
CLI now exits only after stdout flushes (covered by the CLI receipt-equality test).

## Boundaries and residuals

- Supervisor reuse keeps its model qualifications: it is still a procedure model, not product authority; the server re-checks
  authority. Wrapper adds integrity on duplicate submission and on ledger `attempts ≥ 2`.
- Latency is operator-keystroke bracketed (`submit`/`arrived`), monotonic but includes human reaction time; not provider timing.
- Consent challenge + TTY requirement resist piping, not a pty/expect driver; operator identity ATTESTED.
- Pastes are echo-off but visible to clipboard/devtools/recorders; documented. The tool never prints questions, so the operator
  needs a separate restricted way to read the frozen text (residual usability gap).
- A crash loses in-memory state; the per-admission lock blocks a silent restart; run must be treated INCOMPLETE and closed.
- Closure/ledger/counter typos are fail-closed (closure → CONTAINMENT_UNCONFIRMED, ledger → re-prompt or UNKNOWN commit).
- Receipt schema accepts only `DRAFT_MODEL_ASSISTED`/`HUMAN_ATTESTATION_PENDING` labels and the pinned manifests: any admitted
  dataset/admission sheet change requires a new reviewed tool revision (intended).
- Rehearsal per-submit drift checks use an injected snapshot (one real verification at load); the operator session re-hashes
  all files before every submission. `ASK_REMOTE_BUDGET` (429) is conservatively TERMINAL_INCOMPLETE (unclassified).
- Live per-case replay is impossible under the privacy contract; only deterministic rehearsal replay is verified.
- Root integrates routing (root AGENTS/AI_CONTEXT_MAP/status) after ownership returns; those are declared administrative paths.

Ownership of the checkout returns to root at this checkpoint.

## Addendum — bounded pre-review repair: pinned administrative overlays (same session)

Same native `claude-opus-5-5` / `medium` session `70cb5d2b-194a-4039-aef5-f5fae064ec76`; root returned sole write ownership.
The initial report above is preserved unchanged as evidence of the first checkpoint (its hashes/results are superseded below).

Context: root added routing for this instrument ONLY in `docs/AI_CONTEXT_MAP.md` (`27406058…3241` → `e6083a0d…3f04`) and
`docs/DEVELOPMENT_WORKFLOW.md` (`3256fbbb…ee93` → `1dc7abec…c3e6`), declared in `/tmp/atlas-reval-execution/admin-delta.json`.
Updated baseline vs original baseline: 1431 entries, same HEAD, differs in exactly those two paths (verified).

Finding repaired: `artifact.ts` previously let ANY bytes on the six administrative paths differ from the historical manifests
without affecting identity. Now `ADMIN_OVERLAYS` pins each path's exact current SHA-256: AGENTS.md `760214a5…b9b`,
AI_CONTEXT_MAP `e6083a0d…3f04`, DEVELOPMENT_WORKFLOW `1dc7abec…c3e6`, stage5 IMPLEMENTATION_STATUS `a851475a…697f`, REVIEW_STATUS
`09e1b1a0…ab8a6d`, ask/remote DESIGN_STATUS `ba8e704b…c6d2`. They are verified at start and before every submission
(`overlayDrift` pure comparator → `ADMIN_OVERLAY_DRIFT`); a manifest mismatch is tolerated only when current bytes equal the pin;
the pinned table digest `adminOverlaySha256` is in `Identity` and the receipt schema. The two root-routing pins equal the
declared `after` hashes. Accepted manifests and all preexisting files untouched; root docs not edited.

Regression: `tests/ask-remote-eval-execution-session.test.ts` "administrative overlays are frozen…" (injected actual hashes:
exact → no drift; one changed / unreadable / all changed → exactly those paths; digest changes with the table; identity with a
different overlay digest is not the same identity). No repository file is mutated by the test.

Current identity (`artifact-check`, exit 0, drift none, 1589 hashes incl. overlays): execution tool
`c6fa8874b3ca7e6ccf4ce834224c7a439e260dcd45cc6db8cf3d4addcf3d1b05`, admin overlay digest
`9e4ce08304d1bc69d067eff1e24cab898e86978ab968135ee3d112f74bbcc0aa`; other identity hashes unchanged. Regenerated rehearsal
receipt sha256 `1ea04722b1f338e07dda8835bc2fd262fd67df7f61b28e709a2074d88d0e3abd` (30/30, deterministic replay, scan CLEAN).

| Command (repair) | Result |
|---|---|
| `cli.ts rehearse --write-receipt` | exit 0 |
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 21/21 pass |
| accepted offline 4 files + `tests/context-budget.test.ts` | 38/38 pass |
| `npm run typecheck` | exit 0 |
| Baseline vs UPDATED `/tmp/atlas-reval-execution/baseline.json` | 1431/1431 byte-identical, same HEAD; 18 new paths (the 17 above + this report), all inside the allowed scope |

Paid product calls 0; no live/network/provider/product calls; no reviewers launched; write ownership returns to root.

## Addendum — RC1 required repair round 1 (same session)

Same native `claude-opus-5-5` / `medium` session `70cb5d2b-194a-4039-aef5-f5fae064ec76`; root returned sole write ownership.
Source artifact RC1 `d23084ec0f7e9cd55823e7a0484b6f9425559e6d27e20ed65829f63260418f77`; archive/manifest unchanged (ZIP `9761932a…`,
manifest `7724b5f1…`). Both independent RC1 reviews (`docs/stage5/reviews/{SOL,OPUS}_S5ASKREMOTE_REVAL_EXECUTION_RC1.md`) were
CHANGES_REQUIRED; earlier sections of this report are historical and superseded where they conflict with this addendum.
Writes only in the original allowed new scope; no product/offline/norm/data/root-doc/status change; pinned admin overlays unchanged.

| Finding | Repair | Regression (reproducer) |
|---|---|---|
| Sol R1 fractional durations / stale export | Session floors every clock sample to integer ms; receipt saved after every command; save failure stops supervision (only export/quit), old receipt intact (fsync + atomic rename) | repair R1 (700.125/1234.999 ms → 700/1234, receipt exports), X31, operator save-failure test |
| Sol R2, Opus P3-1 impossible no-attempt answer | `book.ts` reply↔ledger consistency: answer/upstream INVALID need exactly one dispatched attempt, model/usage retain reserve; contradiction → `LEDGER_REPLY_CONTRADICTION`, UNKNOWN commit, no pass, no provider credit | X32, X33, X44, repair R2 table |
| Sol R3 counters erase retained reserve | `LiabilityBook` floors: MONTH never decreases, DAY resets only at the UTC boundary; lower read → `COUNTERS_BELOW_ACCOUNTED_FLOOR` TERMINAL_INCOMPLETE | X34, X35, X36, repair R3 unit |
| Sol R4 receipt drops numbers/closures | Receipt v2 keeps per-case submitted policyVersion, UTC day, pre/post counters, attempts, settlement, charged; totals; closure history (kind/result/version/fence); `replay.ts` + `cli.ts replay` | repair R4 (values + 5 tamper detections), CLI replay test |
| Sol R5, Opus P3-2 start/month, clock disclosure | `start ≤ now < expiry` + admitted month at preflight/submit/resume; provenance `utcClock: LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED`, UNVERIFIED entry, banner | X37, repair R5 (start−1 blocked, start allowed) |
| Sol R6, Opus P2-2 echo / multibyte | `tty-input.ts`: all input echo-off, bytes joined then fatal UTF-8 decode, markers stripped on joined text; operator injectable I/O | repair R6 (25 RU questions × chunk 1/2/3/1022 B), operator marker test, real pty smoke |
| Sol R7, Opus P2-1 closure bounds / split floors | `closure.ts`: ONE floor for voluntary + supervisor closures; exact keys, signed-64-bit, strictly newer; failure absorbing and forced into the supervisor (`close(null)`) | X38 (voluntary fence 41 reused → containment, resume denied), X39, repair R7 |
| Opus P2-3 click before gate | `submit` = GO/NO-GO; `GO_CLICK_ASK_NOW` only after the in-flight receipt persisted; `unrecorded-click` → consumed + integrity | X40, operator GO test (receipt on disk shows in-flight at GO) |
| Opus P2-4 in-flight hidden | Receipt `run.inFlight`; quit/Ctrl-C/SIGTERM/SIGHUP/fatal/save-failure → `ABANDONED_IN_FLIGHT` before final save; lock blocks restart | X41, operator quit + Ctrl-C + restart-lock tests |
| Opus P3-3 replayed capability | Seen-correlation set over capability/answer/error → `CORRELATION_REUSED` (no claim of server freshness) | X42, repair P3-3 (reply reusing a capability correlation) |
| Opus P3-4 local failure as schema violation | `LOCAL_HANDOFF_UNVERIFIED` (detail enum), TERMINAL_INCOMPLETE, counted as `unattributedHandoffFailures`, no safety tally; authentic ASK_REMOTE_INVALID still FAILED | X13, X43, X09, repair P3-4 |
| A1 / A2 / A3 / A4 | `verifiedPass:false` per case and run; pacing provenance `REPORTED_EVENTS_ONLY`; corpus parsed from the hashed bytes (`bindCorpus`); README cites overlay sources | receipt schema, repair A3 (tampered fixture bytes → `CORPUS_IDENTITY_MISMATCH`) |

New modules `book.ts`, `closure.ts`, `replay.ts`, `tty-input.ts`; new tests `tests/ask-remote-eval-execution-{repair,operator}.test.ts`.
Largest file `session.ts` 373 lines. Residuals unchanged in substance: live answer-predicate replay stays unverifiable; capability
freshness beyond in-session correlation uniqueness, server binding of pastes, ledger/closure/fixture/handoff/egress/privacy
contracts remain named blockers; a pty driver can still type; local wall clock unverified.

| Command (repair round 1) | Result |
|---|---|
| `cli.ts rehearse --write-receipt`, then `rehearse` twice | exit 0; 44/44 scenarios, every scenario receipt numeric replay VERIFIED, deterministic replay; both runs byte-identical to the stored receipt `104a3095880b96eec9af9a9c2f9a2fa218b1845fef3a27baf5256f7416717742` |
| `cli.ts artifact-check` | exit 0, drift none, 1589 hashes; execution tool `71ca4d20f5a1f4208e6ca3859453b983a91bbb97c4ee283da245a03fd13eddb9`, overlay digest `9e4ce083…c0aa` (unchanged) |
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 36/36 pass (5 files) |
| accepted offline 4 files + `tests/context-budget.test.ts` | 38/38 pass |
| `npm run typecheck` | exit 0 |
| `scripts/ask-remote-eval/cli.ts all` (no write) | exit 0 |
| Real pty smoke (`script -q`; marker command, Cyrillic metadata marker, Cyrillic paste, quit) | 0 marker occurrences in output; lock + receipt in temp dir only |
| Baseline vs UPDATED `/tmp/atlas-reval-execution/baseline.json` | 1431/1431 byte-identical, same HEAD; my new paths only in the allowed scope (other untracked paths are root review/evidence files, untouched) |

Paid product calls 0; no live/network/provider/account/key/admission calls; no reviewers launched; write ownership returns to root.

## Addendum — RC2 required repair round 2 (same session)

Same native `claude-opus-5-5` / `medium` session `70cb5d2b-194a-4039-aef5-f5fae064ec76`; root returned sole write ownership.
Source artifact RC2 `9db596d556571e8e705b835eecd7d3daa0973ba16a74984fcf64a048650242f3`; RC2 ZIP `8d1fbcfa…` and RC1 ZIP
`9761932a…` unchanged. Reviews `/tmp/atlas-reval-execution/{sol,opus}-rc2-report.md`: all RC1 findings closed except Sol R6
(kernel echo) and a new Opus R2-1. Only those two plus the optional nearby A2 were changed; earlier sections stay historical.

| Finding | Repair | Regression |
|---|---|---|
| Sol R6 kernel echo during startup/processing | `cli.ts` arms TTY raw mode (ECHO/ICANON/ISIG off) right after the guard, BEFORE dynamic imports; `operator.ts` keeps raw for the whole session (no per-prompt `setRawMode(false)`; listeners/pause per prompt only), restores the prior mode only at exit/cleanup/signal/fatal, fails closed (`TTY_RAW_MODE_UNAVAILABLE`, nothing displayed) if raw cannot be armed; SIGINT handler added; `tty-input.ts` keeps type-ahead after a terminator (previously dropped) | `tests/ask-remote-eval-execution-pty.test.ts` — REAL pty via `script`: markers injected during startup verification, as same-write type-ahead, during admission construction/re-hash/fsync, then Ctrl-C during processing; asserts no marker byte in pty output, `SESSION_ENDED_BY_CTRL_C`, receipt + lock. Against the RC2 `operator.ts`/`cli.ts` (temporarily restored from the RC2 ZIP, then restored back byte-exact) it fails `MARKER_ECHOED step 1`; current code passes. Injected-TTY tests: raw armed once/restored once, fail-closed with empty output, CLI-armed prior raw never switched off, same-chunk type-ahead consumed |
| Opus R2-1 contradiction masks truth/threshold failure | For a validated answer with a contradictory ledger the supervisor still gets the conservative ERROR (no credit, no pass, UNKNOWN liability), and the wrapper escalates to TERMINAL_FAILED when the answer itself proves a truth failure (`SAFETY_VIOLATION_UNDER_CONTRADICTORY_LEDGER`) or a certain failure (mismatch/deviation) that makes a threshold unreachable (`THRESHOLD_UNREACHABLE_UNDER_CONTRADICTORY_LEDGER`); evidence/receipt keep MATCH/MISMATCH only | X45 (false claim + contradiction → FAILED, CLAIMS 1), X46 (refusal mismatch + contradiction → FAILED, no credit), X47 and X32 (first supported mismatch / grounded match + contradiction stay INCOMPLETE, no credit), repair test receipt fields |
| Opus A2 (optional) pre-start counters | `counters` gated by the window (before start / outside month → `BLOCKED_*`, nothing recorded) | X48, X37 now blocks at counters |

Residual (stated in README): bytes typed during Node's own process start-up, before the CLI's first statements run, may still be
echoed by the kernel; the operator must wait for the banner. The pty test needs the `script` utility (present here; skipped with
`NO_PTY_UTILITY_script` elsewhere); it was run on macOS (BSD `script`); the Linux `script -e -c` branch is untested here.

| Command (repair round 2) | Result |
|---|---|
| `cli.ts rehearse --write-receipt`, then `rehearse` twice | exit 0; 48/48 scenarios, every scenario receipt numeric replay VERIFIED, deterministic replay; byte-identical to stored receipt `bd07eb1d8b592803881c64948befceac99686a1ce3da26b1d07947f0dceb75f8` |
| `cli.ts artifact-check` | exit 0, drift none, 1589 hashes; execution tool `7df70b16dc9af78cea879d603d9586ef4e972bf5f41f1d733dea3cedd85ef9dc`; overlay digest `9e4ce083…c0aa` unchanged |
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 40/40 pass, 0 skipped (6 files incl. real pty) |
| accepted offline 4 files + `tests/context-budget.test.ts` | 38/38 pass |
| `npm run typecheck` | exit 0 |
| `scripts/ask-remote-eval/cli.ts all` (no write) | exit 0 |
| Baseline vs `/tmp/atlas-reval-execution/baseline.json` | 1431/1431 byte-identical, same HEAD; RC2-listed non-own files unchanged; only new own path `tests/ask-remote-eval-execution-pty.test.ts` |

Paid product calls 0; no live/network/provider/account/key/admission/deployment calls; no reviewers launched; no commit.
Write ownership returns to root.
Late fix within round 2: the pty test now runs its `sh | script | session` chain in its own process group and kills the
group on every exit path (an earlier deliberately failing RC2-code run had left an orphan session, since killed). Re-run:
RC2 code → `MARKER_ECHOED step 1`, no stray process; current code 40/40, no stray process; tool hash and stored receipt unchanged.

## Addendum — RC3 additional required repair (same session)

Native `claude-opus-5-5` / `medium`, same session `70cb5d2b-194a-4039-aef5-f5fae064ec76` (included native Max; no fast mode,
API, credits or fallback); root returned sole write ownership. Source artifact RC3 `c9f84e82fb3be9b00c7f7b7595047e62a376fd630c1c958e2fe31e45c0ba8ca4`
(manifest recomputed; ZIP `0bd22889…` unchanged). Historical RC3 approvals/seal stay frozen as history and are NOT a current
approval; `ACCEPTANCE_STATUS.md` (root record) was not touched. Trigger: `/tmp/atlas-reval-handoff/SOL_EXECUTION_RC3_ADDITIONAL_REVIEW.md`
(required P2). No architecture or contract text was written.

Reproduced first (counts/enums only): refusal answered SUMMARY with unreconciled metadata → `TERMINAL_INCOMPLETE`,
`UNKNOWN_SETTLEMENT_COMMIT`, validatedAnswers 1; grounded MATCH with unreconciled or missing ledger → `casePass:true`,
validatedAnswers 1; refusal mismatch with missing ledger → INCOMPLETE.

Repair (`session.ts` only for behaviour; `receipt.ts` outcome enum; `replay.ts` credit check): the reviewed contradiction rule is
generalised to EVERY unknown-liability answer (effective settlement `RETAINED_UNKNOWN_COMMIT`: missing, unbound, unreconciled,
contradicting, or explicitly unknown). Such an answer reaches the frozen supervisor as a no-credit error (`ANSWER_LIABILITY_UNKNOWN`;
contradiction keeps `LEDGER_REPLY_CONTRADICTION`), so it never passes or counts as a validated provider answer; the wrapper then
escalates to TERMINAL_FAILED when the answer proves a truth failure (`SAFETY_VIOLATION_UNDER_UNKNOWN_LIABILITY`) or a certain
failure that makes a threshold unreachable (`THRESHOLD_UNREACHABLE_UNDER_UNKNOWN_LIABILITY`); otherwise INCOMPLETE. The ledger/
floor bookkeeping is unchanged (explicit unknown keeps the full reserve; nothing refunded or retried). Public remote error
priorities, terminal absorption and the frozen offline supervisor are unchanged. Consequence for existing scenarios X16/X17/X29:
supervisor reason is now `UNCLASSIFIED_ERROR` with `localReason ANSWER_LIABILITY_UNKNOWN` and no answer credit (expectations updated).

Regressions: `tests/ask-remote-eval-execution-liability.test.ts` — matrix 5 accounting modes (missing, foreign-correlation unbound,
arithmetically unreconciled, reply-kind contradiction, explicit RETAINED_UNKNOWN_COMMIT) × 5 proof classes (grounded MATCH, refusal
MISMATCH, truth failure, first and second supported mismatch) asserting state, local reason, no pass, no credit, semantic and truth
kept, liability totals, receipt fields and numeric replay; plus a known-accounting control and replay forgery checks
(`UNKNOWN_LIABILITY_CREDITED`, `UNCREDITED_PASS`, `VALIDATED_ANSWER_COUNT`). Against the RC3 `session.ts` (temporarily restored
from the RC3 ZIP, then restored byte-exact) 21/27 fail — the 6 passing are the already-repaired contradiction cells and the
control; current code 27/27. Rehearsal scenarios X49 (refusal mismatch unreconciled → FAILED), X50 (grounded match unreconciled →
INCOMPLETE, no credit), X51 (second supported mismatch, missing ledger → FAILED).

| Command (RC3 additional repair) | Result |
|---|---|
| `cli.ts rehearse --write-receipt`, then `rehearse` twice | exit 0; 51/51, every scenario receipt numeric replay VERIFIED, deterministic replay; byte-identical to stored receipt `b34e6dcc9ed8f5e272e6689d41954056201f367a09cd9ffe9b5c48b5b979d0d4` |
| `cli.ts artifact-check` | exit 0, drift none, 1589 hashes; execution tool `636700830aee89e1f20fc003d554da79bb3d987bd87b45e55f7f0e1a1d0b5e61`; overlay digest `9e4ce083…c0aa` unchanged |
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 67/67 pass, 0 skipped (7 files incl. real pty) |
| accepted offline 4 files + `tests/context-budget.test.ts` | 38/38 pass |
| `npm run typecheck` | exit 0 |
| `scripts/ask-remote-eval/cli.ts all` (no write) | exit 0 |
| Baseline vs `/tmp/atlas-reval-execution/baseline.json` | 1431/1431 byte-identical, same HEAD; RC3-listed files changed only in own scope (`session.ts`, `receipt.ts`, `replay.ts`, `rehearsal.ts`, tool `AGENTS.md`, stored receipt) plus README/this report; one new test file |

Largest file `session.ts` 400 lines. Paid product calls 0; no live/network/provider/account/key/admission/deployment calls; no
reviewers launched; no commit. Fresh clean Sol6.1/xhigh + Opus5.5/xhigh acceptance is pending (root). Write ownership returns to root.

## Addendum — RC4 required repair (same session)

Native `claude-opus-5-5` / `medium`, same session `70cb5d2b-194a-4039-aef5-f5fae064ec76`, included Max only (no API, credits, fast
mode or fallback); root returned sole write ownership. Reviewed artifact RC4 `04d676c1982ec2608e7e75fc39853ed2335e49c9e6645cc02b0274fb7ab5905e`
(manifest recomputed; ZIP `1e3f91fb…` unchanged). Reviews `/tmp/atlas-reval-execution/{SOL,OPUS}_RC4_REVIEW.md`: Sol R1, Opus R1,
Opus R2 required (Opus R3 is root-owned). `ACCEPTANCE_STATUS.md` differs from the RC4 manifest because root retitled it as a
historical RC3 record before this round (mtime precedes my edits); I did not write it. Historical approvals are not a current
approval; fresh independent acceptance of the next candidate is PENDING. No architecture/contract text, product or frozen-offline change.

Reproduced first (counts/enums only): from a one-answer receipt, rewriting settlement/charge with `pre + charged = post` and
consistent totals — `CONFIRMED` 0, `CONFIRMED` 9435, `RETAINED_KNOWN` 1 — each passed the schema and replayed
`VERIFIED_SAVED_ARITHMETIC` with `casePass:true`; validated `ASK_REMOTE_INVALID`/`MODEL_MISMATCH`/`USAGE_INVALID` envelopes with an
unparsed request paste ended INCOMPLETE `LOCAL_HANDOFF_UNVERIFIED` with all safety rows 0; Opus's forged receipt replayed `ok:true`.

| Finding | Repair | Regression |
|---|---|---|
| Sol R1 replay accepts impossible ledgers | `replay.ts` re-validates every saved bound ledger with `validate.ts` `ledgerValues` (admitted caps, DAY ≤ MONTH, attempts, settlement/charge bounds) and pre counters with `counterValues`, then requires `book.ts` `ledgerMatchesReply` for the saved reply class (`BOUND` must match, `CONTRADICTS_REPLY` must not) BEFORE reconciliation/totals/credit; the ad-hoc answer-dispatch check is replaced by these shared rules | `tests/ask-remote-eval-execution-replay.test.ts`: the three Sol mutations plus `NO_DISPATCH` 0 and `RETAINED_KNOWN` 299999 → MISMATCH (`REPLY_LEDGER_CLASS`/`LEDGER_INVALID`); cap, DAY>MONTH, post-over-cap, attempts 2, missing correlation; legitimate full-reserve retained answer and every scenario/unknown-liability receipt still VERIFIED |
| Opus R1 unparsed request erases a validated error | `session.ts`: only answers become `REQUEST_UNPARSED` handoffs (as `checkResponse` already did); a validated ERROR keeps code, correlation, ledger binding and safety tally, with text `REQUEST_UNVERIFIED`, handoff detail `REQUEST_UNPARSED`, a counted handoff failure and local reason `LOCAL_HANDOFF_UNVERIFIED` (INCOMPLETE unless the code is FAILED) | X52–X54 (INVALID/MODEL/USAGE → FAILED, row 1), X55 (UNAVAILABLE + attested config fault → FAILED, CONFIG 1), X56 (ASK_BUSY on a supported case → INCOMPLETE), replay test R1 field assertions; answer with unparsed request still `LOCAL_HANDOFF_UNVERIFIED` |
| Opus R2 replay ignores saved boolean consistency | `replay.ts` re-derives each `casePass` (validated answer ∧ MATCH ∧ all truth ∧ request matched ∧ reconciled known liability; mismatch either way fails), supported/refusal pass counts, safety rows (truth booleans, authentic error codes, config-fault attestations; AUTHORITY/EGRESS/PRIVACY 0), compared/handoff/integrity counts, and refuses `procedureThresholdsMet` without the complete-run conditions | replay test R2: pass on MISMATCH/false claim/deviation, hidden pass, unreported CLAIMS, refusal/group counts, thresholds on incomplete or unclosed run, MODEL_TIER/compared/handoff forgeries; Opus's forged receipt now `MISMATCH` (`CASE_PASS_DERIVATION`, `SAFETY_ROW_DERIVATION`), exit 1 |

Meaningfulness: with the RC4 `replay.ts`/`session.ts` temporarily restored from the RC4 ZIP (then restored byte-exact), the new
replay test fails 4/5 (only the legitimate-receipt control passes); current code 5/5. Non-blocking notes addressed in README
only: operator attestations can hide unreported failures; non-answer uncertainty on refusal stays INCOMPLETE per frozen RC6 (not
widened); tool hash recorded not pinned; no directory fsync/F_FULLFSYNC; midnight ledger reads, lock-blocked restart, closure typos.
TTY/durability scope unchanged.

| Command (RC4 repair) | Result |
|---|---|
| `cli.ts rehearse --write-receipt`, then `rehearse` twice | exit 0; 56/56, every scenario receipt numeric replay VERIFIED, deterministic replay; byte-identical to stored receipt `1c41398327968e8a3cbe2040b932ae61af939057ebf085c64fbfd1620bfc2d73` |
| `cli.ts artifact-check` | exit 0, drift none, 1589 hashes; execution tool `8a20b598679a7e50e4b7457b37750fedd8f2c597e441d0628cb1237d97bad776`; overlay digest `9e4ce083…c0aa` unchanged |
| `node --experimental-strip-types --test tests/ask-remote-eval-execution-*.test.ts` | 72/72 pass, 0 skipped (8 files incl. real pty) |
| accepted offline 4 files + `tests/context-budget.test.ts` | 38/38 pass (total 110) |
| `npm run typecheck` | exit 0 |
| `scripts/ask-remote-eval/cli.ts all` (no write) | exit 0 |
| Baseline vs `/tmp/atlas-reval-execution/baseline.json` | 1431/1431 byte-identical, same HEAD; RC4-listed own changes `session.ts`, `replay.ts`, `rehearsal.ts`, tool `AGENTS.md`, README, stored receipt, this report; new `tests/ask-remote-eval-execution-replay.test.ts`; `ACCEPTANCE_STATUS.md` root-owned |

Largest file `session.ts` 404 lines. Paid product calls 0; no live/network/provider/account/key/admission/deployment calls; no
reviewers launched; no commit; review and verification files untouched. Write ownership returns to root.
