# RS-C implementation brief — part A (server + controller), rc1 (S5ASKREMOTE-REVAL-SERVER-RSC-A)

Status: written by the implementer (native `claude-opus-5-5`, Claude Code session) on 2026-10-11. Not an approval. The owner
asked for RS-C in three parts — **A** server + controller (this brief), **B** instrument revision, **C** browser pane + 200-path
E2E — each followed by ONE independent native Opus 5.5 `max` review in a clean session (bounded re-reviews in that session).
No paid/provider calls, activation, accounts, customer data or deployment. Provider keys: the owner TENTATIVELY plans
environment variables on Azure. rc2 (review F1): bridge-mode S composes provider seams that can NEVER resolve a key — whatever
Prisma's dotenv loading or anything else puts into `process.env` — so every evaluation question stays NO_DISPATCH
(`ASK_REMOTE_UNAVAILABLE`); tests use the accepted offline seams. The key pass-through is a PENDING owner decision.

## 0. Identity
- Architecture SERVER-DESIGN-rc4 `9fa16222…8163` (04 handoff/ingress/arm, 06 protocol/terminal observation, 05 RS-C row).
- Parents: RS-A rc3 `ae4fb782…6216`; RS-B rc2 `a34d85d1…3fc2` (+ its seal's `carriedToRSC`). Accepted R-B/R-C Ask code is
  modified only at the hook points in §4; their seals stay historical; the RS-C-A manifest lists baseline → new hashes.
- Baseline: working tree after the RS-B seal (2026-10-11), `verification/stage5/S5ASKREMOTE_REVAL_RSCA_BASELINE.sha256`.

## 1. Scope of part A
IN: (1) bridge-mode S serves Ask REMOTE for the registered sandbox with the registration-lifetime ingress gate (04 pipeline);
(2) PAIR/END_PAIR (C secret frames to O and S; browser PAIR via the handoff route); (3) ARM_CASE (I→C→S, first-current
case sets, 30 s window); (4) S↔I transient protocol (READY/READY_ACK/TRANSFER/ACK/COMMIT) on S's own measured socket;
(5) private publication slot + `X-Atlas-Evaluation-Receipt` + RESPONSE handoff; (6) terminal observation (S records, C journal,
TERMINAL_OBSERVATION/OBSERVATION_COLLECTED); (7) RS-B carried items: phase1 uses the binding's pinned reference and captures/
rechecks the fixture generation (D6), N1 tests, N3 test robustness, N4 verifier pg error listener.
OUT: the real instrument (part B; part A drives I with a test client that speaks the exact protocol); the browser pane and
sealed console build (part C; part A drives the browser HTTP surface with a test client); PROCESS_CENSUS/DRAIN/platform/
privacy proofs (RS-D); key pass-through.

## 2. Topology decisions (within 01/06; reviewed here)
- T1 I→C: C creates `<configDir>/reval-instrument.sock` (0600, the config's 0700 realpath dir, removed at exit). Each
  connection: I writes `RevalInstrumentHelloV1 {kind:'CONTROL', helloNonce}` FIRST; C runs the pinned peer helper on the
  accepted socket: euid equal, exe = node realpath, hasTty TRUE (the instrument is a TTY tool), not O/C/S/E/V; then sends
  `RevalInstrumentWelcomeV1 {helloNonce, registrationId, serverBootId, connectionId}` and switches to 06 envelopes
  (I-principal authorization via the 06 table). connectionId is C-random per connection.
- T2 S↔I: C passes S `handoffSocketPath = <configDir>/reval-handoff.sock` and the pinned helper path/sha in
  `RevalServerLaunchV2`; S verifies the helper bytes like C, listens, peer-proves each connection the same way (hasTty TRUE),
  greets with `RevalHandoffWelcomeV1 {helloNonce, registrationId, serverBootId, connectionId, controlConnectionId}` where the
  I hello names its C-assigned control connectionId. PAIR binds BOTH ids typed by the owner; S requires the handoff
  connection's declared control id to equal the PAIR's control id. Residual: the two peers are each proven but not compared
  to one pid across C and S (same-UID trust limit; the owner's explicit registration binds them).
- T3 Launch V2 adds `{workspaceId, askMode:'remote', handoffSocketPath, nativePeerHelper, nativePeerHelperSha256}`; S then
  reads its registration (runtime column SELECT, RS-B B10) and requires registrationId/databaseInstanceId/workspace equality.
  Ask mode REMOTE in bridge mode comes ONLY from the launch frame (env stays exact); OFF/MOCK/ordinary REMOTE unchanged.

## 3. Pair, arm, window
- PAIR (O only, payload exact 06): C requires a successful FIXTURE_CHECK (all six booleans true) of the CURRENT fixture
  generation in this session, both connection ids live, no occupied pair. C reserves pairId + 43-char Token nonce (≤120 s),
  sends S the exact `RevalPairSecretV1` as the restricted install request (S answers PAIR_ACK), answers O with PAIR_ACK
  `{pairId, expiresAt(nonce), paired:false}` and then the private secret frame on its next send sequence (O shows the nonce in
  its raw TTY only). Browser PAIR (handoff route) → PAIR200 with sessionToken (independent Token), ≤10 min, ≤ admission expiry,
  and `evaluationFocus` derived by S from the DB binding + frozen fixture bytes. One pair per server; revoked on generation/
  policy/actor/membership/credential change detected at use, handoff/control loss, END_PAIR, restart.
- ARM_CASE (I→C only from the paired control connection): C marks the case seen BEFORE checks (repeat → CASE_CONSUMED);
  frozen case→fixture mapping; preSnapshotId = a SNAPSHOT this C exported to that connection whose completion is ≤2000 ms old
  (the GO command takes PRE immediately before ARM), same UTC day/month, ACTIVE, consistent, foreign 0, headroom ≥ reserve,
  fixture/generation/admission/policyVersion equal; pair current and browser-paired. One forward to S; S marks seen BEFORE
  arm creation and creates ≤1 arm: expiresAt = earliest of S-receipt + 26 000 ms (30 s − 2 s PRE bound − 2 s hop), pair/
  admission expiry, next UTC day. Window never renews.

## 4. Hook points in accepted code (minimal, null outside bridge mode)
- `apps/api/src/ask-http.ts`: optional `EvaluationGate` consulted synchronously after classification and BEFORE body read
  (header syntax, Origin/Fetch-Metadata for the header, token → claim ARMED/READY→CLAIMED); the claimed task travels to the
  controller; `AskExchange.publish` asks the task for extra headers (receipt) at write time; `res.finish` → SERVER_FINISHED.
- `packages/ask/remote/service.ts`: optional task in `QuestionInput`: after authentication → registered scope equality (403
  before phase1, arm consumed); after V2 parse → focus equality (400) and request capture; reservation/verdict/settlement/
  publication observations; nothing else changes order.
- `packages/ask/remote/db.ts`: optional phase hook: phase1 reads the binding (generation must equal the arm's) and returns the
  pinned reference used as `readDbSource`'s `now`; egress and phase2 re-read the generation (mismatch → `ASK_SCOPE_CHANGED`).
- `packages/ask/budget.ts`: `AskOwner.onRelease(fn)` (physical release observation). `apps/api/src/main.ts`,
  `apps/api/src/db/{app.module,ask-remote}.ts`, `apps/api/src/reval/bridge.ts`: bridge composition only.

## 5. Required checks
Unit + PG17 (Docker seam) + native unix PG17 chain where processes are involved: exact schemas of every new contractVersion;
ingress matrix (no/malformed/duplicate/foreign-scope header, OFF404, capability header 400, pre-GO/expired/revoked/consumed →
503 before body/DB, stolen token + foreign bearer → 403 before phase1, focus mismatch → 400); one-claim race; arm sets/expiry/
ACK loss never re-arm; slot binding vs edited/swapped DTOs, replay/expiry/race of receipt nonce, Origin/CSRF; transfer/ACK/
COMMIT ordering, delayed/forged frames, disconnect → UNVERIFIED; terminal faults latched before settlement; journal atomicity;
clock isolation on the Ask path (reference only for resource freshness); full `npm test`, typecheck, schema, build, smoke,
`test:pg`, pg17, drift. RC5 identity failures may change only by the enumerated RS-C-A deltas (rc5-guard updated).

## 6. rc2 amendment (independent review RC1, `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCA_RC1.md`)
- F1: `bridgeRemoteSeams()` (resolver always null, transport refuses) in bridge mode only; ordinary REMOTE unchanged.
- S state: the case is marked seen BEFORE the DB read (F2); seen sets admit only the 200 frozen IDs at C and S (F12); no arm while
  a publication slot is live, and TRANSFER echoes the slot's OWN arm READY (F3); one 2 s deadline bounds the RESPONSE body read,
  every DB read, the nonce claim, TRANSFER and the ACK; an ACK after the slot's 120 s expiry or the deadline gets COMMIT FAILED
  (`RAW_EXPIRED`/`ACK_TIMEOUT`) (F4); raw values enter only a BOUND slot and drop by a real monotonic timer (F5).
- Pair binding (F6): browser PAIR binds the pair to its pairing credential digest, the admission, the policy version and the
  fixture generation; pair expiry ≤ 10 min, admission expiry and the credential's expiry. RESPONSE re-checks current authority,
  the pair's credential and the policy/fixture tuple; ARM re-checks the tuple. Any mismatch detected at use REVOKES the pair.
- NB9 arm-phase run state (F7): C admits ARM_CASE only for the paired control connection, a frozen not-yet-seen case, a run not
  stopped and no active case; then marks it seen. Any later failure (S failure, lost/invalid ACK, PRE/case/pair checks) or an
  armed case that expired unused stops arming for the rest of the controller process (`ARM_PHASE_FAILURE`/`ARM_EXPIRED_UNUSED`;
  `METADATA_PERSIST_FAILED` likewise). The active case retires only when its FINAL terminal observation was journaled. There is
  no resume command in 06: resume = fence-first closure (`pause-export`), POST census (RS-D `PROCESS_CENSUS`, pending) and a new
  owner session; the instrument's run state (RS-C-B) records the stop. Existing terminal/state-loss rules are unchanged.
- NB10: a post-authentication registration mismatch is guard-count-only (`scopeDenied` counter, 403 `ASK_SCOPE_DENIED`, the arm
  consumed); no `SecurityAuditEvent`/client audit row is written. Tested.
- NB7: ARM, READY, POST→COMMIT and terminal collection (journal fsync) latencies are measured in the process E2E (regression
  evidence on this host); the consecutive ARM/READY rehearsal with injected failures before/after consumption and the
  target-platform numbers belong to RS-C-C. The 2 s end-to-end handoff deadline and one-use semantics are unchanged.
- F8: C forwards only a valid FAILURE or exactly the expected kind with a valid payload; a terminal record must be the requested
  arm of this registration/boot. F9: a failed journal append is truncated back; a new journal's directory is fsynced (macOS
  `F_FULLFSYNC` is not available to Node — residual). F10: evaluation observation hooks are exception-isolated.
- F11 reading: in the measured server the evaluation header outside the Ask gate and the handoff route is a fixed 400. Ordinary
  OFF/MOCK/REMOTE servers have no registration and stay byte-for-byte accepted behaviour (the header has no meaning there).
- F13: the RS-B rc1 generation-change test allows one more check under load but still forbids any stale success.
