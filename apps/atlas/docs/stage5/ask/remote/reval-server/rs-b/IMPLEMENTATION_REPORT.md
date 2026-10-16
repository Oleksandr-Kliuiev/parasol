# RS-B implementation report — rc1 history + rc2 repair (S5ASKREMOTE-REVAL-SERVER-RSB)

Implementer: native Claude Code session, model `claude-opus-5-5`, one cohesive session, one checkout writer (2026-10-11).
This report is NOT acceptance. Owner-set gate for RS-B: one independent reviewer, native Claude Opus 5.5 at effort `max`, in a
new clean session (`IMPLEMENTATION_BRIEF.md` header). No paid/provider calls, activation, accounts, customer data or deployment.

## 1. Result in one paragraph

Ten of the eleven frozen fixtures are materialized by the real fence-first switch and proven DB = fixture × all five intents on
PostgreSQL 17 under the confined runtime role with no bearer; FIXTURE_CHECK runs end to end O → C → V with the actual peer
proof (Docker seam and a disposable native unix-socket PG17). **FX04 cannot be represented** in the accepted schema and is
refused (`PLAN_INVALID`), so the 05 RS-B exit criterion "All 11×5" is NOT met; this needs an owner/dataset decision (§3 D1).

## 2. What was built (brief §1–§2)

| Concern | Files | Behavior |
|---|---|---|
| Frozen identity | `packages/reval/dataset.ts` | Manifest bytes `224b1b8d…`, fixture file `40f1744a…` (manifest entry), 11 IDs, pinned reference `2026-10-10T07:30:00.000Z`, seed-mapping digest |
| Seed mapping/plan | `seed-mapping.json` (`00276e63…`), `seed-plan.ts` | Closed strict decoder; deterministic rows of the 10 allowlisted tables from `originalRow` + declaration; FX08 INFO sentinel; MISSING = no SyncState; schema-compat refusal |
| Owner maintenance | `inventory.ts`, `materialize.ts`, `register.ts`, `maintain-cli.ts`, `maintain-deps.ts`, `scripts/reval-server/maintain.ts` | `probe`/`register`/`install <FXnn> <gen>`; two physically bound owner connections; exact inventory; fence → policy → binding FOR UPDATE; DELETE/INSERT; generation + 1; post-check |
| Clock boundary | `source-clock.ts` | Reference released only for frozen dataset + pinned reference + frozen fixture + positive generation; used only as `readDbSource(..., now)` in V |
| Verifier V | `pg-tx.ts`, `fixture-verify.ts`, `verifier-exec.ts`, `scripts/reval-server/fixture-verifier.ts` | Runtime role, READ ONLY REPEATABLE READ; registration/binding; ACTIVE actor + one membership (context:read AND ask:remote); row identity; accepted `readDbSource`/`phaseSql`/`project`/`remoteAnswer`; independent `buildSource`, `expectedFactData`, `checkAnswer` |
| FIXTURE_CHECK in C | `fixture-check.ts`, `controller.ts`, `codes.ts`, `deps.ts`, `launch.ts`, `private-frames.ts`, `payloads.ts`, `owner-cli.ts` | Snapshot #1 → V (HELLO, peer proof, request by D−1200, result by D−300) → snapshot #2 by D−50; exact 03 payload; FAILURE codes otherwise |
| Runtime grants | `prisma/roles/reval.sql`, `packages/graph/reval-role.ts` | Exactly the B10 column SELECTs; readiness fails on any extra/missing column or other privilege |

## 3. Deviations and findings (decide or accept explicitly)

- **D1 FX04 unrepresentable (blocker for "All 11×5").** Its `readerExcludedLinks` declares a CANDIDATE `PERSON ↔ huntress agent`
  link; accepted `EntityLink_type_compat_check` allows only agent↔DEVICE and contact↔PERSON. Per 03 the SQL is not weakened and the
  declaration is not altered: `seedPlan` throws `LINK_TYPE_INCOMPATIBLE`, `install` refuses `PLAN_INVALID`, state unchanged. FX04 is
  the only fixture with a candidate link and is used by 21 of the 200 cases. Options for the owner: (a) dataset revision (e.g.
  `contact`↔PERSON) with renewed offline acceptance; (b) explicitly approved seed-mapping exception for this unprojected field;
  (c) exclude FX04 cases. The mechanism itself is proven on an explicitly modified in-memory variant (not frozen evidence).
- **D2 `itemCount` of a truncated empty snapshot = 1.** 03 says `itemCount=0`, but accepted `ResourceSnapshot_items_check`
  requires `truncated = (itemCount > jsonb_array_length(items))`; `itemCount` is not projected. Mapping literal, recorded.
- **D3 INACTIVE accepted like PAUSED** for register/install (never admitted anything); ACTIVE/REVOKED/TOMBSTONE refuse.
- **D4 Drain substitute.** RS-D's DRAIN is not implemented; the switch requires NO other backend on the sandbox (API server and
  controller stopped) and no `EGRESS_COMMITTED` attempt. A non-`pg_read_all_stats` owner sees foreign sessions with
  `backend_type` NULL; they count as writers (found by a test; fail-closed).
- **D5 Runtime column SELECT** supersedes RS-A decision A4 for exactly the B10 columns (01 permits it; needed by V now and phase1
  in RS-C). RS-A roles/readiness/tests updated.
- **D6 Phase1 wiring deferred to RS-C**: S keeps Ask OFF in bridge mode; nothing in `packages/ask/**` changed.
- **D7 `docs/AI_CONTEXT_MAP.md` not updated** (execution-RC5 file); routing lives in `packages/reval/AGENTS.md` and RUNBOOK.

## 4. Checks (commands and results)

| Command | Result |
|---|---|
| `npm test` (all `tests/*.test.ts`) | 519 tests: 510 pass, **8 fail**, 1 skipped. The 8 are exactly RS-A's qualified RC5 identity-only set (7 `ask-remote-eval-execution-*` module wrappers + the RC5 pty test, `CORPUS_IDENTITY_MISMATCH`); `tests/reval-rc5-guard.test.ts` passes (drift only from RS-A's enumerated deltas). Not a green unit run. |
| `npm run typecheck`, `schema:validate`, `api:build`, `api:smoke` | pass |
| RS-B focused PG17 (Docker, non-superuser owner) | `reval-fixtures` 2/2, `reval-materialize` 7/7, `reval-maintain-cli` 3/3, `reval-fixture-check` 3/3 |
| Native unix PG17 (`ATLAS_REVAL_NATIVE_PG_FIXTURE`, disposable cluster) | `reval-native-rsb` 1/1 (production `maintain.ts` + O → C → V) |
| `npm run test:pg` (full, with the native descriptor) | **741/741 pass, 0 fail, 0 skipped** (incl. RS-A `reval-native-unix` regression and `reval-native-rsb`), 204 s |
| `db:check:pg17` / `db:check:drift` | pass / pass (empty drift) |

Receipts: `verification/stage5/S5ASKREMOTE_REVAL_RSB_RC1_CHECKS.json`, logs in `…_RC1_EVIDENCE/`; identity `…_RC1_MANIFEST.json`.
Evidence lines: all 10 representable fixtures `ALL_TRUE` at generations 1..10 (FX04 `PLAN_INVALID`); real-clock negative mismatches
exactly the 9 fixtures declaring an OK resource (FX06 equal); FIXTURE_CHECK 184–231 ms (Docker), 200 ms (native); finance/audit/
identity fingerprint unchanged across switches; every refusal leaves binding, rows, fence and fingerprint unchanged.

## 5. Residuals

FX04 (D1); RC5 integration still pending (its guard refuses; nothing resealed); `loadedBinding` UNVERIFIED and image/egress/privacy
proofs remain RS-D; Docker results are regression evidence only, native results are test-fixture evidence, never MEASURED; the
table owner remains a trust boundary (direct owner SQL outside the tool is detected only by census, inventory, row identity and
the projection comparison); FIXTURE_CHECK compares accounting of the two snapshots but does not re-run the SNAPSHOT pricing
comparator; the native cluster is a disposable test fixture under `/private/tmp/rsb-pg` (unix socket only, no TCP).

## 6. rc2 repair (after the rc1 review, CHANGES_REQUIRED: F1–F4 required, B1 owner decision)

rc1 above is kept as history; its "10/11" and D3 statements are superseded here. Changes (brief §6):

| Finding | Repair | Proof |
|---|---|---|
| F1 PAUSED not enforced in FIXTURE_CHECK | `fixture-check.ts`: both snapshots must be PAUSED, else `POLICY_CHANGED` | `reval-fixture-check` rc2 F1 (ACTIVE → `FAILURE POLICY_CHANGED`) |
| F2 INACTIVE accepted (D3) | `inventory.ts`: exactly PAUSED; test sandbox revised to PAUSED by the trusted routine | `reval-materialize` (INACTIVE and ACTIVE refused for register and install) |
| F3 missing negative controls | new tests | tampered intents → only `allFiveIntents:false`; tampered bank → `expectedFacts:false`; accounting change during V → `financeUnchanged:false`; generation bump after V → `FIXTURE_MISMATCH`; mutations M1–M4 (always-true intents, hard-coded financeUnchanged, dropped generation re-check, dropped PAUSED check) each fail ≥1 test |
| F4/F8 autovacuum vs other writers | `OTHER_WRITER_PREDICATE`: all types except autovacuum | predicate test over 9 synthetic rows; repeated parallel `reval-fixtures` runs (CHECKS) |
| F6 / F9 / F10 / F11 | fixed refusal for non-data reader failures; accepted confinement check in V; RUNBOOK; `.txt` logs | F6/F9 and the snapshot-#2 PAUSED refusal: reviewer probes only, no dedicated test (rc2 review N1, carried to RS-C); RUNBOOK RS-A/RS-B sections |
| B1 FX04 | owner-approved exact mapping exception (contact↔PERSON for the excluded CANDIDATE link) | 11 × 5 ALL_TRUE; decoder/stale/variant negatives; native chain installs FX04 |

Not changed (accepted by the reviewer or carried as residuals): D1→B1 resolved as above, D2, D4 (interim; RS-D DRAIN),
D5, D6, D7; F5 (verifier imports TypeScript sources of `packages/ask/**`/`scripts/ask-remote-eval/**`, outside the declared
build/launcher digests; phase1 will run `dist/`) — carried to RS-C/RS-D; F7 (derivation rules and null defaults live in
`seed-plan.ts`, covered by the package hash, not by `seedMappingSha256`) — residual.
Final rc2 checks: `verification/stage5/S5ASKREMOTE_REVAL_RSB_RC2_CHECKS.json`; identity `…_RC2_MANIFEST.json`.

