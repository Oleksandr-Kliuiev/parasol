# Independent Sol bounded RC2 re-review

Verdict: **CHANGES_REQUIRED** — RC1 R6 remains partially open; the other six RC1 findings are closed.

Artifact: `S5ASKREMOTE-REVAL-EXECUTION-rc2`; package hash `9db596d556571e8e705b835eecd7d3daa0973ba16a74984fcf64a048650242f3`.
Manifest: `verification/stage5/S5ASKREMOTE_REVAL_EXECUTION_RC2_MANIFEST.json`.

Assignment: same independent reviewer session `/root/reval_execution_sol`, explicitly assigned `gpt-6.1-sol` / `xhigh` for this bounded repair re-review. No other current reviewer verdict was supplied or consulted. Backend response-model/provider telemetry remains **UNAVAILABLE**; neither the assignment string nor self-identification establishes effective backend identity. Attributable subscription usage is unavailable.

## Identity and checks

- Recomputed the package hash from the compact manifest entries: exact match. All **116/116** listed current files match.
- RC2 ZIP has 116 entries matching the manifest; ZIP SHA-256 `8d1fbcfa672dbf4aaf3fa3462bab856d2ae2bc6449be2702d25a01d11eb8a436`.
- All **1,431/1,431** existing baseline files remain byte-identical. Accepted product/source/build/schema/dependencies/norms/offline corpus have not changed. HEAD remains `916a4d69853ff6da636e8609a2e0bd33aa787f66`.
- Re-ran the declared focused suite: **74 passed, 0 failed**; typecheck exit 0.
- Re-ran `cli.ts rehearse` without write flags: **44/44**, deterministic replay, byte-identical committed receipt; SHA-256 `104a3095880b96eec9af9a9c2f9a2fa218b1845fef3a27baf5256f7416717742`.
- Repeated the fractional-time and key RC1 financial/window/closure triggers through the actual session class. Added a real pty probe of kernel echo during startup. No admission, lock, case or receipt was created by that probe; its child process was stopped. Rechecked artifact and baseline hashes afterward: no mismatches.
- Read-only scope observed. No reviewed source edits, regeneration/write flags, live/provider/DB/account/key/budget/deployment actions. This report is the sole review output file.

## RC1 finding disposition

| Finding | RC2 disposition and evidence |
|---|---|
| R1 fractional latency/export failure | **CLOSED.** `session.ts:91-96` canonicalizes both clock samples to integer milliseconds. A 700.125ms probe now exports duration 700 and a valid numeric replay. Tests also exercise fractional starts/endpoints and reject non-finite samples. |
| R2 impossible successful-answer ledger | **CLOSED.** `book.ts:18-23` requires exactly one dispatched attempt and a compatible paid/retained settlement. `session.ts:245-259` records contradictions conservatively and does not credit the answer. Both no-reservation/no-dispatch probes stop `TERMINAL_INCOMPLETE` with `LEDGER_REPLY_CONTRADICTION`. Authentic error safety handling is preserved. |
| R3 counter erasure | **CLOSED.** `book.ts:33-50` retains day/month floors; `session.ts:174-182` stops on a decrease/regression. The retained-reserve erasure probe now stops `COUNTERS_BELOW_ACCOUNTED_FLOOR`. DAY rollover preserves MONTH, covered by tests/rehearsal. |
| R4 missing saved numeric/closure evidence | **CLOSED.** `session.ts:267-276`, `closure.ts:12-15,28-37`, and `receipt.ts:57-87` preserve submitted policyVersion, UTC bucket, pre/post counters, attempts, settlement, charge, totals and bounded closure history. Numeric replay reconstructs the declared arithmetic/floor/totals checks and detects the covered mutations. It remains expressly separate from unavailable live answer replay/authority proof. |
| R5 before-start submission | **CLOSED.** `session.ts:97-102,192-198,335-356` enforces the local admission window and checks resume. The before-start probe consumes zero cases; exact start, expiry and month behavior are covered. Local wall-clock provenance remains unverified. |
| R6 untrusted input echo | **PARTIALLY OPEN.** Software echo is removed and UTF-8 chunking is repaired, but terminal-driver echo remains enabled during startup and between prompts. See required finding below. |
| R7 closure integer bounds | **CLOSED.** `closure.ts:6-9,28-37` enforces exact keys and signed-64-bit bounds in one run-wide absorbing floor. The max+1 probe now returns `CONTAINMENT_UNCONFIRMED`; max/stale/foreign/extra-key and voluntary-to-DAY floor regressions are covered. |

## Required finding — R6 follow-up [P2]: kernel echo leaks type-ahead input

Location: `scripts/ask-remote-eval-execution/operator.ts:65,70,75-79`.

The new collector itself never echoes, but `read` calls `setRawMode(false)` immediately after every completed value, restoring the TTY's cooked-mode ECHO flag while the command is processed. Startup prints the banner and performs `loadContext()`/artifact verification before enabling raw mode for the first read. Input typed or pasted during those intervals is therefore echoed by the terminal driver before any collector/validator can reject it.

Concrete reproduced trigger: start the actual CLI `session --receipt-dir /tmp/atlas-reval-execution` in a real pty; wait for the final banner line but before `reval>`; send `TYPEAHEAD_PRIVACY_MARKER` followed by Enter during artifact/corpus verification. `termios` reports ECHO enabled, and the marker appears in terminal output. The probe creates no admission/receipt/lock. The same code restores ECHO between later prompts, including command-processing intervals. The injected TTY tests cannot expose this because their `setRawMode` is a no-op.

Impact: R6's required reject-without-content-echo privacy property is still false for type-ahead or a paste arriving while the tool processes input. A mistaken question/body paste can reach terminal scrollback/capture even though all explicit software writes are fixed codes. The README/banner claim that all input is echo-off is broader than the actual implementation.

Required repair: disable kernel echo before the first banner/verification and keep it disabled throughout the complete session, including processing intervals; restore the original terminal state only on session exit/cleanup. Manage listener/pause state independently of terminal echo. Add a real pty regression that injects a harmless marker during startup verification and during command processing, asserting it never appears in output. Preserve fixed-code errors, UTF-8-safe collection and finalization.

## Nearby regressions and remaining boundaries

The GO/NO-GO flow persists the in-flight record before printing GO. Save failures block further supervision; abandoned cases are journaled with unknown liability. Correlation reuse is refused and local handoff validation failures remain unattributed rather than being mislabeled as observed server errors. Corpus bytes are bound to the verified identity. These changes stay inside the local instrument.

Live acceptance/readiness remains false/BLOCKED, per-case and run verified-pass fields remain false, and every safety row refuses verified-zero credit. Server-process, authority, fixture provisioning, numeric read/closure contracts, transient handoff, egress, privacy scans, human labels and owner data/budget admission remain explicit unresolved proof/admission gaps. No local approval may fill those gates. No broad PG/browser suite was necessary for unchanged product code.

A bounded re-review of the echo repair must name the exact next package/hash and updated pty/check evidence. RC2 is not approved until R6 is closed.
