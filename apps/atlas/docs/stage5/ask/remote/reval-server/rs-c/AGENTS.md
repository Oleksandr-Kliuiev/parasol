# R-EVAL RS-C routing

RS-C is delivered in three parts, each with ONE independent native Opus 5.5 `max` review in a clean session (owner policy
2026-10-11): **A** server + controller (`IMPLEMENTATION_BRIEF.md`, `IMPLEMENTATION_REPORT.md`), **B** instrument revision,
**C** browser pane + 200-path E2E. Read the brief of the part you work on, then its report; architecture parent is
SERVER-DESIGN-rc4 (`../04_TRANSIENT_HANDOFF.md`, `../06_LOCAL_PROTOCOL.md`). Code routing: `packages/reval/AGENTS.md` (RS-C-A list).
Provider key pass-through into the bridge server is a PENDING owner decision (tentatively Azure environment variables): no
part may add it without that decision. No paid/provider call, activation, account, customer data or deployment.

Status:
- Part **A ACCEPTED rc2**: seal `verification/stage5/S5ASKREMOTE_REVAL_RSCA_APPROVED.json`; review
  `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCA_RC1.md` (with its rc2 section).
- Part **B ACCEPTED rc3**: instrument revision `scripts/reval-instrument/`; documents `IMPLEMENTATION_BRIEF_B.md`,
  `IMPLEMENTATION_REPORT_B.md` and `INSTRUMENT_RUNBOOK.md`; seal `verification/stage5/S5ASKREMOTE_REVAL_RSCB_APPROVED.json`; review
  `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCB_RC1.md` (with its rc2 and rc3 sections).
- Part **C ACCEPTED rc2**: `IMPLEMENTATION_BRIEF_C.md` and `IMPLEMENTATION_REPORT_C.md` cover the measured console
  (`apps/operator/measured/AGENTS.md`), the server fixes, the identity candidate layer, the 200-path E2E and NB7; seal
  `verification/stage5/S5ASKREMOTE_REVAL_RSCC_APPROVED.json`; review `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCC_RC1.md`.
- RS-D (census, DRAIN, fixture-grouped segments, proofs) continues in `../rs-d/AGENTS.md`; the instrument procedure stays in
  `INSTRUMENT_RUNBOOK.md`.

Items carried between parts are listed in the seals.
