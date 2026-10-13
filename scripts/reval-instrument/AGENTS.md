# R-EVAL instrument revision (RS-C-B, extended by RS-D-A … RS-D-C) routing

Brief: `docs/stage5/ask/remote/reval-server/rs-c/IMPLEMENTATION_BRIEF_B.md`. UNADMITTED, local only; no live/paid path, key or
network beyond the owner's two measured unix sockets. The accepted RC5 instrument (`scripts/ask-remote-eval-execution/**`) and the
offline RC3 package are IMPORTED unchanged; never edit them from here.
- `identity.ts` chained accepted-manifest identity (RC5-compatible Snapshot + revision record); RS-D-A pins the RS-C-C manifest/seal and
  records the enumerated candidate layer of `candidate.ts` (digest in the identity; equal to the RS-D-A seal's once it exists).
- RS-D-A: `order.ts` fixture-grouped order (D1, pinned digest, bound to the run); `census.ts` PRE/POST/gap census verdicts and the
  segment-boundary rule; `run.ts` takes the censuses, `drain`, the boundary gate; `receipt.ts` v4.
- RS-D-B: `identity.ts` pins the RS-D-A manifest/seal; candidate layer `RS-D-B`; `run.ts` `takeProofs` (`proofs` command);
  `receipt.ts` v5 = v4 + `proofs` (exact 05 payloads, decoded again on write).
- RS-D-C (final revision): `identity.ts` pins RS-D-B and the sealed build inventory (`build-inventory.ts --write|--check` after
  `npm run api:build`); candidate layer `RS-D-C`; `run.ts` binds the run once to C's IDENTITY build, stops on
  `TERMINAL_EXPIRED_UNCOLLECTED`, refuses a GO near the pair's guaranteed end, bound from the owner's PAIR_ACK (`pair-ack`,
  `BLOCKED_PAIR_REFRESH_REQUIRED`); `receipt.ts` v6 (+ `build`,
  `durableWrite` — F_FULLFSYNC measured by `tests/reval-fsync.test.ts`).
- `ipc.ts` control (principal I → C) and handoff (S↔I) clients. `ledger.ts` counters/ledger from C snapshots.
- `transfer.ts` 06 I side (TRANSFER checks, SafeResult, PENDING/COMMITTED/UNVERIFIED summaries, ACK/COMMIT). `terminal.ts` I-side record checks + credit blocks.
- `run.ts` GO procedure + case finish on the unchanged RC5 ExecutionSession. `receipt.ts` v4 (base = exact RC5 v2).
- `net-guard.ts` fail-closed guard; only the owner's two unix sockets, named once. `operator.ts` + `cli.ts` TTY session.
Tests: `tests/reval-instrument-*.test.ts`, `tests/pg/reval-instrument-e2e.pg.test.ts`, `tests/pg/reval-native-instrument.pg.test.ts`,
`tests/pg/reval-segments.pg.test.ts`; operator procedure `rs-c/INSTRUMENT_RUNBOOK.md`.
