# RS-D implementation brief — part A (process census, DRAIN, fixture-grouped segments), rc2 (S5ASKREMOTE-REVAL-SERVER-RSD-A)

Status: written by the implementer (native `claude-opus-5-5`, Claude Code session) on 2026-10-12. This brief is NOT an approval.

Gate (the owner's direct instruction of 2026-10-11, kept for RS-D on 2026-10-12): ONE independent native Opus 5.5 `max` review in a
clean session per part, with bounded re-reviews in that session. The project policy asks for Sol 6.1 + Opus 5.5 `xhigh` acceptance
and, for architecture changes, Astra + Fable `xhigh`; the owner may still require those gates. This brief records the deviation.

Parts: **A** (this brief) process census, DRAIN, owner decisions D1/D2 (grouped order, S and C stay through a fixture switch);
**B** platform/egress/privacy proof adapters; **C** integration: final instrument revision, build inventory seal, carried items,
the full offline rehearsal and the runbook.

Out of bounds for every part: any paid or provider call, activation, account, customer data or deployment; the provider key
pass-through (PENDING owner decision, so bridge-mode S still never resolves a key).

## 0. Identity and parents
- **Architecture.** SERVER-DESIGN-rc4: 05 "Independent process/ingress census" (exact PROCESS_CENSUS); 02 "Correlation, census and
  zero attempts", "Pause is not drain" (exact DRAIN); 06 rows PROCESS_CENSUS / DRAIN and emitter rules; 03 "Transaction and switch
  procedure"; 04 "First-current-GO bookkeeping"; 05 acceptance rows Census, Closure, Integration.
- **Parents.** RS-A rc3, RS-B rc2, RS-C-A rc2, RS-C-B rc3, RS-C-C rc2 (seal `S5ASKREMOTE_REVAL_RSCC_APPROVED.json`, `carriedToRSD`).
- **Baseline.** `verification/stage5/S5ASKREMOTE_REVAL_RSDA_BASELINE.sha256` (`git ls-files -co --exclude-standard`, sorted, taken
  after the RS-C-C seal and before any RS-D edit).

## 1. Owner decisions (2026-10-12) and their exact effect
- **D1 — fixture-grouped order.** The owner chose a reviewed fixture-grouped order over the frozen randomized order. Rule
  `FIXTURE_GROUPED_FIRST_APPEARANCE_V1`: the frozen 200 IDs are grouped by fixture; groups follow the order of each fixture's first
  appearance in the frozen order (FX07, FX05, FX10, FX02, FX03, FX09, FX11, FX04, FX01, FX08, FX06); inside a group the frozen
  relative order is kept. No new randomness or choice. Fixture switches drop from 177 to 10. It deliberately overrides 03 "do not
  reorder cases to reduce switches". **Residual (evaluation validity):** fixture is now confounded with time/order position (operator
  learning, provider drift, day boundaries); reports must say so. The frozen order and its digest stay the dataset identity; the
  executed order is recorded separately (§6).
- **D2 — S and C stay through a switch.** One S incarnation and one C process serve the whole admitted run; continuity rules in 01/04/05
  stay unchanged. RS-B's switch refused ANY other backend ("RS-B's drain substitute until RS-D DRAIN", `inventory.ts`). It now admits
  exactly the registered idle sessions: §5. The owner procedure at a boundary is pause → closure → END_PAIR → DRAIN QUIESCENT →
  switch → FIXTURE_CHECK → manual resume → PAIR (03 steps 1–5).
- Both decisions are recorded here and in `rs-d/OWNER_DECISIONS.md`. The frozen architecture files are NOT edited.

## 2. Scope
IN: (1) S guard census and PROCESS_CENSUS (C→S, O→C, I→C); (2) DRAIN composed by C (O→C, I→C); (3) O prints both; (4) RS-B
switch delta D2; (5) instrument: identity revision (pins RS-C-C, records the RS-D-A candidate layer), grouped order D1, PRE/POST
census per case, `drain` command, segment-boundary gate, receipt v4; (6) carried fix: `rs-c/AGENTS.md` status line.
OUT: platform/privacy proofs (part B); build inventory seal, swept-vs-expired distinction, F_FULLFSYNC, T2, buildManifestSha256 binding
(part C). PLATFORM_PROOF / PRIVACY_PROOF stay fail-closed.

## 3. S guard census (`packages/reval/eval-census.ts`)
Memory-only, per S process; `guardEpoch` = the runtime's random UUID (already bound into every Binding). Exact 05 payload
`{censusId,guardEpoch,capabilityIngressCount,submitIngressCount,handoffIngressCount,rejectedUnpairedCount,unattributedCount,
reservationConfirmedCount,commitUnknownCount,capabilityConsumedCount,transportEntryCount,publicationCount,physicalReleaseCount,
uncollectedTerminalCount,activeTaskCount,pendingCommitCount,coverage,tasks}`; counters are Dec64 strings; events advance BEFORE
work is handed on. No body, path, header, bearer, question, intent or source fact is stored.

| Field | Source (all in the bridge composition; ordinary processes unchanged) |
|---|---|
| capabilityIngressCount | gate entry of every Ask capability request (any client) |
| submitIngressCount | gate entry of every Ask question POST (any client), before any check |
| handoffIngressCount | entry of the handoff route for its exact path (any method), before any check |
| rejectedUnpairedCount | the existing gate rejections of the registered client (no/invalid/unclaimable token, header problems) |
| unattributedCount | a gate-passed submit that never reaches a registered Binding: an unregistered-client submit, or a claimed task that ends without a Binding (pre-auth failure, scope denial, ASK_BUSY) |
| reservationConfirmedCount / commitUnknownCount | registered task reservation hook COMMITTED / COMMIT_UNKNOWN (reserve commit only; a settlement's unknown outcome is the attempt's DB state) |
| capabilityConsumedCount = transportEntryCount | the census-wrapped provider transport seam: R-B consumes the capability synchronously right before calling it (`dispatch.ts`), so entry ⇔ consumption. Bridge seams never resolve a key, so both stay 0 |
| publicationCount | a gate-passed submit whose HTTP response emits `finish` (complete write); gate rejections are not publications |
| physicalReleaseCount / activeTaskCount | the process's AskBudget `releases` / `active` (all physical owners, every route) |
| uncollectedTerminalCount | the observer's sticky counter |
| pendingCommitCount | registered tasks with a Binding whose physical owner is not yet released — an upper bound of physically pending reserve/settlement/publication commits (an owner releases only after every held DB/transport promise settled) |
| tasks | one item per observer record (registered task) plus one anonymous item (`correlationId:null`, all-false, `UNAVAILABLE`) per active owner without a record; ≤4 owners + 1 retained record |

Task item: reservation from the record; capabilityConsumed/transportEntered from the seam attributed to the current CLAIMED arm;
`noDispatchProof` is `ORIGINAL_PRIVATE_PROOF` only for reservation COMMITTED + capability never consumed + settlement CONFIRMED
(the accepted R-B settlement of a never-consumed capability is the in-process NO_DISPATCH proof); `publication` ANSWER/ERROR only for
SERVER_FINISHED. coverage is `UNKNOWN` when an observer coverage failure or uncollected record exists, a seam entry had no claimed
arm, or the anonymous-item count would be negative; otherwise `COMPLETE`. S answers C→S PROCESS_CENSUS through the bridge.

## 4. C: PROCESS_CENSUS and DRAIN (`packages/reval/eval-drain.ts`)
- PROCESS_CENSUS (O→C, I→C): forwarded to S, schema-checked; emitter SERVER. C records the first `guardEpoch` it sees; a different
  epoch later is a protocol failure (`IDENTITY_UNVERIFIED`) and makes every later DRAIN `continuity:LOST`.
- DRAIN (O→C, I→C), CONTROLLER composition inside ONE 1800 ms operation: census₁ → atomic DB SNAPSHOT (confined reader) → census₂.
  `snapshotId/policyVersion/fenceEpoch` from the snapshot; `registeredProcessCount` 1; `reachableProcessCount` 1 iff both censuses
  were valid; `pendingTaskCount = physicalOwnerCount = census₂.activeTaskCount`; `pendingCommitCount = census₂.pendingCommitCount`;
  `unmappedAttemptCount` = EGRESS_COMMITTED attempts whose correlationId is not a census₂ task; `continuity` INTACT iff both epochs
  equal C's recorded epoch.
- state: `UNKNOWN` if not reachable, either coverage UNKNOWN, continuity LOST, or the snapshot is inconsistent/foreign; else
  `PENDING` if any event counter differs between the censuses, any gauge or unmapped count is non-zero; else `QUIESCENT`. DRAIN never
  waits or polls; a failed read is a FAILURE code, not a state.
- **Declared deviation (rc2, review F2).** 02 requires a complete process inventory for QUIESCENT ("incomplete process inventory is
  UNKNOWN, never zero"; 06: DB/platform coverage from C's independent adapters). Part A has no platform process inventory: a Part-A
  `QUIESCENT` means only "S census + C's DB snapshot" and is NOT 02-QUIESCENT evidence. Carried to part B as a requirement: DRAIN must be
  `UNKNOWN` unless C's platform adapter proves the complete inventory.

## 5. RS-B delta (D2): the switch admits the registered idle sessions
`checkNoOtherBackend` keeps its exact predicate for `register`. `install` uses `checkRegisteredIdle(c, ownPids, roles)`: every other
backend of this database (autovacuum excluded as before) must be `(usename = config runtime role AND application_name =
atlas-reval-s-runtime) OR (usename = config reader role AND application_name = atlas-reval-c-reader)` AND idle: no `pg_locks` row
(any transaction holds its virtualxid lock), `backend_xid` and `backend_xmin` NULL. These columns are visible to a non-privileged
role (probed on PG17). Anything else is `ANOTHER_WRITER`. The fence/policy/binding locks, PAUSED policy, no EGRESS_COMMITTED
attempt, the exact inventory and the before/after preserved fingerprint stay as accepted; a registered session that starts a
transaction afterwards can only read (policy is PAUSED under the switch's FOR UPDATE) or makes the fingerprint check refuse.

## 6. Instrument revision
- **Identity.** Pins the RS-C-C rc2 manifest + seal (status `ACCEPTED_RS_C_C_RC2`); candidate layer `RS-D-A` (`candidate.ts`) lists
  every chain-pinned path RS-D-A changes plus its added code; seal `S5ASKREMOTE_REVAL_RSDA_APPROVED.json`.
- **Order (D1).** `order.ts` derives the grouped order from the bound frozen corpus and refuses unless its digest equals the pinned
  `GROUPED_ORDER_SHA256`; the RC5 ExecutionSession gets that order (the RC5 Supervisor accepts any exact permutation).
- **PRE census** at GO before the PRE SNAPSHOT (nothing consumed on failure): coverage COMPLETE, gauges 0, epoch = the run's first.
  An epoch change — and (rc2, review F3) C's real continuity-loss answers FAILURE `IDENTITY_UNVERIFIED` (its sticky epoch rule) and
  FAILURE `IPC_LOST` (S unreachable; C never relaunches S) on any census read — is a persisted stop `CENSUS_CONTINUITY_LOST`; other
  census read failures stay retryable blocks. rc2 (review N2): the PRE snapshot's projectAttemptCount must equal the last POST's.
- **POST census** in `finish` after the FINAL record and POST ledger, before the RC5 outcome (deferred to the next GO when the record is
  not yet FINAL); polls (bounded) until gauges are 0. With Δ = POST − PRE (`census.ts compareCase`, rc2 text aligned with the code —
  review N1): same epoch, COMPLETE, no counter decreases; the case's ONE submission has exactly one fate — NONE (Δsubmit 0, everything
  else 0), REJECTED at the gate (ΔrejectedUnpaired 1), UNATTRIBUTED (claimed, no Binding: Δunattributed 1) or BOUND (a terminal
  record); Δcapability = 0 (a deferred POST allows the operator's preflight and its owners); Δhandoff ≤ 1; the reservation deltas equal
  the record's reservation; Δconsumed = Δtransport ≤ ΔreservationConfirmed; Δpublication and ΔphysicalRelease ≤ 1 for a submission that
  passed the gate, 0 otherwise; Δuncollected = 0; DB projectAttemptCount delta ∈ [ΔreservationConfirmed, Δreserved]. An EXTRA
  submit/reservation/dispatch (Δ > 1) is RC5's duplicate-dispatch integrity failure (`unrecordedClick` of the consumed case) on the
  immediate AND the deferred path (rc2, review F1); any other mismatch stops arming (`CENSUS_CHANGED_UNEXPECTEDLY`) and blocks the case's
  credit (`CENSUS_UNVERIFIED`).
- **Segment boundary.** When the next case's fixture differs from the previous finished case's, GO needs: an RC5 voluntary pause whose
  closure was CONFIRMED after that case, and a DRAIN taken while that closure stands that is QUIESCENT, INTACT and names the closure's
  policyVersion AND fenceEpoch (rc2, review N4: a DRAIN after a fence-advancing switch or a resume does not count). Otherwise
  `BLOCKED_SEGMENT_*` (nothing consumed). Commands: `drain`, `census`.
- **Receipt v4.** v3 plus per-case `preCensus`/`postCensus` (exact payloads without `tasks`) and `census` verdict, run-level `order`
  `{rule, sha256, frozenOrderSha256}` and `drains` (exact DRAIN payloads with the case after which they were taken). Same allowlist
  discipline, validated before every write; flags never upgraded.

## 7. Required checks
Unit/PGlite (`npm test`), typecheck, API/operator build, `test:pg` on Docker PG17, `test:ui`, context budget. New proofs:
- unit: census counters/gauges/tasks/coverage; DRAIN composition (QUIESCENT/PENDING/UNKNOWN, epoch change, unmapped); grouped order;
  census verdict deltas (each rule mutated); boundary gate; receipt v4 allowlist;
- PG: PROCESS_CENSUS through the real in-process bridge server (registered case, hidden unregistered submit, rejected submit,
  handoff); DRAIN through C; switch with idle S/C sessions passes, an S session in a transaction / a foreign session refuses;
- process E2E (darwin/arm64): O/C/S + the instrument driver over two segments with the real switch while S and C stay up; the boundary
  gate refuses before the drain and passes after it; receipts carry censuses and drains.

## 8. Residuals (rc2 additions marked)
- Census fields are S self-measurements inside its trust boundary; DRAIN combines them with C's independent DB snapshot only.
  Platform process/socket coverage is part B. A process with the runtime/reader password could impersonate a registered session
  name (same-credential trust limit, as for S itself).
- pendingCommitCount is an upper bound (owner-release based); exact commit-level gauges would need hooks inside accepted R-B code.
- Evaluation-validity residual of D1 (§1).
- rc2: Part-A DRAIN is not 02-QUIESCENT evidence (§4, F2; carried to part B).
- rc2 (review N5): transport entries are attributed to the one CLAIMED arm; this holds only while nothing else can dispatch (no-key
  bridge, single-client sandbox, DB cross-check) and must be revisited with the key pass-through decision.
- rc2 (review N6/N8): the idle check's xid/xmin clause is redundant with `pg_locks` (every xid/xmin holder holds its virtualxid lock), kept
  as defense in depth without its own detecting test; a registered S write during the switch relies on the accepted RS-B fingerprint
  re-check (not re-tested here); on the O path an S-detected census FAILURE is relabelled CONTROLLER (as the accepted terminal path).
- rc2 (review N7): the R-EVAL operator sections moved from `docs/RUNBOOK.md` (737 lines) to `rs-d/REVAL_RUNBOOK.md`.
