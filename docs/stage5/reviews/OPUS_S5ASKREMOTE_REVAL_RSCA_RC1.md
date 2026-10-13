# Independent acceptance review — S5ASKREMOTE-REVAL-SERVER-RSC-A-rc1 (RS-C part A: bridge server + controller)

Reviewer: native Claude Opus 5.5 (`claude-opus-5-5`), launched by the orchestrator as a fresh-context review subagent. Effort
`max` is launch metadata and cannot be verified from inside the session. My context held only the orchestrator's brief: no
implementer conversation and no other reviewer's verdict. Disclosure: the host session id in my scratchpad path equals the
implementer session id named in the implementation report (`d0382327-…`). That scratchpad also holds the implementer's working
files, which I did not read. The owner can judge whether this counts as a "separate clean session". Date: 2026-10-12.

Constraints held:
- The only repository change is this report.
- Probes ran in `/private/tmp/rsca-review-opus/{copy,envprobe}` (copy with `node_modules` symlinked; synthetic `.env` in `envprobe`).
  Both directories have been deleted.
- I did not touch the native cluster `/private/tmp/rsb-pg` or any Docker container.
- No network beyond 127.0.0.1/unix sockets. No provider, account or paid call.
- No secret was printed; for `.env` I listed variable names only.
- The `atlas*` database and role census of both PostgreSQL servers is identical before and after all runs.

Normative basis:
- SERVER-DESIGN-rc4 `9fa16222…8163`, mainly `04_TRANSIENT_HANDOFF.md` and `06_LOCAL_PROTOCOL.md` (byte-equal to the RC4 manifest).
  Also the 05 rows RS-C, Clock isolation, Registered ingress, First arm, GO integration, Terminal fault, Local protocol and
  Handoff; 01/03 where referenced; and the design seal's `futureBriefObligations` for RS-C (NB7, NB9, NB10).
- RS-B seal `carriedToRSC` and RS-B rc2 review notes N1/N3/N4.
- Owner decisions: no paid or provider call. Key pass-through is PENDING, so RS-C-A must not resolve any key.
- The implementer brief and report were treated as claims to verify.

## Verdict

Verdict: CHANGES_REQUIRED

Most of the design is implemented faithfully:
- the registration-lifetime ingress gate runs before body, bearer, DB and budget;
- an arm is claimed once;
- the receipt is one-use, and the exact received values are compared structurally;
- faults latch before settlement, and the journal is written before collection;
- D6 clock isolation holds;
- Ask behaviour is unchanged outside bridge mode.

The full PG suite passes 764/764.

**F1 is blocking.** A provider key can resolve in the bridge server: Prisma loads the checkout `.env` into S's `process.env`, and
the production resolver reads `process.env` at dispatch time. The "no key, never dispatched" evidence comes from a `fixture://`
secretRef, not from S's environment.

Six findings are required (P2):
- F2: S marks a case seen only after its DB read.
- F3: the publication slot can be evicted, and a TRANSFER can carry another arm's READY.
- F4: the 2 s deadline and the 120 s raw expiry are not enforced at TRANSFER and ACK.
- F5: raw values can outlive revocation and the 120 s bound.
- F6: RESPONSE skips the policy and fixture checks, and the pair revokes on nothing but END_PAIR, losing its handoff connection or timing out.
- F7: NB7, NB9 and NB10 are neither met nor allocated.

## 1. Artifact identity (recomputed)

- **Manifest.** `S5ASKREMOTE_REVAL_RSCA_RC1_MANIFEST.json` sha256 is `5456b30f…e1d477`: **matches**.
- **packageHash.** Recomputed `73b7c693…0e76ee` with the manifest rule (sorted `path\tsha256\n` over changed+added) from both the
  working tree and the manifest entries: **matches**.
- **Changed/added sets.** Recomputed from `git ls-files -co --exclude-standard` (HEAD `916a4d69…`) against the baseline: 25 changed,
  31 added, 0 removed. These are exactly the manifest sets, and every baseline and current hash matches.
  - Excluded paths present: the baseline, `…_RC1_CHECKS.json`, `…_RC1_MANIFEST.json` and the 15 evidence logs.
- **Baseline.**
  - sha256 `014edb58…f17732` equals `baselineFileSha256`. It lists itself as `e3b0c442…` (the empty-file hash, as expected).
  - All 43 RS-B rc2 manifest entries match the baseline, after applying the seal's 3 administrative deltas. So the baseline is
    the accepted RS-B state.
- **Checks receipt.** sha256 `cbe6db2f…`. All 15 log hashes match `…_RC1_CHECKS.json`.
- **Build.** A fresh `npm run api:build` of the package in the copy gives a `dist/` identical to the repository's (`diff -rq`).
  The only difference is the RS-A helper binary `dist/native/reval-peer`, which is not a build output.
- **Diffs reviewed.**
  - Baselines of `ask-http.ts`, `main.ts`, `bridge.ts`, `server-link.ts`, `budget.ts`, `remote/db.ts` and `remote/service.ts` were
    recovered byte-exact from earlier package zips; `db/ask-remote.ts` from an RS-A historical view.
  - `codes.ts`, `controller.ts` and `owner-cli.ts` were diffed against RS-A rc3.
  - The rest was read in full.
- **File times.** Only `tests/pg/reval-eval-handoff.pg.test.ts` and the report changed after the evidence `test:pg` run, as the report says.

## 2. Findings

### F1 — P1 BLOCKING — A provider key can resolve in bridge mode, and the evidence for the contrary is misattributed

**Where:**
- Bridge S composes the production seams: `apps/api/src/main.ts:40` → `apps/api/src/db/ask-remote.ts:44` (`productionSeams()`).
- The resolver reads `process.env` at dispatch time: `packages/ask/remote/secret.ts:18`.
- `new PrismaClient(...)` (`apps/api/src/db/database.ts:17`) loads the checkout `.env` into `process.env`
  (`schemaEnvPath "../../../.env"`, `node_modules/.prisma/client/index.js:916-918`).
- `bridge.ts:33-37` already notes this `.env` loading, but only for URL, Ask and UI flags.

**Evidence:**
1. Probe 1: started with S's exact launch env (`ATLAS_MODE`, `ATLAS_API_PORT`, `ATLAS_REVAL_BRIDGE_FD`).
   - After the runtime PrismaClient is constructed, `process.env` gains the checkout `.env` names `ATLAS_APP_DB_PASSWORD`,
     `ATLAS_DEMO_TOKEN`, `ATLAS_OPERATOR_TOKEN`, `ATLAS_PG_ADMIN_URL`, `ATLAS_RUNTIME_DATABASE_URL` and `DATABASE_URL`.
   - Only names were printed.
2. Probe 2: a temp layout with a synthetic `.env` that holds only `ATLAS_ASK_REMOTE_PROBE_KEY`.
   - `productionSeams().resolveSecret('env://ATLAS_ASK_REMOTE_PROBE_KEY')` is `false` before the runtime PrismaClient and
     **`true` after it**.
   - The launch env holds no key.
3. The "no key, never dispatched" evidence does not test S's environment:
   - Claimed in `reval-native-rsc.pg.test.ts:24-28`, report §4/§6, `RUNBOOK.md:670-671` and brief:7.
   - It actually comes from the sandbox policy secretRef `fixture://ask-remote/synthetic-key-ref`
     (`tests/support/ask-remote-pg.ts:57`, via `reval-fixture-pg.ts:32`).
   - `fixture://` never resolves in production, whatever S's environment holds.
   - A real admitted policy uses `env://ATLAS_ASK_REMOTE_<NAME>` (`RUNBOOK.md:529`; the SQL CHECK allows it).

**Impact:**
- Suppose the owner activates an `env://` evaluation policy, and a matching line exists in the checkout `.env` (for example one left
  from ordinary REMOTE work).
- Then one armed manual click sends a real, paid request through the direct transport.
- That is an implicit, unreviewed key pass-through, which the pending owner decision forbids. No RS-D egress containment exists yet.

**Required fix:**
- In bridge mode, compose the remote module with seams whose resolver can never resolve (fixed `null`), or that read only the
  frozen `LAUNCH_ENV` snapshot, until the owner decides.
- Add a regression test: an `env://ATLAS_ASK_REMOTE_*` policy with that key present in `process.env` after DB connect must give
  `NO_DISPATCH` (KEY), and the transport must never be invoked.
- Correct the claims in the brief, report, RUNBOOK and test comment.

### F2 — P2 — S marks the case seen only AFTER its DB read

**Norm:** 04 First-current-GO table, row S: "mark that case seen/current BEFORE arm creation … even if the first arm failed".
05 "First arm": "C/S mark seen before fallible checks".

**Where:** `packages/reval/eval-runtime.ts:88-94`. `currentFacts()` is a DB transaction of up to 2 s. If it fails, `armCase`
returns `ARM_UNAVAILABLE` before `state.armCase()` marks the case (`eval-state.ts:112-113`).

**Evidence:** probe A (built composition, Docker PG17).
- The owner holds `ACCESS EXCLUSIVE` on `RevalFixtureBinding`: `armCase('case-probe-a')` returns `ARM_UNAVAILABLE`.
- After the lock is released, the SAME caseId gives `ARM_ACK` — a second arm allocation for a case S had already received.
- The unit test covers only the pure `state.armCase`.

**Required fix:** mark seen/current in the runtime before the DB read, and test it with a failing fact read.

### F3 — P2 — The publication slot is evicted or reassigned, and a TRANSFER can echo another arm's READY

**Norm:**
- 04: "Reject rather than evict/reassign an occupied slot".
- 06 TRANSFER: "challenge/readySequence echo I's READY; Binding matches every READY field".

**Where:**
- `eval-state.ts:114-128`: `armCase` ignores the slot.
- `eval-state.ts:144-151`: `claim` overwrites `#slot`.
- `eval-runtime.ts:116-131`: `respond` takes `readyChallenge` and `readySequence` from the CURRENT arm, and never checks
  `arm.ack.armId === slot.armId`.

**Evidence:**
- Probe B: case 1 answered (slot `AVAILABLE`), its final observation collected, arm 2 created and READY.
  - The RESPONSE for case 1 produced a TRANSFER with `binding.armId` = arm 1, but `challenge` and `readySequence` = arm 2's
    READY (true/true).
  - S then COMMITted.
- Probe B2: the claim for arm 2 replaced the `AVAILABLE` slot. Case 1's RESPONSE then got `503 RAW_EXPIRED`.

**Required fix:**
- Refuse ARM_CASE (or the claim) while the slot is non-terminal (`AVAILABLE`/`CLAIMED`/`TRANSFER_SENT`/`ACK_VALIDATED`).
  Alternatively, specify and test an explicit burn with a fixed code.
- Bind the READY tuple to the slot's own arm, and fail the transfer on any difference.

### F4 — P2 — TRANSFER is sent after the 2 s deadline, and S COMMITs after the 120 s raw expiry

**Norm:**
- 04: "Independent 2s handoff receive/validation/IPC deadline".
- 06: "accepts a matching ACK only while the pair/current transfer is still valid … No fresh deadline"; COMMIT `FAILED RAW_EXPIRED`.

**Where:**
- `eval-handoff-route.ts:62,70,92-96`:
  - the deadline is checked only on the PAIR path (`:86`);
  - on RESPONSE, neither the body read nor `handoffAuthority` is bounded by the deadline;
  - `respond()` runs even after the deadline has passed.
- `eval-runtime.ts:119-134`: the nonce is claimed and TRANSFER sent without a deadline check.
- `eval-runtime.ts:139`: `live` ignores `slot.state`. A lazily burned slot is still `=== slot`, and `:150` overwrites `BURNED` with `COMMITTED`.

**Evidence:**
- Probe C: headers sent first, body sent at +2.5 s. I received `RevalTransientTransferV1` at +2528 ms; the browser got `504 DEADLINE`.
- Probe E (unit test, injected clock): POST at ingress+119 s, ACK at +120.5 s (inside the 2 s deadline). Result: `respond=null`,
  `COMMIT COMMITTED`, slot `COMMITTED` after the raw expiry.

**Required fix:**
- Check the deadline and pair/slot validity before the nonce claim and before TRANSFER.
- Bound the body read and the authority check by the remaining time.
- At ACK, require `slot.state === 'TRANSFER_SENT'` and an unexpired slot; otherwise send COMMIT FAILED with `RAW_EXPIRED` or `ACK_TIMEOUT`.
- Add tests.

### F5 — P2 — Raw values can outlive revocation and the 120 s bound

**Norm:** 04: "Drop references on … server-observed revocation … or at120s from Ask ingress … Timer uses real monotonic time".

**Where:**
- `eval-gate.ts:108-124`: `#authenticated` and `#request` write the binding and the raw request into the slot without requiring `BOUND`.
- `eval-state.ts:52-65,72`: expiry runs only inside the `pair`/`arm`/`slot` getters. There is no timer, and a `BURNED` slot is never cleared again.

**Evidence:** probe D.
- `ApiToken` is locked, so the claimed task waits in authentication.
- END_PAIR then burns the slot (`BURNED`, request `null`).
- After the unlock the task continues and answers 200 with no receipt.
- The slot stays `BURNED`, with `rawRequestRetained=true` and `containsQuestion=true`. It remains until a later claim replaces the slot.
- Separately, an idle server keeps an `AVAILABLE` slot's raw request and answer past 120 s, until the next state access.

**Required fix:**
- Write into the slot only while `BOUND`; otherwise drop the values.
- Drop raw references with a real monotonic timer at 120 s.
- Add tests.

### F6 — P2 — RESPONSE skips the policy and fixture checks, and the pair has no credential, policy or authority revocation

**Norm:**
- 04 RESPONSE: "repeats the bounded current all-of/credential/actor/scope/policy/fixture checks".
- 04 pair: "revoked on pause/fixture generation/credential/actor/scope/policy change".
- 04: the arm window is capped by "pair/credential/policy expiry".

**Where:**
- `eval-handoff-route.ts:92-96` with `eval-db.ts:67-84`: `handoffAuthority` checks token, actor and membership only.
- `eval-state.ts:22-27`: `PairRecord` binds no credential digest or epoch and no policy tuple.
- Route `:95`: a detected authority denial only burns the slot; the pair stays `PAIRED`.
- Brief §3 claims revocation is "detected at use".

**Evidence:**
- Probe F1: the policy was set `PAUSED` after the answer was published. The RESPONSE still went TRANSFER → COMMIT, browser 204.
- Probe F2: a second current token of the registered actor (not the PAIR bearer) was accepted for RESPONSE, browser 204.
- The arm window omits the credential expiry.

**Required fix:**
- On RESPONSE, re-check that the arm's admission and `policyVersion` are still ACTIVE and that the fixture generation is unchanged.
- Bind the pair to its pairing credential (digest or epoch).
- On any change listed in 04 that is detected at use, revoke the pair (not just the slot).
- Add tests.

### F7 — P2 — NB9, NB10 and NB7 are neither met nor allocated, and C has no arm-phase failure state

**Norm:**
- The design seal's `futureBriefObligations` bind the RS-C briefs: NB7 (measure journal fsync, POST→COMMIT and ARM/READY),
  NB9 (arm-phase failure run state, fence-first closure, POST census, explicit owner resume, no automatic continuation) and
  NB10 (post-authentication registration-mismatch audit semantics, tested).
- 04: an ARM/READY failure "stops that run"; the active marker retires only after completion, terminal collection and POST census.
- 04 also requires the consecutive ARM/READY rehearsal with injected failures.

**Where:**
- Brief §1/§5 and report §6 do not mention NB7, NB9, NB10 or the rehearsal.
- `eval-controller.ts:104-128`: after consumption, every ARM failure (S `FAILURE`, `IPC_LOST`, PRE/case/pair) returns a code while
  `arming` stays true.
- `eval-controller.ts:109,126`: C's active case retires at the arm's `expiresAt`. A case claimed late in its window can still be
  running when C admits, and so consumes, the next case at C and S.
- `eval-gate.ts:104-107`: a post-authentication mismatch only increments a guard counter. No audit row is written. This is an
  undocumented NB10 choice; the test checks only the counter.

**Evidence:** the unit test "ARM while another case is active …" re-admits case-b 27 s later with no terminal collection.

**Required fix:**
- Implement, or explicitly allocate with the owner, NB9: stop arming after any failure or expiry after consumption, until
  closure/census and an explicit owner resume; retire C's active marker only after completion and collection.
- Document the guard-count-only NB10 semantics and test that no audit row is written.
- Name the part that delivers NB7 and the ARM/READY rehearsal.

### Optional (P3)

**F8 — C forwards unvalidated server responses.**
- `eval-controller.ts:31-32`: `asResult` forwards any non-FAILURE kind.
- `eval-controller.ts:79`: END_PAIR has no kind or payload check.
- `eval-controller.ts:65`: the FAILURE payload is cast without validation.
- `eval-controller.ts:87-92`, TERMINAL_OBSERVATION:
  - the kind is not checked;
  - a schema-invalid payload is recorded as `METADATA_PERSIST_FAILED` and disables the journal for good;
  - `binding` is not compared with the requested `armId`, `registrationId` or `serverBootId`.
- 06 says "C rejects producer/kind mismatches before forwarding" and "every consumer compares it with its independent registered mapping".

**F9 — Journal durability.** `eval-journal.ts:23-35`:
- a short write leaves a torn line that is not truncated;
- the directory is not fsynced when the file is created;
- `fsync` on macOS is not `F_FULLFSYNC`.
NB7 asks for measured fsync/rename.

**F10 — Evaluation hooks in the accepted financial flow are not exception-isolated.**
- `service.ts:94`: a throwing settlement callback becomes an unhandled rejection.
- `service.ts:123,164-166`: a throwing fault or reservation hook would skip settlement and pause.
- 06: "Its failure cannot disable the required circuit/pause". Wrap the hooks in try/catch.

**F11 — The evaluation header is silently ignored outside the gate.**
- 04:203-206 says the header on "an enabled Ask outside the registered scope" is 400, "never silently ignored", and is
  "forbidden on capability/other methods/routes".
- On ordinary (non-bridge) MOCK/REMOTE servers there is no gate, so the header is ignored (`ask-http.ts:165`). Non-Ask routes of
  the bridge also ignore it.
- This conflicts with "unchanged outside bridge mode". Record the intended reading, or add a header-only 400.

**F12 — Hardening.**
- Nonce and token comparisons are not constant-time (`eval-state.ts:89,146,155`; `eval-runtime.ts:118`).
- `decodeReady` accepts any string `caseId` (`eval-transient.ts:32`).
- The C and S seen sets accept caseIds outside the corpus, although 04 bounds them by the 200 frozen IDs.

**F13 — N3 is still fragile under parallel load.** I ran 4 PG files in parallel. The rc1 test "generation change while V runs"
returned `FAILURE FIXTURE_MISMATCH` instead of `OK` (generation 2) on its second check. Three isolated runs passed 9/9 each.
It fails closed; the cause is a V timeout that is misattributed.

## 3. Confirmed

**Ingress (04 pipeline).**
- The gate runs synchronously after classification and before the budget owner, body, bearer and DB (`ask-http.ts:165-173`).
- Request checks (header only):
  - exact single 43-character Token, Host/Origin `127.0.0.1:<port>`, `Sec-Fetch-Site: same-origin`;
  - no query, JSON media type, no encoding, declared length ≤16 KiB.
- Header outcomes:
  - capability or foreign-scope request with the header → 400;
  - registered scope without the header → 503 `ASK_REMOTE_NOT_ADMITTED`, counted;
  - malformed or duplicated header → 400, counted;
  - a duplicate submit → integrity stop.
- After a claim, `ASK_BUSY` consumes the arm. Encoded and case aliases are classified the same way (`askTarget`).
- The PG test sends headers only and never the body; that confirms nothing is read.

**Claim, scope and focus.**
- One claim: `READY → CLAIMED` is synchronous. The PG race gives exactly one 200, one 503 and one provider call.
- A foreign bearer with a stolen token → 403 before phase1, with no Binding or observation.
- A focus mismatch → 400 before phase1.
- The exact received wire body is captured.

**Handoff and transfer.**
- The receipt is minted only for a bound publication with a captured request, and is one-use. Concurrent RESPONSEs give one transfer.
- Edited or swapped DTOs → `CONTENT_MISMATCH` with no TRANSFER.
- Origin, Fetch-Metadata, session token and bearer are checked before comparison. Fatal UTF-8, duplicate-key rejection and the
  1/288 KiB caps hold.
- A forged ACK → `ACK_INVALID` with no COMMIT. A REJECTED ACK → COMMIT FAILED. A late ACK is dropped.
- Losing I → `IPC_LOST` and the pair is revoked. A sequence gap closes the connection.

**Terminal observation and journal.**
- A Binding exists only after the registered-scope check.
- The fault latches synchronously after the circuit trip and before settlement (PG order test), and `detectedAt` latches.
- Revisions change only on state changes. Overflow past 16 is a sticky coverage failure. `final` = release + a terminal publication.
- Retention follows collection, with a 10-minute sticky limit.
- C journals the record before sending OBSERVATION_COLLECTED. A save failure stops arming.

**Peers, secrets and schemas.**
- Both sockets prove the peer with the pinned helper: TTY, euid, exe and excluded pids. A peer without a TTY is refused.
- The pairing nonce appears only in the two private frames and O's TTY line.
- The new modules have no logging. Journal and transcript assertions hold, and observations carry no raw value.
- Every new contractVersion is decoded as a closed schema. The 06 direction table and payload schemas are exact.

**D6, compatibility and RS-B carried items.**
- D6: the pinned reference reaches only `readResources` (`read.ts:201`). The generation is re-read at egress and at phase2.
  `generatedAt` and the ledger day stay real time (PG test).
- Outside bridge mode, every hook is optional or null. The new settlement error subtype is swallowed by its only caller. The RC5
  guard drift is exactly the enumerated deltas.
- Carried RS-B items:
  - N1: three tests that each fail on their mutation per the receipt; I re-ran them passing.
  - N3: changes in place (see F13).
  - N4: listener test.
  - D6: as above.
  - F5: carried as a residual.
- Files stay within budget: the largest new file has 181 lines, and context-budget passes.

## 4. Commands and results

| Command | Result |
|---|---|
| Identity script (`python3 -I`, git ls-files, baseline, RS-B manifest, RC4 01–06 manifest) | all match (§1) |
| `npm run api:build` in the copy + `diff -rq dist` | identical to the repo's `dist/` |
| `npm run typecheck` | pass |
| `node --experimental-strip-types --test tests/reval-*.test.ts` | 76: 75 pass, 1 skipped (historical-view env) |
| `npm test` | 545: 535 pass, 1 skipped, 9 fail = the 8 RC5 identity-only failures plus the known `reval-payloads` "approved pricing" flake (random UUID containing `275`/`825`; 1 of 3 re-runs failed) |
| PG `reval-eval-{server,handoff,e2e}` + `reval-fixture-check` (4 files in parallel) | 22/23; the failure is F13 (isolated: 3 runs × 9/9) |
| Native chain `reval-native-rsc.pg.test.ts` | 1/1 (`503 ASK_REMOTE_UNAVAILABLE`, `NO_DISPATCH`; see F1 (c)) |
| Full `tests/pg/*.test.ts` with the native descriptor | **764/764** pass, 0 skipped (204 s) |
| Probes 1 and 2 (Prisma env; synthetic key resolution) | F1 |
| PG probes A, B, B2, C, D, F1, F2 (in-process built composition, Docker PG17; I and browser simulated) | 7/7 ran, confirming F2–F6 |
| Unit probe E (`EvaluationRuntime`, injected clock, fake link) | confirms F4 |
| `atlas*` database and role census, Docker and native, before vs after | unchanged |

`schema:validate`, `db:check:pg17`, `db:check:drift` and `api:smoke` were not re-run: the package changes no `prisma/` file.

## 5. Residuals and notes for later parts

**RS-C-A fix round.** Close F1–F7; F8–F13 are optional. Keep the RC5 guard enumeration exact.

**RS-C-B (instrument):**
- I must reject a TRANSFER whose binding differs from its READY (defence in depth for F3).
- I must own the consumed/currentGO markers, the GO window, and persistence of SafeResult and the summary.
- The T2 limit remains: the two sockets are proven separately and not tied to one I process across C and S, while 06 requires
  "the same I process".

**RS-C-C (browser and E2E):**
- The browser pane and the 04 generation table.
- 200 manual case paths including the 15 FX10 cases.
- NB7 latencies and the consecutive ARM/READY rehearsal with injected failures before and after consumption.

**RS-D:**
- PROCESS_CENSUS, DRAIN and the POST census. C currently retires a case without a POST census.
- Egress and privacy containment, independent of F1.
- S's environment also holds the owner/admin DB URLs from the checkout `.env`, via Prisma's dotenv.
- F5 (V runs TypeScript sources) and the RS-A pattern of verifying the helper once and then running it by path.

**Pre-existing items not touched:**
- The 11 known leftover `atlas_it_*` databases.
- Three `node dist/apps/api/src/main.js` processes (PIDs 48913, 48917, 48927) started at 00:38 local, before this review.

---

# Bounded re-review — S5ASKREMOTE-REVAL-SERVER-RSC-A-rc2

Same reviewer session, continued as the bounded repair re-review the role policy allows. Same review boundary and constraints
as above.
- The only repository change is this appended section.
- Probes ran in `/private/tmp/rsca-review-opus2/copy` (`node_modules` symlinked), which has been deleted.
- No network or provider call. Native cluster and Docker untouched.
- The `atlas*` database and role census of both servers is identical before and after. No test process was left running.

The three `main.js` processes noted above were the implementer's and have since been terminated; none remained during this
re-review. Date: 2026-10-12.

## Verdict (rc2)

Verdict: APPROVE_RS_C_A

- F1 (P1) is closed.
- All six required findings, F2–F7, are closed. I checked each in code, with my rc1 probes re-run against rc2, and with the new tests.
- F8–F13 (optional) are closed or addressed.
- Two new items are optional notes only (N1 and N2 below).

## R1. Artifact identity (recomputed)

- **Manifest.** `S5ASKREMOTE_REVAL_RSCA_RC2_MANIFEST.json` sha256 is `8f33b636…9e8b1b`: **matches**.
- **packageHash.** `1825c86d…f7a0dc`, recomputed from the working tree and from the manifest entries: **matches**.
- **Changed/added sets.** Against the unchanged baseline (`014edb58…`): 26 changed, 33 added, 0 removed. These equal the manifest
  sets, and all hashes match.
- **rc1 → rc2 delta.** Exactly the 25 changed files and 3 new package files listed in the request. Nothing was dropped.
- **History unchanged.** The rc1 manifest (`5456b30f…`) and rc1 receipt are unchanged.
- **Checks receipt.** sha256 `a1e76e8f…f3cf`. All 12 log hashes match.
- **Build.** A fresh `npm run api:build` of rc2 in the copy gives a `dist/` identical to the repository's (apart from the RS-A
  helper binary). The built `dist/apps/api/src/main.js:43` composes `bridgeRemoteSeams()` in bridge mode.

## R2. Status of the rc1 findings

| ID | Status | Evidence |
|---|---|---|
| F1 P1 key resolvable in bridge mode | **CLOSED** | `bridgeRemoteSeams()` (`apps/api/src/reval/evaluation.ts`: resolver always `null`, transport throws) is wired in bridge mode only (`main.ts`, and the built `main.js:43`). PG test "rc2 F1": an `env://` policy with the key present in `process.env` stays `NO_DISPATCH`, while the control check shows the ordinary production resolver WOULD resolve it. The brief, report, RUNBOOK and native-test claims are corrected. |
| F2 S seen after DB read | **CLOSED** | Probe A2 (same lock as A): first call `ARM_UNAVAILABLE`, the SAME case then `CASE_CONSUMED` (rc1 had returned `ARM_ACK`). |
| F3 slot eviction / foreign READY | **CLOSED** | Probe B3: arm 2 is refused with `ARM_UNAVAILABLE` while case 1's slot is `AVAILABLE`. Case 1's TRANSFER echoes its OWN READY (`readySequence`/binding true). After COMMIT the next arm gives `ARM_ACK`. |
| F4 deadline / raw expiry at TRANSFER and ACK | **CLOSED** | Probe C2: body sent at +2.5 s → `504 DEADLINE`, no TRANSFER, slot still `AVAILABLE`. Probe E2 (ACK at ingress+120.5 s): `RAW_EXPIRED`, COMMIT `FAILED`/`RAW_EXPIRED`, slot `BURNED`, raw values dropped. |
| F5 raw values outlive the bound | **CLOSED** | Probe D2: END_PAIR during authentication → slot `BURNED`, `rawRetained=false`. Real `setTimeout` timers are scheduled at install, pair, arm and claim. A timer probe I wrote: 12/12 fire after the monotonic deadline, even when the scheduling call comes 20 ms into a busy loop iteration. |
| F6 RESPONSE rechecks / pair revocation | **CLOSED** | The pair is bound to the credential digest, admission, policy version, generation and credential expiry. RESPONSE and ARM re-check and revoke the pair. Probe F1b: paused policy → `503 ADMISSION_NOT_ACTIVE`, no TRANSFER, pair `ENDED`. Probe F2b: another token of the same actor → `PAIR_REVOKED`, no TRANSFER, pair `ENDED`. |
| F7 NB9/NB10/NB7 | **CLOSED** | Brief §6 specifies all three. C has a sticky stop state (`ARM_PHASE_FAILURE`/`ARM_EXPIRED_UNUSED`/`METADATA_PERSIST_FAILED`), and the active case retires only on a journaled FINAL record (controller tests, E2E). NB10 is guard-count-only and tested to write no `SecurityAuditEvent`. NB7 in my run: ARM 15 ms, READY 1 ms, POST→COMMIT 38 ms, terminal+fsync 29 ms (Docker seam). The ARM/READY rehearsal is allocated to RS-C-C. |
| F8 unvalidated forwards | CLOSED | `fromServer` checks kind and payload. The terminal binding must be the requested arm and registration/boot; a mismatch is `PROTOCOL_INVALID` and nothing is saved. |
| F9 journal durability | CLOSED | A failed append is truncated back, and a new file's directory is fsynced. `F_FULLFSYNC` is recorded as a residual. |
| F10 hook isolation | CLOSED | `observe()` wrappers in `service.ts` and `ask-http.ts`. The enforcement hooks still throw by design. |
| F11 header ignored | ADDRESSED | Reading recorded in brief §6: bridge-only fixed 400; ordinary servers unchanged. See N1. |
| F12 hardening | CLOSED | `sameSecret` uses `timingSafeEqual`. The READY `caseId` is a ScopeId. C and S admit only the 200 frozen IDs before marking. |
| F13 N3 under load | ADDRESSED | The test tolerates one fail-closed timeout but still forbids a stale success. My 4-file parallel run: 26/26. |

## R3. New items (optional)

**N1 — P3 — The F11 middleware also turns unrecognized routes and HEAD/OPTIONS on Ask paths into 400 when the header is present.**
- Probe G: `GET /does-not-exist` gives 400 with the header and 404 without it. `HEAD /ask/capabilities` gives 400 with the header
  and 404 without it.
- 04 says "ordinary unrecognized routes remain404".
- This is harmless, but it is inconsistent with that sentence. Optionally let unrecognized routes fall through to 404.

**N2 — P3/residual for RS-C-B — Sequencing trap between C's active marker and S's live slot.**
- C retires the active case on its FINAL record. S refuses a new arm while that case's publication slot is still live, i.e. until
  the handoff is COMMITTED or UNVERIFIED, or until 120 s after ingress.
- A GO in that gap consumes the next case at C and S and stops the run. That is fail-closed and allowed by 04, but costly.
- The RS-C-B instrument must not request GO until the previous handoff has ended or 120 s have passed. Optionally, C could keep a
  conservative marker (ARM_ACK + 26 s + 120 s).

**Note.** A handoff whose authority read returns `INTERNAL_FAILURE` (a DB error or deadline) also revokes the pair. That is
stricter than 04 and conservative; noted only.

## R4. Commands and results (rc2)

| Command | Result |
|---|---|
| Identity script (manifest sets, hashes, packageHash, rc1→rc2 delta, receipt logs) | all match |
| `npm run api:build` in the copy + `diff -rq dist` | identical |
| `npm run typecheck` | pass |
| `node --test tests/reval-*.test.ts` | 85: 84 pass, 1 skipped |
| `npm test` | 554: 545 pass, 1 skipped, 8 fail = the same RC5 identity-only set |
| Full `tests/pg/*.test.ts` with the native descriptor | **767/767** pass (206 s), including the native chain (`NO_DISPATCH` via the no-key seams) |
| PG `reval-eval-{server,handoff,e2e}` + `reval-fixture-check` (4 files in parallel) | 26/26 |
| Probes A2, B3, C2, D2, F1b, F2b, G (built composition, Docker PG17) | as in R2/R3 |
| Probe E2 (`EvaluationRuntime`, injected clock) | as in R2 |
| Timer probe (real `setTimeout` against `performance.now()`) | 12/12 fire after the deadline |
| `atlas*` database and role census, before vs after; leftover processes | unchanged; none |

`schema:validate`, `db:check:pg17`, `db:check:drift` and `api:smoke` were not re-run: no `prisma/` file changed.

## R5. Residuals carried forward

These are unchanged from §5 above, plus N2:
- T2: the two instrument sockets are not proven to be the same I process. RS-C-B/RS-D.
- S's process environment still receives checkout `.env` names through Prisma's dotenv. Harmless for keys now, but it holds the
  owner/admin DB URLs (RS-D).
- macOS `F_FULLFSYNC` is not available, so journal durability across power loss is not claimed.
- POST census (RS-D) before a case retires.
- The 200-path E2E, the ARM/READY rehearsal and the target-platform NB7 numbers (RS-C-C).
- Instrument run state and summaries (RS-C-B).
- The known `reval-payloads` "approved pricing" flake and the 8 RC5 identity-only failures.
- No paid or provider call, activation, account, data or budget admission is implied by this acceptance.
