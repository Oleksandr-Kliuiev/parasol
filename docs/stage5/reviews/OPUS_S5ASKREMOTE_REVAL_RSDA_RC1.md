# Independent checkpoint review — S5ASKREMOTE-REVAL-SERVER-RSD-A rc1 (RS-D part A: process census, DRAIN, fixture-grouped segments)

Date 2026-10-13. Reviewer: native Claude `claude-opus-5-5`, launched through the Claude Code Agent tool with a fresh context at the
requested effort `max` (the effort setting cannot be confirmed from inside the session). Gate: owner decision 2026-10-11/12, ONE
independent Opus 5.5 `max` review per RS-D part (recorded deviation from the Sol/Opus `xhigh` and Astra/Fable gates; not re-judged here).
Disclosure: this session's scratchpad path carries the host session id `d0382327-…`, which also holds implementer/orchestrator files
(I saw their names in a directory listing, e.g. `rsda-mutations.py`, `review-prompt-rsda.md`, `rsdb-notes.md`; I did not open them).
My own temporary files are under `scratchpad/opus-rsda/`. I had no implementer conversation and no other reviewer's verdict.

Verdict (rc1): CHANGES_REQUIRED

One Medium finding (a brief rule not met on the deferred-POST path) and three Low findings (one doc/carry deviation, one continuity
handling/doc mismatch, one D2 test gap). Everything else checked holds: exact 05/02 payloads, emitters, counters vs gauges, DRAIN
composition and states, one guard epoch, D2 switch safety, D1 order, receipt v4 allowlist, flags, identity chain.

## Identity (recomputed)

| Item | Result |
|---|---|
| Manifest `S5ASKREMOTE_REVAL_RSDA_RC1_MANIFEST.json` | sha256 `48edece0bf91a3f01814d4d189551106e0ac9a03071b36e9579ea00f4718c92b` — matches |
| Checks `S5ASKREMOTE_REVAL_RSDA_RC1_CHECKS.json` | sha256 `9ce6a64a1dd3ab77e71e1f94fb2729e1fd7f8250846d04f27f84340dc5ba4027` — matches; all 15 evidence log hashes match `logs` |
| **packageHash** (rule in manifest) | **`a6c7e206e48b59bb30c3808e84c65dcb90450ec61c572679f25ede595bd9b658`** recomputed from the manifest lines AND from disk; 55/55 file hashes match; re-verified unchanged at the end of the review |
| Completeness vs baseline (`git ls-files -co --exclude-standard`) | exactly the 40 changed + 15 added files (+ the excluded RSDA receipts); 0 removed |
| Evidence window | 22:48:32Z–23:18:15Z, after the last source edit (`receipt.ts` 22:48:26Z); only the report/manifest/checks were written later |
| `cli.ts artifact-check` (my run) | ok, drift [], identity digests identical to the evidence; candidate RS-D-A `a78b2b8edf00858466f777144221ae8cbb61f180682f77a82af33656d8c8d461`, accepted:false |

## Findings (required)

**F1 — Medium — a deferred POST census never makes EXTRA activity RC5's duplicate-dispatch integrity failure.**
`scripts/reval-instrument/run.ts:175-185` (`#collectPrevious`) and `:208-225` (`#postCensus`) vs `:400` (only `finish` calls
`session.unrecordedClick`). Scenario: case k's record is not FINAL within `finish`'s 40×250 ms poll (slow release/settlement), so its POST
census is deferred to GO k+1; during case k an extra submission/reservation/dispatch happened. The deferred `compareCase` returns
`EXTRA_ACTIVITY`, the code only stops arming; RC5 integrity stays empty and the run ends TERMINAL_INCOMPLETE — never the TERMINAL_FAILED
integrity failure that brief §6 ("An EXTRA … is RC5's duplicate-dispatch integrity failure"), the report and `INSTRUMENT_RUNBOOK.md:32-33`
promise. Probe (scratch copy of the `tests/reval-instrument-run.test.ts` rig; first case `{final:false}`, `censusExtra.submitIngressCount=1`,
then GO): deferred verdict `EXTRA_ACTIVITY/SUBMIT`, armStop `CENSUS_CHANGED_UNEXPECTEDLY`, RC5 integrity `[]`, base `TERMINAL_INCOMPLETE`,
effective `TERMINAL_INCOMPLETE` (reason null). Control (same extra in an immediate POST): `INTEGRITY_DUPLICATE_SUBMISSION`,
`TERMINAL_FAILED`. The same safety event is classified differently by timing. **Fix:** after a deferred `#postCensus` with verdict
`EXTRA_ACTIVITY`, call `session.unrecordedClick(p.caseId)` (RC5 `#duplicate()` accepts any consumed case) before persisting — or make
EXTRA FAILED in one place for both paths — and add a detecting test for the deferred path.

**F2 — Low — DRAIN `QUIESCENT` is emitted without any process inventory; the deviation from frozen 02 is not stated as such.**
`packages/reval/eval-drain.ts:58-69`; brief §4/§8; `docs/RUNBOOK.md:727-728`. 02 "Pause is not drain": "A dead/unreachable process,
unacknowledged commit or incomplete process inventory is UNKNOWN, never zero"; 06: DRAIN's "DB/platform coverage [comes] from the
controller's independent adapters". Part A composes S's self-census + C's DB snapshot only and reports `QUIESCENT`; receipts v4 record
these drains as `QUIESCENT`. Brief §8 says only "DRAIN combines them with C's independent DB snapshot only. Platform … is part B"; the
report's carried list says "platform/privacy proofs" without the DRAIN consequence. Scenario: a later reader (or part B, if it only adds
the PLATFORM_PROOF/PRIVACY_PROOF adapters) treats a Part-A `QUIESCENT` as the 02 state. **Fix (docs):** state explicitly in the brief,
report, RUNBOOK and INSTRUMENT_RUNBOOK that a Part-A `QUIESCENT` means "S census + DB snapshot only", and carry an explicit item to part B:
DRAIN must be `UNKNOWN` unless C's platform adapter proves the complete process inventory (and RS-D-A drains are not 02-QUIESCENT evidence).

**F3 — Low — in the real chain continuity loss is a retryable `BLOCKED_*`; the documented `CENSUS_CONTINUITY_LOST` stop is unreachable.**
`packages/reval/eval-drain.ts:41` (C answers another epoch with FAILURE `IDENTITY_UNVERIFIED`, never forwards it), `server-link.ts:26/52`
(S death → LOST, no relaunch → FAILURE `IPC_LOST`); `run.ts:244` returns `BLOCKED_PRE_CENSUS_FAILURE_*` (and `:180-181`
`BLOCKED_PREVIOUS_CENSUS_FAILURE_*`) with no stop and nothing persisted; the I-side stop at `run.ts:247` is reachable only with the test's
fake C that forwards a new epoch (`tests/reval-instrument-run.test.ts:75-88, 357`). Probe (rig, C answering `IDENTITY_UNVERIFIED`): every GO
`BLOCKED_PRE_CENSUS_FAILURE_IDENTITY_UNVERIFIED`, armStop null, receipt `ACTIVE`/effective unchanged. 04: "Loss of I/C/S state, channel
continuity or process identity stops that run"; `INSTRUMENT_RUNBOOK.md:22` tells the operator to expect `BLOCKED_ARM_STOPPED_CENSUS_*`.
Nothing is consumed (safe), but the receipt never records the loss. **Fix:** map a PROCESS_CENSUS FAILURE `IDENTITY_UNVERIFIED` (C's epoch
rule) and C's S-link `IPC_LOST` to a persisted `CENSUS_CONTINUITY_LOST` stop, tested with C's real CensusLink semantics; or at minimum
correct the runbook/brief to the actual behaviour.

**F4 — Low — D2: the role half of C's admission clause has no detecting test.** `packages/reval/inventory.ts:95`;
`tests/pg/reval-census.pg.test.ts:58-87`. Mutation `(a.usename = $4 AND a.application_name = $5)` →
`($4::text IS NOT NULL AND a.application_name = $5)` SURVIVED (2/2 pass): any role (the writer-capable runtime role, the owner, a foreign
login) named `atlas-reval-c-reader` would be admitted as an idle "C" with no failing test. (The S half and C's name check are covered:
the "reader role under S's name" case detects the name mutation.) **Fix:** add negative cases — a runtime-role session and an unregistered
role session named `atlas-reval-c-reader` must give `ANOTHER_WRITER`.

## Notes (non-blocking)

- **N1** Brief §6 lists "Δsubmit = 1; ΔrejectedUnpaired = 0"; `census.ts` implements a stricter-but-different fate model (NONE: Δsubmit 0;
  REJECTED: ΔrejectedUnpaired 1 → MATCH). Both are safe (an unclaimed arm still stops as ARM_EXPIRED_UNUSED); align the brief text.
- **N2** Between cases only S's census is compared (`compareGap`); the DB attempt count is compared only PRE→POST of a case. A zero-charge
  attempt created by a non-S process between POST(k) and PRE(k+1) is visible only to part B and to a DRAIN while still unsettled. Suggest
  `projectAttemptCount(PRE k+1) == projectAttemptCount(last POST)`.
- **N3** `compareCase` has no generic per-counter monotonicity check (`compareGap` has one): e.g. Δconsumed = Δtransport = −1 passes.
- **N4** The boundary DRAIN is bound to the closure by `policyVersion` only; the D2 order "DRAIN QUIESCENT → switch" is procedural. Also
  requiring `drain.fenceEpoch == closure.fenceEpoch` would reject a DRAIN taken after a fence-advancing switch. Not a safety gap today:
  hidden submits during the boundary still fail the gap rule.
- **N5** Transport attribution to "the current CLAIMED arm" (`eval-census.ts:54-56`) holds only while nothing else can dispatch (no-key
  bridge, single-client sandbox, DB cross-check). Mutation E (attribute to any arm state) SURVIVED; revisit with the key pass-through.
- **N6** Untested details: DRAIN order census₁ → snapshot → census₂ (only the call count is asserted); `handoffIngress` for a foreign
  path/method; the xid/xmin clause (mutation C SURVIVED — redundant with `pg_locks`, so the "visible to a non-privileged role" probe is not
  evidenced by a test); a registered S write during the switch (the fingerprint-refusal claim of brief §5); receipt v4 does not
  cross-check a `census` verdict against the presence of `preCensus/postCensus`.
- **N7** Docs: RUNBOOK RS-D-A "всех попытках БД в переписи" — only unsettled (`EGRESS_COMMITTED`) attempts must map; `eval-controller.ts:20`
  still says "POST census (RS-D, pending)"; `docs/RUNBOOK.md` is 737 lines (doc, outside the 700-line test; consider splitting R-EVAL out).
- **N8** On the O path S-detected census failures arrive as CONTROLLER-emitted FAILUREs (same pattern as the accepted TERMINAL_OBSERVATION
  path); the I path keeps SERVER. Acceptable; noted for 06 "FAILURE identifies the principal that detected".

## What I checked and how

- Read the brief, owner decisions, report, operator procedures, frozen 02 (census/zero attempts, closure, pause-is-not-drain), 03 switch
  procedure, 04 first-current-GO, 05 census/checkpoints/acceptance, 06 roles/commands/emitters; all RS-D-A code paths (census-payloads,
  eval-census, eval-drain, gate/handoff-route/runtime/bridge/controller/owner-cli deltas, main.ts/ask-http/evaluation, inventory/materialize/
  maintain-cli, instrument order/census/run/receipt/identity/candidate/ipc/operator/terminal) and the new/changed tests.
- Contract checks: PROCESS_CENSUS 18 keys, task item 9 keys, gauges 0..4, relationships; DRAIN 11 keys and QUIESCENT relationships; emitters
  (S census → SERVER on O and I paths, DRAIN → CONTROLLER); counters vs gauges (gauges never used as deltas); DRAIN one operation, no
  wait/poll, no lock across the transport; sticky first epoch. R-B `dispatch.ts` consumes synchronously before `seams.transport` (entry ⇔
  consumption holds); AskBudget release → onRelease is synchronous (no census interleaving); globalOwners = 4; ≤1 observer record (new arm
  needs prior collected), so ≤5 task items; bridge seams still never resolve a key (`main.ts:47`).
- D2: lock order fence → policy → binding → idle check → source rows; PAUSED + no EGRESS_COMMITTED under FOR UPDATE; any transaction holds a
  vxid lock (pg_locks); RS-B `register` unchanged; V, E, owner and foreign sessions refused; concurrent registered writes after the check
  are caught by the READ COMMITTED fingerprint/keys re-check, the post-check or FIXTURE_CHECK.
- Runs: focused unit (`reval-census`, `reval-instrument-census`, `reval-instrument-run`, `reval-eval-gate`, `reval-eval-controller`,
  `reval-protocol`, `reval-instrument-identity`) 42/42; `tests/pg/reval-census.pg.test.ts` 2/2; process E2E `tests/pg/reval-segments.pg.test.ts`
  1/1 (185 s, same REVAL_EVIDENCE line: 13 FX07 + 2 FX05, ONE epoch, both refusals, DRAIN QUIESCENT, switch with S/C up); context budget ✔.
  The 8 unit failures in `unit.txt` are the same 8 RC5 files as in the RS-C-C rc2 evidence. Full `test:pg`/`test:ui` taken from evidence.
- Identity overlay probe through `verifyRevision`'s Reader seam (no repository write): 7 chain files outside the candidate list
  (`eval-state.ts`, `budget.ts`, `dispatch.ts`, `eval-wire.ts`, RC5 `session.ts`, `register.ts`, `payloads.ts`) → SOURCE_DRIFT; candidate files →
  recorded (tool digest changes, no drift); missing candidate → CANDIDATE_MISSING; seal with a wrong digest → CANDIDATE_SEAL_MISMATCH, right
  digest → accepted:true. All 40 changed files are chain-pinned and listed in `CANDIDATE_PATHS`; only the brief/report/owner-decision docs
  are outside it.
- D1 recomputed independently: frozen order 177 switches → grouped 10, groups FX07,FX05,FX10,FX02,FX03,FX09,FX11,FX04,FX01,FX08,FX06, digest
  `0c8878f7…` = pinned, frozen digest `9deaa3c5…` = identity `orderSha256`, exact permutation of 200; session and run share the grouped corpus.
- Mutations (single line, original bytes restored and sha256-verified each time; server modules reach PG/E2E only via `dist/`, which I did
  not rebuild): A `compareCase` consumed≠transport clause → DETECTED; C idle xid/xmin clause → SURVIVED (N6); D C-clause role check →
  SURVIVED (F4); D′ C-clause name check → DETECTED; E transport attributed to any arm state → SURVIVED (N5); F decoder COMPLETE owner
  reconciliation → DETECTED. Probes: F1, F3; a missing last POST census leaves the base already TERMINAL_INCOMPLETE (no finding).

## Residuals I accept

S self-measurement inside its trust boundary and the same-credential `application_name` limit; `pendingCommitCount` as an owner-release
upper bound; D1's fixture/order confound (stated in brief, report and owner decisions); the deferred-POST capability/handoff relaxation;
platform/egress/privacy proofs in part B (with F2's explicit carry); key pass-through PENDING (bridge S never resolves a key); the
one-reviewer gate per the owner's decision; carried items build-inventory seal, swept-vs-expired, F_FULLFSYNC, T2, buildManifestSha256.

## rc2 — bounded re-review (same reviewer session, 2026-10-13)

Verdict (rc2): APPROVE_RS_D_A

All four required rc1 findings are closed and the delta introduces no new required finding. Three non-blocking notes remain.

### Identity (recomputed)

| Item | Result |
|---|---|
| Manifest `S5ASKREMOTE_REVAL_RSDA_RC2_MANIFEST.json` | sha256 `38361d6bb4e78c917e75c555772e56f65310903a42efbbea4539c1e73fec2fbf` — matches |
| Checks `S5ASKREMOTE_REVAL_RSDA_RC2_CHECKS.json` | sha256 `a1737d3a6e310538a5c6f81f0dbce289bbd1484e8a46f6b8b9ab2f0e9c702e54` — matches; all 15 log hashes match |
| **packageHash** | **`79d2556b72fb63c5a53b84264a582ed8b7177c7acc61c5b4a0d9e11143011951`** recomputed from the manifest lines AND from disk; 56/56 file hashes match; re-verified unchanged at the end |
| Completeness vs baseline | 40 changed (same list as rc1) + 16 added (new: `rs-d/REVAL_RUNBOOK.md`), 0 removed |
| rc1 → rc2 delta | 15 files: `run.ts`, `census.ts`, `receipt.ts`, an `eval-controller.ts` comment, tests and docs. No server-behaviour code changed |
| Evidence window | 00:14:54Z–00:44:31Z, after the last edit (02:14:49 local) |
| `artifact-check` (my run) | ok, drift [], candidate RS-D-A `bc2d287f09d8a7ffef47b10f09816a4238d4fda9bb2216b2c7667c7e2ae225ac` (= evidence); the dist output carries the new comment |

### rc1 findings

| rc1 | Status | Verification |
|---|---|---|
| F1 | **closed** | `run.ts` `#collectPrevious` calls `unrecordedClick` on a deferred EXTRA_ACTIVITY and persists. My rc1 probe, re-run: RC5 integrity `DUPLICATE_SUBMISSION`, base and effective `TERMINAL_FAILED`, the same as the immediate path. My mutation R2 (removing that line) is DETECTED by the new run test |
| F2 | **closed** | The deviation is now declared, with an explicit carry to part B: brief §4 and §8, the "Ограничение части A" paragraph of `rs-d/REVAL_RUNBOOK.md` RS-D-A, and `INSTRUMENT_RUNBOOK` step 8.4 |
| F3 | **closed** | `CONTINUITY_LOST` = {FAILURE `IDENTITY_UNVERIFIED`, FAILURE `IPC_LOST`} becomes a persisted `CENSUS_CONTINUITY_LOST` stop on the PRE census, the deferred POST and the immediate POST; other read failures stay retryable. **No false stop:** for PROCESS_CENSUS, C answers `IPC_LOST` only when S's link is not READY or a C→S exchange failed, and a failed exchange kills S (`server-link.ts:111, 119-121`); S is never relaunched and must be READY before any GO, because pairing needs it. **Probes:** C's `IDENTITY_UNVERIFIED` gives `BLOCKED_ARM_STOPPED_CENSUS_CONTINUITY_LOST`, recorded, effective INCOMPLETE/CENSUS_UNVERIFIED; `IPC_LOST` at the last case's `finish` records the stop. `INSTRUMENT_RUNBOOK` step 5 now matches |
| F4 | **closed** | New PG negatives: the runtime role and an unregistered (owner) role under C's name, and the owner under S's name. My rc1 mutation D (dropping the role check in C's clause) is now DETECTED |
| N1–N8 | closed or stated | N1 brief §6 matches the implemented fate model. N2: the PRE `projectAttemptCount` must equal the last POST's (my mutation R4 DETECTED). N3: the DECREASE rule in `compareCase` and `compareGap`. N4: the closure's fenceEpoch is bound into drain entries, the boundary rule and receipt v4 (my mutation R3 DETECTED; the real-chain segment E2E still crosses the boundary, so the closure and snapshot fence agree). N6: DRAIN order asserted, handoff counting for another method/client path tested in PG, receipt verdict needs both records and MATCH needs one epoch. N7: wording fixed, stale comment fixed, R-EVAL sections moved (`docs/RUNBOOK.md` 614 lines). N5, N8 and the xid/xmin and S-write-during-switch items are stated as residuals in brief §8 |

### New notes (non-blocking)

- **rc2-N1** — The immediate-POST continuity mapping (`run.ts` `finish`, `if (failed !== null) this.#continuity(failed)`) has no detecting test. My mutation R1 (`void failed`) SURVIVED, 11/11 pass. My probe shows the behaviour is correct, and the next GO would stop through the deferred retry anyway; only a last case depends on this line. Add a test.
- **rc2-N2** — `rs-d/REVAL_RUNBOOK.md` now holds the moved, accepted RS-A…RS-C operator procedures. It is outside `CANDIDATE_PATHS` and outside the chain until the next part pins the RS-D-A manifest. The text itself is no longer drift-checked (RUNBOOK.md was), so consider listing it. I had no rc1 copy to byte-diff the move; 10 rc1 fragments I had read are present verbatim, and the pointer section and routing are updated.
- **rc2-N3** — Brief §6 "Receipt v4" does not mention the per-drain `closurePolicyVersion` and `closureFenceEpoch`; `INSTRUMENT_RUNBOOK` step 9 does.

### What I ran (rc2)

- **Unit:** 8 focused files, 44/44 pass (including context budget).
- **PG:** `tests/pg/reval-census.pg.test.ts` 2/2.
- **Process E2E:** `tests/pg/reval-segments.pg.test.ts` 1/1 in 185 s, with the same REVAL_EVIDENCE line.
- **Mutations:** single-line, each restored and sha256-verified, none during another test. R1 SURVIVED; R2, R3, R4 and D DETECTED.
- **Probes:** the rc1 F1 and F3 probes, re-run against the rc2 code.
- **Not re-run:** full `test:pg` and `test:ui`; I took them from the rc2 evidence: 778/778, and 90 passed including the 200-path E2E.

### Residuals accepted (rc2)

The rc1 list, plus the brief §8 rc2 entries:
- a Part-A DRAIN is not 02-QUIESCENT evidence (carried to part B);
- transport is attributed to the one CLAIMED arm, to be revisited with the key pass-through;
- the redundant xid/xmin clause;
- an S write during the switch relies on the accepted RS-B fingerprint re-check;
- on the O path an S-detected FAILURE is relabelled CONTROLLER.
