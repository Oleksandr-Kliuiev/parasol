# RS-D implementation report — part A (process census, DRAIN, fixture-grouped segments), rc1 + rc2

Implementer: native `claude-opus-5-5` (Claude Code session), 2026-10-13. Brief: `IMPLEMENTATION_BRIEF_A.md` (rc1). Not an approval.
Gate: ONE independent native Opus 5.5 `max` review in a clean session (owner instruction); the project's Sol/Opus `xhigh` and, for the
owner decisions D1/D2, Astra/Fable architecture gates are NOT run (recorded in the brief and `OWNER_DECISIONS.md`).
No paid/provider call, activation, account, customer data or deployment; the key pass-through stays PENDING.

## 1. What changed
- **S guard census** (`packages/reval/eval-census.ts`, `census-payloads.ts`): exact 05 PROCESS_CENSUS. Sources: the Ask gate (every
  capability/submit entry, publications by `finish`, unregistered and Binding-less submits as unattributed), the handoff route entry,
  the registered task's reservation hook, the census-wrapped provider transport seam (entry ⇔ capability consumption in R-B
  `dispatch.ts`), the process AskBudget (owners, releases) and the terminal observer (records, sticky uncollected). `main.ts` creates
  the census before the Ask module (wrapped no-key seams) and shares ONE budget between ingress and census; ordinary processes are
  unchanged (fresh budget, no census). The bridge answers C→S PROCESS_CENSUS.
- **C** (`eval-drain.ts`): PROCESS_CENSUS (O→C, I→C) forwarded as SERVER after an exact schema check, with C's sticky first-epoch rule;
  DRAIN (O→C, I→C) composed by C in one 1800 ms operation (census → atomic snapshot → census) per 02. `codes.ts` enables both;
  O decodes both.
- **D2 switch** (`inventory.ts` `checkRegisteredIdle`, `materialize.ts`, `maintain-cli.ts`): besides the tool's own backends and
  autovacuum only idle sessions of the configured runtime role named `atlas-reval-s-runtime` and reader role named
  `atlas-reval-c-reader` (no `pg_locks` row, no xid/xmin; these columns are visible to a non-privileged role — probed on PG17).
  `register` keeps the RS-B "no other backend" rule.
- **Instrument** (`scripts/reval-instrument/`): identity pins RS-C-C rc2 (manifest + seal; its context map overlay is checked against
  the accepted package; its sealed console build is a recorded rebuilt output) and records the RS-D-A candidate layer; `order.ts`
  (D1, pinned digest `0c8878f7…`, the run's corpus is bound to it); `census.ts` (compareCase with exactly one fate per submission,
  compareGap between cases, deferred POST relaxations, segmentBoundaryProblem); `run.ts` (PRE census before PRE, POST census once the
  record is FINAL — deferred to the next GO otherwise, retryable on a failed read —, `drain`, the boundary gate); `ipc.ts` tables;
  `receipt.ts` v4; `operator.ts` commands `drain` and `census`.
- **Docs**: brief, owner decisions, RS-D routing, the operator procedure (`rs-c/INSTRUMENT_RUNBOOK.md` step 8), RUNBOOK RS-B/RS-D-A,
  routing files and the context map; `rs-c/AGENTS.md` now says part C is accepted.

## 2. Checks (evidence `verification/stage5/S5ASKREMOTE_REVAL_RSDA_RC1_EVIDENCE/`, summary `…_RSDA_RC1_CHECKS.json`)
| Check | Result |
|---|---|
| typecheck, ui:typecheck, schema:validate, api:build (both consoles), api:smoke, db:check:pg17, db:check:drift | pass |
| `cli.ts artifact-check` | ok, drift [], candidate RS-D-A accepted:false |
| unit (`tests/*.test.ts`) | 602: 593 pass, 8 fail (exactly the pre-existing RC5 identity-only set), 1 skipped |
| `test:pg` (Docker PG17 + native unix PG17 fixture) | 778/778 pass — incl. reval-census, reval-segments (13 FX07 + 2 FX05 cases, ONE guard epoch, both boundary refusals, DRAIN QUIESCENT, switch with S/C up), NB7, native chain (census MATCH, no capability consumption) |
| `test:ui` with `ATLAS_REVAL_E2E_200=1` | 90 passed (21.8 min); 200 COMMITTED, semantic MATCH, FX10 MISSING 15 |
| mutation check (`mutations-rc1.txt`) | 37/37 detected (M33 after the effective-state assertion was added) |

Found while implementing (fixed, each with a detecting test): the instrument's IPC kind/producer tables and O's expected producer lacked
PROCESS_CENSUS/DRAIN (the process E2E failed until fixed); a deferred POST census must allow the operator's next preflight traffic.

## 3. Residuals and open items
- Census fields are S self-measurements in its trust boundary; DRAIN adds only C's independent DB snapshot. Platform process/socket
  coverage and egress/privacy are part B. A process with the runtime/reader password could use a registered application_name.
- pendingCommitCount is an owner-release upper bound (exact commit-level gauges would need hooks inside accepted R-B code).
- D1 evaluation-validity residual: fixture is confounded with order position.
- A deferred POST census relaxes capability/handoff traffic (operator preflight before the next GO) like the gap rule.
- Carried to parts B/C: platform/privacy proofs; build inventory seal; swept-vs-expired distinction; F_FULLFSYNC; T2;
  buildManifestSha256 binding; review N2/N5 of RS-C-C.

## rc2 — repairs for the rc1 review (`docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSDA_RC1.md`, CHANGES_REQUIRED)

| Finding | Repair | Detecting test / mutation |
|---|---|---|
| F1 deferred EXTRA not RC5 integrity | `#collectPrevious` calls `session.unrecordedClick` on a deferred `EXTRA_ACTIVITY` (the outcome is already recorded) | run test "rc2 review F1/F3/N2" (deferred extra submission → TERMINAL_FAILED); M39 |
| F2 Part-A DRAIN QUIESCENT without platform inventory | declared deviation in brief §4/§8, REVAL_RUNBOOK RS-D-A, INSTRUMENT_RUNBOOK step 8; carried to part B: DRAIN must be UNKNOWN unless C's platform adapter proves the complete inventory | docs |
| F3 continuity loss only a retryable block in the real chain | C's real answers FAILURE `IDENTITY_UNVERIFIED` (sticky epoch rule) and `IPC_LOST` (S unreachable) on any census read → persisted stop `CENSUS_CONTINUITY_LOST` (PRE, deferred POST, immediate POST); other read failures stay retryable | run test (both codes, PRE and deferred; retryable control); M40 |
| F4 C's role half untested | PG negatives: runtime role, owner (unregistered) role under C's name and the owner role under S's name → ANOTHER_WRITER | `reval-census.pg` D2; M38 |
| N1 brief §6 vs fate model | brief §6 now describes the implemented fate model | — |
| N2 DB attempts between cases | the PRE snapshot's projectAttemptCount must equal the last POST's (else stop before consumption) | run test; M41 |
| N3 no monotonicity in compareCase | any decreasing event counter → `DECREASE` (also compareGap) | census unit; M42 |
| N4 boundary DRAIN bound by policyVersion only | DRAIN entries record the closure's policyVersion AND fenceEpoch; the boundary needs both equal (a DRAIN after a fence-advancing switch does not count); receipt v4 drains carry `closureFenceEpoch` | census unit; M43 |
| N5 transport attribution | residual stated (brief §8), revisit with the key pass-through | — |
| N6 untested details | DRAIN order census₁ → snapshot → census₂ asserted (M45); handoff counting for another method/client path (PG); receipt: a verdict needs both records, MATCH one epoch (M44); xid/xmin clause declared redundant (no detecting test possible); S write during the switch relies on the accepted RS-B fingerprint (stated) | as listed |
| N7 docs | REVAL_RUNBOOK wording (only unsettled attempts must map); stale comment in `eval-controller.ts`; R-EVAL sections moved to `rs-d/REVAL_RUNBOOK.md` (`docs/RUNBOOK.md` 737 → 614 lines) | — |
| N8 O-path FAILURE producer | unchanged (as the accepted terminal path); stated in brief §8 | — |

rc2 checks: evidence `verification/stage5/S5ASKREMOTE_REVAL_RSDA_RC2_EVIDENCE/` (summary `…_RSDA_RC2_CHECKS.json`); mutation check 45/45 detected
(`mutations-rc2.txt`, M38–M45 for the rc2 repairs).
