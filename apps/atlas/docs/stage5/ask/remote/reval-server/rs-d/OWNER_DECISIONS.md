# R-EVAL server — owner decisions recorded for RS-D

These are the owner's direct decisions in the Claude Code session. They amend how the frozen SERVER-DESIGN-rc4 is applied. The
frozen architecture files are not edited. Under the project policy an architecture change goes to Astra + Fable `xhigh`; the owner
chose to proceed with one independent Opus 5.5 `max` review per part instead, and may still require the policy gates.

| Date | Decision | Effect |
|---|---|---|
| 2026-10-11 | Implement RS-C/RS-D with ONE independent native Opus 5.5 `max` reviewer per part (clean session; bounded re-reviews in that session) | Replaces the Sol 6.1 + Opus 5.5 `xhigh` checkpoint gate for these parts |
| 2026-10-11 | Provider keys: tentatively environment variables on Azure; NOT decided | Bridge-mode S never resolves a key; pass-through stays PENDING |
| 2026-10-12 | **D1** — one admitted run follows a reviewed **fixture-grouped order** (`FIXTURE_GROUPED_FIRST_APPEARANCE_V1`) | Overrides 03 "do not reorder cases to reduce switches"; 177 → 10 fixture switches; fixture is confounded with order position (reported residual) |
| 2026-10-12 | **D2** — **S and C stay up through a fixture switch**; the switch admits only their idle registered sessions after closure + DRAIN QUIESCENT | Replaces RS-B's "no other backend" substitute; 01/04/05 continuity rules (one S incarnation per run, loss stops the run) unchanged |

Rejected alternatives (2026-10-12): a planned S/C restart at each boundary (would amend 04 "loss of I/C/S state … stops that run" and
05 "exactly ONE API server incarnation" and need a new owner command); a run defined per fixture segment.
