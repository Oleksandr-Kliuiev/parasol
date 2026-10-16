# RS-C implementation report — part A (server + controller), rc2 (S5ASKREMOTE-REVAL-SERVER-RSC-A)

Implementer: native `claude-opus-5-5` (Claude Code session `d0382327-d726-4375-8d23-49e794437702`), 2026-10-11/12. This report is
not an approval. Acceptance gate (owner's direct instruction 2026-10-11): ONE independent native Opus 5.5 `max` review in a clean
session, launched like RS-B as a fresh-context Claude Code subagent (model opus, effort max). The global Codex-orchestrated
`reviewer-cli` dual Sol/Opus `xhigh` gate is not used for this owner-directed gate; the owner may require it instead.
Brief: `IMPLEMENTATION_BRIEF.md` (in the baseline). Baseline: `verification/stage5/S5ASKREMOTE_REVAL_RSCA_BASELINE.sha256`
(`git ls-files -co --exclude-standard` after the RS-B seal). Manifest/checks: rc1 `verification/stage5/S5ASKREMOTE_REVAL_RSCA_RC1_{MANIFEST,CHECKS}.json` (historical, reviewed CHANGES_REQUIRED);
current rc2 `verification/stage5/S5ASKREMOTE_REVAL_RSCA_RC2_{MANIFEST,CHECKS}.json`.
No paid/provider call, activation, account, customer data, deployment or commit.

## 0. rc2 repair of the RC1 review (`docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCA_RC1.md`, CHANGES_REQUIRED)

| Finding | Repair (brief §6) | Evidence |
|---|---|---|
| F1 P1 key could resolve in bridge mode | `bridgeRemoteSeams()` in `apps/api/src/reval/evaluation.ts`, used by `main.ts` in bridge mode only | `reval-eval-server.pg` "rc2 F1" (env:// policy, key in `process.env`, control resolves; result NO_DISPATCH) |
| F2 S seen after DB read | `EvaluationState.seeCase` before `currentFacts`; frozen IDs only | `reval-eval-runtime` F2/F12, `reval-eval-pairing` row S |
| F3 slot eviction / foreign READY | no arm while the slot is live; slot keeps its arm READY | `reval-eval-pairing` F3, `reval-eval-runtime` TRANSFER echo |
| F4 deadlines at TRANSFER/ACK | deadline before claim/TRANSFER, at ACK; body read and DB reads bounded; COMMIT FAILED `RAW_EXPIRED`/`ACK_TIMEOUT` | `reval-eval-runtime` F4, `reval-eval-handoff.pg` F4 |
| F5 raw values outlive revocation/120 s | writes only into BOUND slots; real monotonic timers | `reval-eval-pairing` F5, `reval-eval-gate` F5 |
| F6 RESPONSE rechecks, pair revocation | pair bound to credential/admission/policy version/generation; RESPONSE and ARM recheck; any change revokes the pair | `reval-eval-pairing` F6, `reval-eval-handoff.pg` F6 |
| F7 NB7/NB9/NB10 | NB9 stop state in C, active case retires only on FINAL; NB10 guard-count-only; NB7 measured | `reval-eval-controller` NB9 ×2, `reval-eval-server.pg` NB10, `reval-eval-e2e.pg` NB7 line |
| F8 unvalidated forwards | `fromServer` kind/schema check; terminal binding = requested arm/registration/boot | `reval-eval-controller` NB9 + terminal tests |
| F9 journal durability | truncate on failed append; directory fsync on create | code (F_FULLFSYNC residual) |
| F10 hook isolation | `observe()` wrappers in `service.ts` and `ask-http.ts` | code; existing fault/settlement PG test |
| F11 header ignored | bridge-only fixed 400 on other routes; ordinary servers unchanged (reading recorded) | `reval-eval-server.pg` ingress test |
| F12 hardening | constant-time `sameSecret`; READY `caseId` validated; seen sets bounded | unit tests |
| F13 N3 fragility | one extra check allowed, never a stale success | `reval-fixture-check.pg` |

Also: three orphan test API servers (`node dist/apps/api/src/main.js`, ports 56091/56112/56131) left by the implementer's stopped
`test:pg` run were terminated by the implementer after the review noted them.

## 1. Delivered (brief §1 items 1–7)

| Item | Where |
|---|---|
| (1) bridge S serves Ask REMOTE for the registered sandbox; ingress gate before body/bearer/DB/budget | `apps/api/src/reval/evaluation.ts` (composition used by `main.ts` and test entries), `packages/reval/eval-gate.ts`, `eval-db.ts`, `apps/api/src/ask-http.ts` hook |
| (2) PAIR / END_PAIR (C secret frames to O and S; browser PAIR) | `eval-controller.ts` `ownerPair/endPair`, `controller.ts`, `owner-cli.ts` (`SECRET PAIRING_NONCE` line), `server-link.ts` `evaluationRequest`, `bridge.ts` `installPair`, `eval-handoff-route.ts` |
| (3) ARM_CASE I→C→S, first-current case sets, 26 s S window | `eval-controller.ts` `arm` + `preSnapshotProblem`, `eval-cases.ts`, `eval-state.ts` `armCase` |
| (4) S↔I transient protocol on S's own measured socket | `eval-handoff-socket.ts`, `eval-transient.ts`, `eval-runtime.ts` `ready/respond` |
| (5) private slot + `X-Atlas-Evaluation-Receipt` + RESPONSE handoff | `eval-state.ts` slot, `RegisteredTask.publishing`, `eval-runtime.ts` `respond`, `eval-handoff-dto.ts` |
| (6) terminal observation (S records, C journal) | `eval-observer.ts`, `eval-journal.ts`, `eval-controller.ts` `terminal`, bridge TERMINAL_OBSERVATION/OBSERVATION_COLLECTED |
| (7) RS-B carried items | D6: `eval-db.ts` `evaluationPhases` + `packages/ask/remote/db.ts` phase hook; N1/N3: `tests/pg/reval-fixture-check.pg.test.ts`; N4: `verifier-exec.ts` |

C's instrument control socket: `eval-instrument-link.ts` (I principal, 06 direction table, one outstanding request).

## 2. Implementation decisions inside the brief (for review)

- **Exact wire values in the slot.** The claimed task captures the EXACT parsed body the server received after V2 validation
  (`EvaluationTask.request(request, raw)`), not the normalized internal request; the browser's RESPONSE must echo it
  structurally (key order irrelevant). Found by the PG E2E (the normalized form lacked `contractVersion`/disclosure fields).
- **Final record.** `final = physicalOwnerReleased AND publication ∈ {SERVER_FINISHED, FAILED}`; a write still in flight at the
  physical release finishes or fails later and only then makes the record final (the decoder enforces the same equivalence).
- **ACKs.** One outstanding transfer waiter per handoff connection; a late (after its 2 s deadline) or unsolicited ACK is dropped
  and can never answer a later transfer. A forged ACK → `ACK_INVALID` with no COMMIT; a REJECTED ACK → COMMIT FAILED.
- **Budget refusal after a claim** (`ASK_BUSY`): the claimed task is aborted AND finished, so its arm never stays CLAIMED.
- **C's ARM admission (04 "First-current-GO bookkeeping", row C).** Admission = the paired (registered) control connection, a
  not-yet-seen case and no other active case; only then is the case marked seen, BEFORE every later check (arming stop, case
  map, browser pair, PRE age/content, S). A refused attempt while another case is active does not consume its case.
- **Second submit with the claimed session token** → `integrityStopped` for the life of this S process (`duplicateSubmit` counter).
- **Exit codes.** `BRIDGE_EXIT.REGISTRATION = 43`: the launch's registration (runtime column SELECT, frozen dataset, synthetic)
  or the pinned helper bytes do not match → S exits before listening.
- **Compiled layout.** `dataset.ts` resolves the frozen data directory for both `<root>/packages/reval/` and
  `<root>/dist/packages/reval/` (S runs the build); the bytes stay hash-verified, so the location carries no trust.
- **Accepted R-B behaviour kept:** a model mismatch still triggers the accepted protective PAUSE; the evaluation hook only
  latches the fault before settlement (`fault` is called synchronously at the verdict, before settlement/publication/pause).

## 3. Declared deltas to accepted code (rc2: 26 changed incl. docs, 33 added; manifest lists baseline → new hashes)

- Ask hook points (null outside bridge mode): `apps/api/src/ask-http.ts`, `apps/api/src/db/ask-remote.ts`, `packages/ask/budget.ts`,
  `packages/ask/remote/db.ts`, `packages/ask/remote/service.ts`; new `packages/ask/remote/evaluation.ts`.
  **RC5/offline-RC3:** `budget.ts`, `remote/db.ts`, `remote/service.ts` are execution-RC5 AND offline-RC3 package files. The
  unchanged RC5 guard now reports `OFFLINE_FILE_DRIFT` caused by exactly these three (enumerated in `tests/reval-rc5-guard.test.ts`
  `RSCA_RC5_EXECUTION_DELTAS`); the RC5 instrument identity is superseded by the RS-C-B instrument revision.
- RS-A files: `apps/api/src/main.ts`, `apps/api/src/reval/bridge.ts`, `packages/reval/{codes,controller,owner-cli,server-link}.ts`.
- RS-B files: `packages/reval/dataset.ts` (compiled-layout data dir), `packages/reval/verifier-exec.ts` (N4 listener).
- Tests/support: `tests/reval-{handshake,protocol,rc5-guard,seed}.test.ts`, `tests/pg/reval-fixture-check.pg.test.ts`,
  `tests/support/{reval-pg,reval-test-deps,reval-test-server-entry,reval-test-verifier-entry}.ts` (`DATASET_SHA256` = the frozen manifest:
  S now reads the registration and requires it).
- Docs: `docs/RUNBOOK.md` (RS-C-A section), `packages/reval/AGENTS.md`, `scripts/reval-server/AGENTS.md`, new `rs-c/AGENTS.md`, this report.
- Unchanged: migrations, roles, schema, operator console, `docs/AI_CONTEXT_MAP.md`, `AGENTS.md`, `package.json`, the RC5 instrument.

## 4. Checks (rc2 receipt `S5ASKREMOTE_REVAL_RSCA_RC2_CHECKS.json`, logs in `..._RC2_EVIDENCE/`; rc1 receipt kept as history)

Full rc2 run: typecheck, `schema:validate`, `api:build`, `api:smoke`, `db:check:pg17`, `db:check:drift` pass; unit `tests/*.test.ts`
554 tests: 545 pass, 1 skipped, 8 fail = exactly the pre-existing RC5 identity-only set (same eight names as RS-B and rc1);
`test:pg` with the native descriptor 767 tests: **766 pass, 1 fail** — the RS-B "suspended designated actor" FIXTURE_CHECK test
returned `CENSUS_UNAVAILABLE` (its session started with `fixture-check`, the N3 first-operation sub-budget cause under load). That
test and the rc2 F1 ACTIVE test now start with `snapshot` like the other N3 sessions; the whole file was re-run focused (9/9) and
the change touches only that test file. NB7 numbers of this run: ARM 10 ms, READY 1 ms, POST→COMMIT 38 ms, terminal collection
with journal fsync 22 ms (Docker TCP seam; regression evidence).

New coverage: exact schemas (`tests/reval-eval-wire.test.ts`); pair/arm/claim/slot/observer/journal/case map/PRE checks
(`reval-eval-state.test.ts`); ingress gate + claimed task (`reval-eval-gate.test.ts`); controller PAIR prerequisites, ARM_ACK loss
never re-arms, ACK echo, PRE age, journal-before-collection and arming stop, control loss (`reval-eval-controller.test.ts`); in-process BUILT composition on PG17
(`tests/pg/reval-eval-server.pg.test.ts`: full case, D6, ingress before body/bearer/DB, stolen token/foreign bearer 403, focus 400,
one-claim race, fault-before-settlement, generation mismatch 409, TTY-less peer refused); RESPONSE/transfer edges
(`reval-eval-handoff.pg.test.ts`: edited/swapped DTOs, receipt one-use/race, Origin/Fetch-Metadata/session/bearer, forged/rejected/
late ACK, I loss, out-of-sequence ACK); process E2E O(live PTY)→C→S + I(PTY) + browser (`reval-eval-e2e.pg.test.ts`); native
production chain with `dist/main.js` and no key (`reval-native-rsc.pg.test.ts`: `503 ASK_REMOTE_UNAVAILABLE`, attempt `NO_DISPATCH`, 0 charged).

## 5. RS-B carried items

- **N1** done: three tests (policy ACTIVE during V → `POLICY_CHANGED`; V as table owner → `UNAUTHORIZED`; a reader statement
  cancelled server-side → `DEADLINE`). Combined mutation (s2 PAUSED check, F9 confinement, F6 rethrow removed): each of the
  three tests fails on its mutation (P3/P1 in one run; P2 run separately — it got `OK FIXTURE_CHECK` with false booleans), all
  pass on the restored code.
- **N3** done: the V-sleep tests start with `snapshot`, synchronise on V's own marker file (no `pg_stat_activity` polling), sleep 300 ms.
  The rc2 reader-stall test ("generation change AFTER V committed") also starts with `snapshot` now (stalled BEGIN #4): in the
  first full `test:pg` run of this checkpoint it was the ONE failure (marker never reached under full-suite load; log
  `test-pg-run1.txt`, 763/764) — the same first-operation sub-budget cause N3 describes; 3/3 isolated runs pass after the change.
- **N4** done: V absorbs the pg client's asynchronous `'error'` (`tests/reval-verifier-events.test.ts`; fails without the listener).
- **D6** done: phase1 reads the binding (arm generation, frozen dataset) and returns the pinned reference as `readDbSource`'s
  resource-age `now`; egress/phase2 re-read the generation. PG evidence: resource statuses equal the frozen expectations while
  `generatedAt` and the ledger day are real time.
- **F5** residual → RS-D: V still runs TypeScript sources outside the declared digests (S runs `dist/`).

## 6. Residuals and open decisions

- **Provider key pass-through (owner decision PENDING; tentatively Azure environment variables).** rc2: the bridge seams never
  resolve a key (S's `process.env` may still receive checkout `.env` names through Prisma's dotenv — RS-D egress/privacy item);
  every evaluation question is `NO_DISPATCH`. RS-C-A adds no pass-through.
- I is a test client in part A (`tests/support/reval-test-instrument.ts`); the real instrument and GO/summaries are RS-C-B.
- T2 trust limit: C and S each prove an instrument peer (same euid, node exe, TTY, not O/C/S/E/V) but do not compare them to
  one pid across processes; the owner's explicit `pair <control> <handoff>` binds them (brief §2).
- Time-based limits (120 s slot, 120 s nonce, 26 s window, 10 min retention, 16 revisions) are covered with an injected clock
  in unit tests; PG tests cover the real-time 2 s handoff deadline only.
- The in-process generation test simulates a switch between ARM and phase1 by changing the arm's expected generation (a real
  switch needs every other backend gone, impossible while S holds connections); the phase hook and SQL are real.
- C maps a verifier EOF (e.g. V's own process deadline) to `FIXTURE_MISMATCH` (unchanged RS-B behaviour, fail-closed).
- Test tooling: the live owner PTY uses the system Python (`/usr/bin/python3 -I`, stdlib `pty` only; macOS Command Line Tools).
- Pre-existing flakes: `tests/reval-payloads.test.ts` "approved pricing" (random UUID, observed once); RS-A closure test (RS-B N4 note).
- macOS `fsync` is not `F_FULLFSYNC` (Node exposes no full fsync): journal durability across power loss is not claimed.
- Housekeeping: throwaway test databases leaked during development: `atlas_it_0d6fe0d9` (+ role `atlas_rv_owner_be158862`) from a
  failed in-process harness run (fixed: the sandbox now cleans up on failure), and six `atlas_it_*` (`f8f19667`, `d9e358be`,
  `403f557c`, `3b04aefe`, `28c3ae0b`, `427cf9fb`) from a full `test:pg` run the implementer stopped early to apply the ARM-admission
  change (killed test processes skip their `after` hooks). Dropping them was blocked by this session's permission policy — the
  owner may drop them. Four older `atlas_it_*` databases owned by `atlas` predate this work.
- Out of scope (later parts): RS-C-B instrument revision, RS-C-C browser pane and 200-path E2E, RS-D census/drain/proofs.
