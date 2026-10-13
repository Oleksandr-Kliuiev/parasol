# R-EVAL server RS-D routing

RS-D completes the R-EVAL server preparation (05 row RS-D) in three parts, each with ONE independent Opus 5.5 `max` review:
A = process census, DRAIN, fixture-grouped segments (`IMPLEMENTATION_BRIEF_A.md`, sealed); B = platform/egress/privacy proof adapters (sealed);
C = integration, final instrument revision and the offline rehearsal/runbook. Owner decisions: `OWNER_DECISIONS.md`.

- S census: `packages/reval/eval-census.ts`; payload schemas `packages/reval/census-payloads.ts`; C DRAIN `packages/reval/eval-drain.ts`.
- Switch with S/C up: `packages/reval/inventory.ts` (`checkRegisteredIdle`), `materialize.ts`.
- B (`IMPLEMENTATION_BRIEF_B.md`): S's Seatbelt profile and helper check `packages/reval/platform.ts` (+ `native/reval-peer/peer.c`
  `sandbox` mode, `server-link.ts`), DRAIN inventory `eval-drain.ts`, proofs `proof-payloads.ts`, `privacy-scan.ts`, `eval-proofs.ts`.
- C (`IMPLEMENTATION_BRIEF_C.md`): final instrument revision + sealed build inventory `scripts/reval-instrument/{identity,build-inventory}.ts`
  (`verification/stage5/S5ASKREMOTE_REVAL_RSD_BUILD_INVENTORY.json`), receipt v6 / pair refresh / expired-uncollected in `run.ts`,
  `receipt.ts`; integrated rehearsal `tests/pg/reval-rehearsal.pg.test.ts` (`ATLAS_REVAL_REHEARSAL=1`) with `tests/support/reval-segment-{entry,harness}.ts`;
  end-to-end operator procedure `REVAL_RUNBOOK.md` §RS-D-C.
- Instrument: `scripts/reval-instrument/{order,census,run,receipt}.ts`; operator procedure `../rs-c/INSTRUMENT_RUNBOOK.md`; owner/server
  procedures RS-A … RS-D `REVAL_RUNBOOK.md` (moved out of `docs/RUNBOOK.md`).
No paid/provider call, activation, account, customer data or deployment; key pass-through PENDING. Do not edit the frozen 01–06.
