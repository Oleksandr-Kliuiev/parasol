# R-EVAL execution instrument — context routing

LOCAL ONLY, not admitted. Docs: `docs/stage5/ask/remote/execution/README.md`, `IMPLEMENTATION_REPORT.md`. Plan RC6
`docs/stage5/ask/remote/S5ASKREMOTE_REVAL_PLAN.md`. No live/paid mode, key, env input, DB, provider, network, child process,
worker, schedule, auto-consent/submit or HAR/trace capture may be added. The tool never sends a request: the operator acts
in the accepted browser V2 console. Never load the dataset into context (`docs/stage5/ask/remote/eval/data/AGENTS.md`).
The accepted offline package `scripts/ask-remote-eval/` is immutable and only imported (pure modules; guard installed first).

Modules (one concern each, ≤500 lines):
- `cli.ts` entry: installs the accepted net guard, then dynamic imports; `artifact-check | rehearse [--write-receipt] |
  session --receipt-dir <dir> | replay --receipt <file> | help`. For `session` it arms TTY raw mode (kernel echo off) BEFORE
  its dynamic imports; fails closed if raw cannot be armed. Exits only after stdout flushes.
- `artifact.ts` pinned manifest anchors (offline RC3, R-C RC1), exact pinned admin overlays, file/build/dataset/order/tool identity, blockers.
- `corpus.ts` verify first, then parse the frozen corpus from the SAME cached bytes that are hashed (bound to the identity).
- `validate.ts` fixed-code (`ExecError`) validators: IDs, bounded decimals, safe integers, UTC instants, admission/counters/ledger.
- `transient.ts` accepted strict JSON + server request parser + browser V2 answer/error/capability validators, then the accepted
  comparator for the OBSERVED intent; local validation failures are LOCAL_HANDOFF_UNVERIFIED (unattributed), never server faults.
- `book.ts` liability floors (DAY per UTC day, MONTH never reset), reply-kind ↔ ledger consistency, totals. An answer with ANY
  unknown liability (missing/unbound/unreconciled/contradictory/explicit unknown) gets no pass/credit; proven failures stay FAILED (session.ts).
- `closure.ts` ONE run-wide closure floor (exact 4-key receipt, signed-64-bit, strictly newer), absorbing containment, history.
- `session.ts` `ExecutionSession`: wraps the accepted SIMULATED supervisor (unchanged) — integer-ms clock, window gates, GO/NO-GO
  submit, unrecorded click, abandon in flight, correlation reuse refusal, local stops, evidence per case.
- `receipt.ts` safe receipt v2 + exact allowlist schema + accepted offline scan; run lock; fsync + atomic write. `replay.ts` numeric replay (re-validates saved
  ledgers with validate.ts/book.ts rules; re-derives pass/scores/safety/threshold claims).
- `tty-input.ts` buffer-safe input collector (type-ahead remainder kept). `operator.ts` interactive TTY session: raw for the WHOLE
  session, prior mode restored only at exit; never toggles raw per prompt (UNADMITTED; injectable I/O for tests).
- `fake-v2.ts` + `rehearsal.ts` OFFLINE fake V2/ledger and scripted scenarios (SIMULATED; never imported by `operator.ts`).

Tests: `tests/ask-remote-eval-execution-{session,receipt,cli,repair,operator,pty,liability,replay}.test.ts` (pty = real pseudo-terminal via `script`). Any tool edit changes `executionToolSha256`:
regenerate `docs/stage5/ask/remote/execution/rehearsal/EXECUTION_REHEARSAL_RECEIPT.json` with `rehearse --write-receipt`.
