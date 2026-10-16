# R-EVAL server stage RS-A — implementation report, RC2 (independent-code-review repair)

- **Author session:** native Claude Code `claude-opus-5-5`, effort **medium**, the same session `642adc68-1d33-4c80-be48-6c8135833222`.
- **Constraints:** no subagents or other models; no API, credits, fast mode or fallback. **Paid product calls 0, activation false.** No provider, customer, account, deploy or commit actions.
- **Governing documents (unchanged):**
  - SERVER-DESIGN-rc4 `9fa16222…8163`.
  - BRIEF rc4 package `e8f87336…f85040`: `IMPLEMENTATION_BRIEF.md` `caa8a5b4…`, `ACCEPTANCE_CHECKS.md` `5b2b3062…`.
  - `VERIFICATION_ADDENDUM.md` `59c2fd7f…99dc`.
  - The 8 RC4 norms, 120 RC5 files and six overlays are untouched.
- **Inputs:**
  - `docs/stage5/reviews/SOL_S5ASKREMOTE_REVAL_RSA_RC1.md` (`eaf344df…`) and `OPUS_S5ASKREMOTE_REVAL_RSA_RC1.md` (`6def7f09…`).
  - Root resolutions `verification/stage5/S5ASKREMOTE_REVAL_RSA_REVIEW_RESOLUTIONS.json` (`2b5a3feb…`, root-owned, not edited).
- **Source identity:** HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `codex/reval-server-contracts-20261011`, uncommitted tree. Final identities (`checks/rc2/identity.py`):
  - source inventory `866be88eaf95578f70c48120030b2b2f7e011ee7950e2adcd13ae8cfd64e6ecf` (1677 files; includes root's admin-only verification updates made while I was stopped);
  - build inventory `a20cc144158a597d405214a6511e89f968c5b7c51f602c01b3fad021856532df` (268 files);
  - the identical values were recorded before final5, before and after its paired unit run, and after the repro.
- **Node / databases:** Node v25.8.1; Docker PostgreSQL 17 (test admin); native PostgreSQL 17.11 fixture (required; ran).
- **Status:** RC2 is ready for a bounded re-review of THIS artifact. I make no self-acceptance, and neither RC1 review counts as approval.

## 0. Provenance

- **RC1:** frozen package `1f5cd250970daab57b5004ce291abe04d4ef42961c57450d6a15ac2fcea0a05c`, archived by root. Its report and CHECKS are preserved:
  - `checks/rc2/IMPLEMENTATION_REPORT.rc1-rev2.md` `aed0d18d…`;
  - `checks/rc2/IMPLEMENTATION_CHECKS.rc1-rev2.json` `02d49195…`;
  - earlier revisions in `checks/repair/`.
- **Ownership:** returned after phase 77345 (exit 0); root transferred it back for this repair.
- **New evidence:** all of it is under `/tmp/atlas-reval-rsa/checks/rc2/`.
  - `focus/`: focused runs while fixing.
  - `probes/`: platform probes and the reviewer appendices.
  - `mutation/`: mutation checks.
  - `final/`, `final2/`, `final3/`: superseded full runs; `final4/`: interrupted (root SIGINT), partial, preserved.
  - `final5/`: THE final run, with its `repro.log`, `manifest.out`, `rc1-to-current-delta.json` and `identity-{pre,post}.json`.
  - Tools: `identity.py`, `unit-paired.sh`, `repro.sh`, `run-final5.sh`. The older `repro.log`/`manifest.out`/`rc1-to-rc2-delta.json` at the top level are final3-era and superseded.
## 1. Finding → fix → test (both RC1 reviews; every required finding)

### Sol R1 / Opus obs. 1–2 (P1) — one absolute deadline per operation

**Fix.** New `packages/reval/deadline.ts` provides `bounded()` and `DeadlineExceeded`.
- **One deadline:** every awaited step of an operation is bounded by ONE absolute instant, `received + 1800 ms`.
  - This covers startup steps 3–5 (digests, initial physical binding, startup wrapper), reconnects, the IDENTITY recheck, S's identity proof, the reread and E's peer proof.
  - A late value is disposed: a late reader client is destroyed and never assigned.
- **Physical binding** (`physical.ts`):
  - steps 1–6 share ONE `budgetMs`;
  - the connect timeout and the session `statement_timeout` are both set to the remaining budget, so a stalled backend is also cancelled server-side;
  - the client of a timed-out query is destroyed;
  - `recheckPhysical()` is bounded the same way.
- **Controller guard:** a per-operation guard answers just before 1800 ms with the operation's approved FAILURE, then releases the responder immediately:
  - startup → `DEADLINE` (sticky for the session; S is never launched);
  - IDENTITY → `IDENTITY_UNVERIFIED`, reader destroyed, S killed;
  - SNAPSHOT → `CENSUS_UNAVAILABLE`, reader destroyed;
  - PAUSE_EXPORT before its request → `DEADLINE`; after its request → `CONTAINMENT_UNCONFIRMED` + latch. E is killed and reaped in both cases.
- **Abandoned work** continues detached and can never respond, assign a reader, launch S or report success. Only the commit-uncertain latch can still be set.
- **EOF** cancels at once: reader destroyed, E killed, S stopped; bounded wait ≤ 500 ms, then exit.
- **Local exits** remain exactly 10/11/12, and only before the peer proof.

**Tests.**
- `tests/reval-deadline.test.ts`: real AF_UNIX pair to the real controller; O-side `checkResponse`. Covers:
  - initial-binding stall → `DEADLINE` < 1800 ms, sticky, and the late client destroyed;
  - reconnect stall → `CENSUS_UNAVAILABLE` < 1800 ms;
  - IDENTITY recheck stall → `IDENTITY_UNVERIFIED` < 1800 ms, with the reader destroyed and the real S child killed;
  - EOF during each of the three stalls → exit < 1.5 s, S stopped, late values disposed, no late S launch.
- `tests/reval-physical-peer.test.ts`: a stalled physical query rejects at its budget; the client is destroyed; `statement_timeout` ≤ budget; the recheck is bounded.
- `tests/pg/reval-launch-controls.pg.test.ts`: real PTY and real reader backends (`pg_sleep` stall seams on the real backend). Covers:
  - initial stall → `FAILURE DEADLINE` (C-authenticated, < 2 s, then a second answer, so O never timed out); no S; the stalled backend is gone;
  - recheck stall → `IDENTITY_UNVERIFIED` < 2 s (S killed); reconnect stall → `CENSUS_UNAVAILABLE` < 2 s; then recovery → `OK SNAPSHOT`;
  - O SIGKILLed during each of the initial and recheck stalls → C exits < 1.5 s, S stopped, backends gone, no late S.
- `tests/pg/reval-native-unix.pg.test.ts` (native PG17.11, production `verifyPhysicalEndpoint`): the physical query is blocked by an ACCESS EXCLUSIVE lock on `pg_database`, taken after the connection exists.
  - The verification rejects at exactly its 800 ms budget, and the statement is cancelled while the lock is still held.
  - The backend process disappears once the external lock is released. That teardown wait belongs to PostgreSQL (`checks/rc2/probes/native-lock-stall.log`).
- Sol appendix A rerun: `responseFrames: 1` (was 0).

### Sol R2 + Opus F3.1 (P1) — private channel phases on both endpoints

**Fix.** `Channel` gains a STRICT mode for the private C↔S and C↔E channels. Every frame must be solicited: a complete frame or ANY partial frame that arrives while no `next()` is waiting closes the channel with PROTOCOL. This happens synchronously inside the same `data` event, so before any continuation of an earlier frame can read a secret or connect.
- **S** exits 42 (and serves before closing its binding client, so a prompt C request is never unsolicited).
- **E** exits 22.
- **C** kills S on any violation (`ServerLink`).
- **`pauseExport`** handles a violation:
  - before its request → `IDENTITY_UNVERIFIED`, no request sent, no latch;
  - with or after the result → result rejected → `CONTAINMENT_UNCONFIRMED` + latch (commit may have happened).

No new wire field or nonce, and the peer proof is unchanged.

**Disclosed limit.** Phases are RECEIVE phases. A frame C wrote before it received HELLO is not distinguishable by S, because the launch frame carries no nonce by contract. E rejects any request that does not echo its own `helloNonce`.

**Tests** (`tests/reval-handshake.test.ts`).
- **Production S and E libraries** in real child processes with secret/connect spies:
  - controls: one frame → `READ_SECRET`, `CONNECT`;
  - coalesced duplicate, fragmented duplicate, wrong-phase frame and missing frame → protocol exit with ZERO spy calls;
  - duplicate while the secret read is pending → exit with `READ_SECRET` only, no connect;
  - E request without its nonce → 22, zero spies.
- **Scripted children toward the real `ServerLink` and `pauseExport`:**
  - missing HELLO, a frame before HELLO, or a duplicate HELLO → fail < 1.5 s, and the child receives NOTHING;
  - duplicate executor result → `CONTAINMENT_UNCONFIRMED` + latch, with exactly one request sent.
- Sol appendix B rerun: S exit 42 / E exit 22, no spy output (was S 0 and E 20 with secret reads and connects).

### Sol R3 + Opus F2 (P2) — auth SQLSTATEs through the physical connector

**Fix.** `connectFailure()` keeps ONLY the SQLSTATE of a connect-time credential/role refusal (`PhysicalAuthError` 28P01/28000/42501). Every other connect error is `PhysicalMismatchError`, and no server text crosses. E maps:
- `PhysicalAuthError` → `OWNER_REQUIRED` (§6);
- physical mismatch → `REGISTRATION_MISMATCH`;
- `DeadlineExceeded` → `DEADLINE`.

`sqlStateOf` moved into `physical.ts` (re-exported).

**Tests.**
- **Unit:** 28P01/28000/42501 through `verifyPhysicalEndpoint` and `runOwnerExec` → `REFUSED OWNER_REQUIRED`, with no server-text sentinel; 3D000/57P03/ECONNREFUSED → mismatch.
- **Docker PG** (real E child, real peer proof, wrong owner password) → `OWNER_REQUIRED`:
  - no statement at all, policy and fence unchanged;
  - one spawn, no latch (a second call spawns again);
  - reaped, no owner backend within 1.5 s.
- **Native production chain** (production `owner-exec.ts` and connector): wrong owner password → `FAILURE OWNER_REQUIRED` ×2, policy and fence unchanged.
- Sol appendix C rerun (one field renamed `connectTimeoutMs`→`budgetMs`; adapted copy recorded): `OWNER_REQUIRED`.

### Opus F1 (P2) — byte cap and the one-sequence rule

**Fix.** `snapshotFitsEnvelope()` is a deterministic reader-level cap. It measures the would-be 06 SNAPSHOT response with every variable envelope field at its maximum (19-digit Dec64 sequences).
- `exportSnapshot` → `CENSUS_LIMIT_EXCEEDED` (never truncated).
- `pauseExport` applies the SAME measure to its single reread: over cap → null → `CONTAINMENT_UNCONFIRMED` + latch.
- The controller's `send()` takes exactly ONE sequence per response, and its oversize fallback reuses it.

**Tests.**
- Real controller and O validation: 700 attempts → sequence 1 `FAILURE CENSUS_LIMIT_EXCEEDED` accepted by O, then sequence 2 `SNAPSHOT` (continuity).
- Real `pauseExport` with scripted confirmed results:
  - reread 700 → latch;
  - control 10 → CLOSURE.
- **PG17 real 700-row ledger:**
  - snapshot: complete census returned, cap refuses export, and a control proves the frame really exceeds 256 KiB;
  - pause: real E, CONFIRMED commit (policy is PAUSED v+1), reread over cap → `CONTAINMENT_UNCONFIRMED` + latch; a small census closes.
- Opus repro `/tmp/rsa-review-scripts/seq_repro.ts` rerun: 700 → `FAILURE CENSUS_LIMIT_EXCEEDED`, `responseSequence 1`, `ownerCliCheck null`; 10 → SNAPSHOT.

### Sol R4 (P2) — isolated controls

**Physical (PTY).**
- Reader correct, but S directed to ANOTHER otherwise-ready database:
  - `OK SNAPSHOT` (the control is valid), IDENTITY never succeeds;
  - S is gone, and its port never listens.
- Forged `Bound.observed`: the same outcomes.
- E against ANOTHER physical database holding the COPIED registration/instance/workspace/client/actor/admission UUIDs:
  - the other database would pass the logical read (asserted);
  - the control reader is bound;
  - `REGISTRATION_MISMATCH` with NO statement, both policies untouched, one spawn, no latch.

**Guard.**
- **Real gap found and fixed.** PostgreSQL FKs are internal ORIGIN-mode triggers and do not fire under `session_replication_role = replica`. The probe (`checks/rc2/probes/fk-replica.log`) showed the owner, under replica, inserting a binding for an unknown registration and a registration with a foreign actor.
- The ALWAYS guard now re-checks the referenced rows on every INSERT:
  - a registration's scoped client, actor, policy and admission row;
  - a binding's exact registration and dataset.
- Those cases now give RV010 (`fk-replica-after.log`). The two RC1 FK assertions changed `23503` → `RV010`, because the BEFORE-row guard refuses ahead of the AFTER FK trigger.
- **New isolated test:** each defect alone against an accepted control, both as the owner and as the owner under replica. Covered: foreign actor, foreign admission, foreign client, own client without its admission row, mismatched dataset, unknown registration.
- **Binding identity:** registrationId/workspaceId immutable, equal or lower generation refused, DELETE and TRUNCATE refused; registration UPDATE/DELETE/TRUNCATE refused; all of these under replica too.
- **Controls:** a strictly advancing generation is accepted. The NOSUPERUSER owner cannot set replica (42501).
- One RC1 snapshot test that PLANTED a registration without its admission row via replica is now refused by the guard. It was re-planted the other way round (valid registration, then the admission row removed with the FK bypassed), still → RV001.

**Closure.** Already-PAUSED NO-OP with NONZERO microseconds:
- whole row identical;
- the routine was called;
- the last statement is a confirmed COMMIT;
- closure at the unchanged version and fence.

### Opus F3 remaining

- **F3.2 concurrent ops:** reserve / revoke / settle against an in-flight E, while it HOLDS the fence:
  - reserve and revoke wait for E's commit and are then refused;
  - settle proceeds (it needs no fence or policy lock);
  - the closure stays exact, and the closure's tuple is current.
- **F3.3 TOMBSTONE** (reached by real version exhaustion) → refused, no routine call, row unchanged.
- **F3.4 pricing** via the actual confined definer on PG17: 8 distinct tuples reported; a 9th → RV004.
- **F3.5 local exits** under a PTY with the actual controller exit recorded:
  - non-darwin → exit 10 / `LOCAL PLATFORM_UNVERIFIED`;
  - helper sha ≠ pin → 11 / `LOCAL IDENTITY_UNVERIFIED`;
  - O without TTY (parent proof) → 12 / `LOCAL IDENTITY_UNVERIFIED`;
  - no other line, no S, no secret read.
  - Unit: peer failures → 12 with no response frame.

### RC2 self-found — PTY harness teardown leak (test harness; disclosed)

**Found during RC2 cleanup:** 45 orphaned production O processes (`scripts/reval-server/owner.ts`, PPID 1), each with its detached C still alive.
- **Source:** every native NEGATIVE session (input ending without `quit`) since RC2 made those C answers authenticated FAILUREs and stay up.
- **Mechanism:**
  - such a session never ended by itself (the terminal end-of-input did not end O in this harness);
  - `PtySession.stop()` then SIGKILLed only the pty master (`/usr/bin/script`);
  - in this harness that did NOT hang O up.
- **Verification:**
  - bare-probe controls DO receive `end` + SIGHUP (`probes/tty-hangup*.log`);
  - the harness probe reproduced the miss (`probes/eof-session2.ts`): O alive 3 s after the master was killed;
  - an explicit SIGHUP ended O and its C (and the C's S/E) gracefully within 2 s.
- **My earlier process audits** (including the RC1 hand-back) used patterns (`node --experimental-strip-types`, `reval-test`) that cannot match the production entries' command lines, so they missed these. RC2's audit now matches `scripts/reval-server/`, all test entries, `dist/apps/api/src/main.js` and `/usr/bin/script`.

**Fix (tests only, no product change).**
- `PtySession.stop()` now SIGHUPs O (its graceful path), waits, SIGKILLs and REPORTS any survivor in the whole tree, then kills the master.
- Every PTY test asserts `forced: []`, i.e. no O/C/S/E survives any session.
- The native negatives end with `quit`.
- All 90 leaked processes were ended with SIGHUP (gracefully); none remain.

**Residual.** In this macOS harness, killing the pty master did not deliver a hangup to O. Production O relies on SIGHUP, end-of-input or `quit`, all of which work. A terminal emulator that is SIGKILLed without hangup could leave O and C running until a SIGHUP; that is disclosed, not hidden.

### Opus F4 — §10 paths (root classification recorded)

Root resolution `verification/stage5/S5ASKREMOTE_REVAL_RSA_REVIEW_RESOLUTIONS.json` (sha `2b5a3feb…`, root-owned, not edited):
- **5 focused internal production splits:** `packages/reval/{channel,config,deps,pause,server-link}.ts`.
- **4 focused RS-A-only test helpers:** `tests/support/{reval-nonsuper,reval-pg,reval-pty,reval-test-pause-entry}.ts`.
- **Bounded existing parity/invariant support:** `tests/support/poweroffice-envelope.ts`.

RC2 adds, under the same cohesive-focused-module rule, and records here for the reviewers:
- 1 production module: `packages/reval/deadline.ts`;
- test support: `tests/support/reval-{controller-harness,closure-harness,launch-harness,spy-child,scripted-child}.ts`;
- tests: `tests/reval-{deadline,handshake}.test.ts`, `tests/pg/reval-{controls,launch-controls}.pg.test.ts`.

All are ≤ 500 lines.

### Opus F5 — evidence renewal

The complete required suite ran on the FINAL repaired bytes (§2). It includes the paired unit record that root accepted as the causal record for TAP 76, pending both reviewers.

### Opus non-blocking observations

- **Obs. 1** (reader dirty after a reread failure): fixed. The reread drops and destroys the reader on any failure.
- **Obs. 2** (reconnect outside the deadline): fixed under R1.
- **Obs. 3** (E per-statement timeouts can add up past DE): unchanged and disclosed. It is the brief's formula; C's latch and the bound backend cleanup apply.
- **Obs. 4** (ancestor uid check): unchanged and disclosed. It is within the same-UID trust boundary.
- **Obs. 5–6:** test-scope notes, unchanged.

## 2. Verdict on evidence (final run `checks/rc2/final5/`, on the FINAL bytes)

| Check | Result |
|---|---|
| `typecheck`, `ui:typecheck`, `db:generate`, `schema:validate`, `db:check:drift`, `db:check:pg17`, `api:build` | all exit 0 |
| `test:pg` (Docker PG17 plus the REQUIRED native fixture) | **exit 0, 725/725**, 0 failed/skipped/cancelled |
| `test:ui` (Playwright) | **exit 0, 86 passed** |
| Unit, complete and unfiltered, `tests/*.test.ts` (87 files) | **exit 1 — QUALIFIED NONZERO**: 506 reported, 498 pass, 8 fail; all identity-only (§3) |
| RC5 files only (13 files, TAP + JUnit) | exit 1: 46 reported = 38 pass + 8 fail; per-name reconciliation exact (§3) |
| Historical RC5 (root FINAL proof, referenced, NOT rerun) | `HISTORICAL_RC5_FINAL_CHECKS.json` `d90892a8…c589`: 110/110 pass, 0 fail/skip/cancel/todo, 13 per-file inventories |

**This is not a green unit run.** The 8 failures are the unchanged RC5 execution files refusing on `CORPUS_IDENTITY_MISMATCH`, caused by the authorized RS-A source/build child deltas. No other unit test fails, and none is skipped or cancelled.

**Superseded full runs (reported for honesty; their source differed from the final bytes).**
- `final/` (`steps.tsv` `a9f6cf3c…`): everything as in final3, except `test:pg` was 724/725.
  - My new concurrency control detected "E idle in transaction" between E's early statements, before E held the fence. The concurrent reserve was then legitimately serialized first, and the closure stayed exact.
  - Fixed in the TEST: it now waits until E's last statement is its FOR UPDATE. 3/3 focused reruns passed.
- `final2/` (`steps.tsv` `2f6055ef…`): `test:pg` was 724/725.
  - Under the full ~60-file parallel load, E's spawn, HELLO and peer proof in the RC1 closure test "refusals / fence Int max" missed the approved request deadline (D−1200). My new bounded peer proof then wrongly reported that budget miss as `IDENTITY_UNVERIFIED`.
  - Fixed in `pause.ts`: a budget miss → `DEADLINE` (§6 table: "budget → DEADLINE"); an actual mismatch → `IDENTITY_UNVERIFIED`. The closure harness also now warms the helper as the production controller does.
  - The miss did not reproduce in two 8-file parallel load runs (46/46 each, `focus/load1-2`).
  - Process note: those load runs overlapped final2's last step (`test:ui`) and rebuilt `dist` meanwhile. final2's UI result is therefore not claimed.
- `final3/` (`steps.tsv` `e509c5c9…`): every step passed (`test:pg` 725/725, UI 86, unit identity-only). It is superseded because 4 test-harness files changed afterwards: `tests/support/reval-pty.ts` and `tests/pg/reval-{launch,launch-controls,native-unix}.pg.test.ts`.
  - The cause was the PTY teardown leak found during cleanup (§1).
  - Focused rerun of the 3 PTY files after the fix (`focus/pty-teardown.log` `2b7f1c3b…`): 12/12, every session `forced: []`.
- `final4/` (`steps.tsv` `ca5955d9…`): INTERRUPTED. Root sent SIGINT after `api-build`, with the unit step in flight. It is preserved as partial and claims nothing.
- `final5/`: the complete suite was run again, alone, on the exact current bytes. It is the result reported above. A process audit right after it found no O/C/S/E, test or `script` process.

## 3. Unit qualification — ONE paired record (`final5/unit-paired.log`, sha `a60e4c50…`)

The order within that single log is:
1. **Identities BEFORE:** source/build inventories, the 120 RC5 files against their manifest (all match), and the unchanged guard `{ok:false, drift:[RC_SOURCE_DRIFT, RC_BUILD_DRIFT]}`.
2. **The complete unfiltered TAP run:** 506 reported / 498 pass / 8 fail / 0 cancelled / 0 skipped / 0 todo.
3. **The direct child probe**, using the EXACT argv of `tests/ask-remote-eval-execution-pty.test.ts`: `<node execPath> --experimental-strip-types --no-warnings scripts/ask-remote-eval-execution/cli.ts session --receipt-dir <tmp>` under `/usr/bin/script`.
   - It prints the instrument banner, then `ExecError: CORPUS_IDENTITY_MISMATCH` (`bindCorpus` ← `loadContext` ← `interactive` operator.ts:100 ← `runOperatorSession` operator.ts:68 ← `main` cli.ts:59).
   - `PROBE_EXIT 1`, receipts 0.
4. **Identities AFTER:** byte-identical to BEFORE.

The 8 `not ok` entries:

| TAP id | File / test | Cause |
|---|---|---|
| 12, 13, 14, 16, 17, 18, 19 | module-load wrappers: `ask-remote-eval-execution-{cli,liability,operator,receipt,repair,replay,session}.test.ts` | each `ExecError: CORPUS_IDENTITY_MISMATCH` via `bindCorpus`/`loadContext` at module load |
| 76 | registered "real pty: kernel echo stays off …; Ctrl-C finalizes" | its own output is only `PTY_TEST_TIMEOUT step 1` |

**TAP 76 is NOT directly proven by its own output and is NOT counted as passing.** Root accepts the paired same-run probe above as the causal record, subject to both reviewers approving it on this RC2.

**Per-name reconciliation** (`final5/rc5-files.xml` `ad7381c8…` against the root FINAL proof's `perFileTestInventory`; `final5/rc5-reconcile.json` `2146e193…`):

| Category | Count |
|---|---|
| Executed and passing (corpus 7, fixtures 11, offline 5, supervisor 14, context-budget 1; names equal) | 38 |
| Executed and failing (pty, identity-caused, name equal) | 1 |
| Failed wrappers | 7 |
| Blocked, unregistered (cli 6, liability 27, operator 4, receipt 5, repair 13, replay 5, session 11) | 71 |
| Historical passed | 110 |

38 + 1 + 71 = 110. The 13 RC5 test files are byte-equal to their pins and to the historical view. The RS-A unit tests total 37: protocol 8, payloads 9, physical-peer 6, static 4, rc5-guard 2, deadline 5, handshake 3.

## 4. RC5 coupling (unchanged by RC2)

- The guard result is unchanged: drift exactly `RC_SOURCE_DRIFT`/`RC_BUILD_DRIFT`, with the same 14 source child deltas and the same 2 build deltas.
- RC2 touched no pinned R-C path. `dist/apps/api/src/main.js` `7137c74d…` and `dist/packages/graph/runtime-role.js` `a63c4723…` are unchanged.
- The six overlays are at their pins, and the 120 RC5 files are unchanged.
- Copied-view tampers (same run): source → `[RC_SOURCE_DRIFT]`; build → `[RC_BUILD_DRIFT]`; overlay → `[ADMIN_OVERLAY_DRIFT, OFFLINE_FILE_DRIFT, RC_SOURCE_DRIFT]`; the untampered copy → `{ok:true}`.
- The reviewers judge the classification of the 6 parity/invariant deltas. Opus RC1 §1 found them within bounded §10; root recorded `poweroffice-envelope.ts`.

## 5. Native production chain and timings (`final5/test-pg.log` `d7665cfd…`)

**Native fixture.**
- Descriptor `13de8799…`; PostgreSQL 17.11.
- Owner/runtime/reader: super false, bypassRls false. The owner is the dedicated NOSUPERUSER NOBYPASSRLS role that ran the migrations and the `roles.sql` non-superuser branch.
- Start equality: `1791720581` = `1791720581`.
- APPLIED and NO-OP closures; ref `rsa-peertoken-unixphys-v1`, `UNVERIFIED`.
- Socket, pid, start ±1 s and OID negatives → `FAILURE REGISTRATION_MISMATCH`.
- Wrong owner password → `FAILURE OWNER_REQUIRED` ×2, unchanged.
- Real catalog-lock stall: `DeadlineExceeded` after 803 ms (budget 800); the statement was cancelled ≤ 56 ms later with the lock still held; the backend was gone 0 ms after release.

**Docker launch.**
- `pg_stat_activity` cross-check: VERIFIED.
- Timings (PTY inter-arrival under full-suite load; regression only):
  - IDENTITY p50 5.7 ms / max 11.1 ms;
  - PAUSE_EXPORT p50 218.0 ms / max 277.1 ms;
  - all well within 1800 ms.

## 6. Reproducibility and hygiene (`checks/rc2/final5/repro.log` `ce62b0d7…`, run after final5)

- **Helper:** `9624a353768cfd528538c4c965ad462295da4f8124a17c6d9bc0118248a983c1` from two checkout builds and from the clean copy.
- **Clean production copy** (git ls-files minus dist/, node_modules symlinked, no network): `api:build` and `build-peer` both exit 0.
  - 203 dist JS files with inventory `1f7f4436…` in both checkout and copy.
  - Per-file equality covers `main.js`, `bridge.js`, `runtime-role.js` and `packages/reval/{controller,physical,channel,deadline,pause,server-link,owner-exec,snapshot-reader}.js`.
- **Whitespace:** `git diff --check` exit 0; no trailing whitespace.
- **Manifest** (`final5/manifest.out` `b0acce3e…`, refreshed after all fixes and tests): 14 changed baseline paths, none missing, RC5 delta `[]`.
- **File sizes:** every new RS-A file is ≤ 500 lines (largest: the migration, 297), except the byte-exact fixture `roles-s5remote.sql` (650).
- **The 1540-file baseline's unrelated dirty work** is untouched; the only baseline deltas are the 14 recorded in RC1.

## 7. Mutation evidence (temp copies only; `checks/rc2/mutation/mutation.final.log` `dd37ac4d…`)

| Mutation (undoes one repair) | Detected by |
|---|---|
| R1 guard removed | reval-deadline (initial stall) |
| R1 `bounded()` disabled | reval-deadline: the reconnect/recheck stall times out at 60 s and the EOF test fails; the process then hangs on live handles (killed) |
| R2 strict mode off | reval-handshake (2 tests) |
| R3 auth classification lost | reval-physical-peer |
| F1 reader cap disabled | reval-handshake (reread latch) |
| F1 fallback taking a 2nd sequence | NOT detected, because that oversize fallback is now unreachable: the reader-level cap refuses an over-cap census before `send()`. It remains defence-in-depth; the reachable one-sequence path is covered by the O-validated continuity test. |

The guard reference check was demonstrated before and after by `probes/fk-replica.log` (`29624894…`, owner under replica: OK/OK) and `fk-replica-after.log` (`0f17fb01…`: RV010/RV010).

## 8. Exact deltas and the final suite

### Final suite steps (`checks/rc2/final5/steps.tsv` `7aae85d2…`, runner `checks/rc2/run-final5.sh`)

| Step | Exit | Time | Log sha256 |
|---|---|---|---|
| typecheck | 0 | 9s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| ui-typecheck | 0 | 1s | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| db-generate | 0 | 1s | `7c37c2b57216cea71774ed4f5b09ae1a8389cc6c6b33a4be1480a41b37c65ccf` |
| schema-validate | 0 | 0s | `1fa1e06af31f866d939dcbc2f900483ed3ca80ed28d58c5071c0556790d7092f` |
| db-drift | 0 | 1s | `892b13f6d8d0c9be510e7746fe0a02fbdcdeb853749096fa335597962305d6a2` |
| db-pg17 | 0 | 1s | `3ba8dd0aae637f81e7e201c4b7ebb3b77e3928839ed2b161906033bb0c720919` |
| api-build | 0 | 4s | `a6aa931089b464f4c65e4a923b0460b903968733081bc2b5d7806e5f32081592` |
| unit-paired | 1 | 92s | `a60e4c500c3962a48295ab3a2ce1b294262e41b962451d7972f4a8647167b7cd` |
| rc5-files | 1 | 90s | `67275bf52bebbc3f0d23ad8701c3fa5a4b8c9e46534adafa4f4821deafbf211d` |
| test-pg | 0 | 220s | `d7665cfd11cf9bb6b065f06d3e91197a7ca875297b531d41c56ecd2cc8e60076` |
| test-ui | 0 | 128s | `b12f8422b7ef67df9d0c15c22a9c45dcfb4d724a872461c1817821a9bf5a0992` |

### RC1 → CURRENT exact delta (against root's frozen `S5ASKREMOTE_REVAL_RSA_RC1_MANIFEST.json`, packageHash `1f5cd250970daab57b5004ce291abe04d4ef42961c57450d6a15ac2fcea0a05c`; `final5/rc1-to-current-delta.json`)

My RS-A changes (36; missing none):

| Path | RC1 | Current | lines |
|---|---|---|---|
| `apps/api/src/reval/bridge.ts` | `6a73777c8ebcc7d5…` | `40369ed1b72d8f8c2fc58ccdcb76d261bf024428b8d54278ca715ea5bdfe319b` | 119 |
| `dist/apps/api/src/reval/bridge.js` | `4dced89b4da4b203…` | `b9de0c144b503f1326a91a1574812bdb922718ec3c48a04bf0e6a6bfacd8873b` | 139 |
| `dist/packages/reval/channel.js` | `092f80956b2426cc…` | `e370409b8ea88d07f9cf8a8adeb274b7cc51565a59a397c1a3d8a9f02f53db35` | 123 |
| `dist/packages/reval/controller.js` | `5d223fa0afbc1012…` | `14bfd7c1c7a5df4bcdad8e556756d3eecb19504f899b870f36082c74981af7e2` | 357 |
| `dist/packages/reval/deps.js` | `6573890bcdb58cf0…` | `8f159cac950527b2be0c6efdbf85b8fda14fff26dd95430ab6803bed995ae457` | 49 |
| `dist/packages/reval/frame.js` | `b08729ed5649cb30…` | `dfbd3fb704dbaa78ca49ce5bd57483094d091922c4fb4b586a25a35b549aced5` | 102 |
| `dist/packages/reval/owner-exec.js` | `ed7bd2bbf3c48f4a…` | `cab74fd06c71e4d81448133ba64ca5b651ddc4ad1749b847da18ce6a1937a403` | 168 |
| `dist/packages/reval/pause.js` | `c628ea63df5224fd…` | `36809e68e243074d56bad59219a9743028520112e06bb958b7856b3b866147b6` | 94 |
| `dist/packages/reval/physical.js` | `c735686b6d8b1ffc…` | `3b55b895cda4a449cdc592294c7b40595b16caa0e0f1c9ec3612680946bf92fc` | 129 |
| `dist/packages/reval/server-link.js` | `10af8742be0e6ee3…` | `541523a94d39909da56147f53a68ebfcb1ac65bd6c3b1592a2cb4c7ec08e16af` | 141 |
| `dist/packages/reval/snapshot-reader.js` | `7d42dab813b9b133…` | `a80e4146f86fdebfcb51bb38587746a4d6a525000b80134d73400f7cad26867a` | 112 |
| `packages/reval/AGENTS.md` | `7df14fd32498d7d2…` | `ae3619d426949bea1a3dd34faf41c1d15535f409e00f3ffbb0c067fd6fbf1648` | 13 |
| `packages/reval/channel.ts` | `a41f8c52e656537e…` | `76ed5e9527a3afa27b417eb013b93dc52cdf4c8a9b367e4072db56bf588f313a` | 83 |
| `packages/reval/controller.ts` | `b3fec5494b8da7cb…` | `9980b700bdb1c9ddc54e37ec2ffea7b44deb16f247512760218d200e6fa72d81` | 242 |
| `packages/reval/deps.ts` | `33ba93c2c9005dba…` | `eb7ebf87cd91c4f5fad328b281e90929f65a53fad21ab4ca2bfd062fd4922f19` | 72 |
| `packages/reval/frame.ts` | `a405e2cea2fa8a22…` | `1ff9a4e2ade4acf3569e3ba49154966d5d2ccc5c91321f5990464caad3b25873` | 78 |
| `packages/reval/owner-exec.ts` | `15d1384b3c1958d9…` | `4f4f9369ad2f91346e2b7b0ed5b35d5856279c286ece9092f46d5d7962ed6a74` | 149 |
| `packages/reval/pause.ts` | `043d0a54d38ae432…` | `71e7a8e3a868944c280e584a218678d3e7065b8e3a3be5f13d52b09eef8d8463` | 94 |
| `packages/reval/physical.ts` | `9b40f5e9fa1692e4…` | `1c1eef2bc7ffe37d2e174cb04c241a7c87b156683ec4c04eb78ca0a71717e8c3` | 134 |
| `packages/reval/server-link.ts` | `2f530f39442c1be8…` | `ead46701ac10cf7617875d4340c7a54322a45c54920bdc09c671c6c320c91a28` | 120 |
| `packages/reval/snapshot-reader.ts` | `59a27cab20e5a0fe…` | `806670058ed43294936af4eb7ab040f6c1c08237006043393e889c7b7e04fce9` | 92 |
| `prisma/migrations/202610131000_stage5_reval_registration/migration.sql` | `677aacd5406d0b3e…` | `88e02e08aaec83a86729e0ce23b8fe1b97972f644da5af16c1753df37ae48edb` | 297 |
| `scripts/reval-server/owner-exec.ts` | `6a331d2bb5c08d26…` | `e9a1566b6b37460affe87e2c5d4ce1afe43ffc415860e60a20a0af2a818b4f84` | 15 |
| `tests/pg/reval-closure.pg.test.ts` | `ef3451d3919271de…` | `20b7701f169ab4776c7766f3b0b515ac7c0d2948805df1d0ecbdf7e4fa1926a9` | 180 |
| `tests/pg/reval-launch.pg.test.ts` | `307a421004ccecbb…` | `caeae943dc19abdd2555de5b6b55d32b2f286e9da03692312e938e52dcab0771` | 204 |
| `tests/pg/reval-native-unix.pg.test.ts` | `8d0fac5a4bb73be1…` | `cb3043173282b8a2b107fbab8f9d11711f3966b5e4460b64c3d95b943dd2258d` | 168 |
| `tests/pg/reval-snapshot.pg.test.ts` | `d9775fc14537e86d…` | `57a49dfc676579af29c0cdb7fa740be53bb8e39c2d2284ef95ed99789db91b8b` | 254 |
| `tests/pg/reval-upgrade-guard.pg.test.ts` | `cf10cc30795b3a29…` | `f091420c8984e7e4c1424c097a5e0fbc3865be0cf1ad988ed6469d57c4eebe4a` | 154 |
| `tests/reval-physical-peer.test.ts` | `28c2fe5172bb473a…` | `caa77b214b5d7590a78fff5ef510713963c2ea6eac7a3a92a12cb16b8241137a` | 197 |
| `tests/support/reval-pg.ts` | `88f33dabb54f2ff3…` | `a6b455c6d2e338fe4916df109aecd29f90051c7259c7494bda767480ea57957d` | 78 |
| `tests/support/reval-pty.ts` | `23809abc1c1236bb…` | `7b4268f47ac6b4d4be89215ad6edb3e172e3649b0915f2085827129ee7e62a82` | 82 |
| `tests/support/reval-test-controller-entry.ts` | `e36598999bd62fc2…` | `2bd4211ee348dc2cb82f9343971454f9fe07755f99cd6d77de4d75826000db2d` | 81 |
| `tests/support/reval-test-deps.ts` | `bebab9d56ebaacd4…` | `800966dc8a7c6b020db93df0c5365eff09f28aa1eaa6a605dcc7651dd8993329` | 98 |
| `tests/support/reval-test-exec-entry.ts` | `33bbeab111adcd88…` | `a452636d14147e87d65b6e1d45af9b430ba21b800dafb46cfbda1253e5fb298c` | 42 |
| `tests/support/reval-test-pause-entry.ts` | `5a8c9285b2149088…` | `b76b14ec14324e9f41ecc925e240e5a9b9827a13c892b1bd1717062de561e2d8` | 19 |
| `tests/support/reval-test-server-entry.ts` | `e11289b6e57d9ec6…` | `23ff4891c056706e4a5128b5ac337302fb02a3d0d4e28f82f562490c498a253c` | 31 |

Root-owned and changed by root while I was stopped, NOT by me: `verification/stage5/S5ASKREMOTE_REVAL_RSA_AUTHOR_MODEL_EVIDENCE.json` (`f466b300fd7fa2ff…`).

New source/test paths (10), plus the rebuilt `dist/packages/reval/deadline.js` (`5985e65bd039ae2d175a24cb30038f3e694ab4ea508b44945e47039284337202`):

| Path | sha256 | lines |
|---|---|---|
| `packages/reval/deadline.ts` | `e5dfec29b382b976b1f62d1ddfa6cf62e41c219eeca33cf380f1e091602629ae` | 28 |
| `tests/pg/reval-controls.pg.test.ts` | `f7c64a8bdd03333d64f201287365d397d31c2589b9086f0271d09bde3e8fd63d` | 143 |
| `tests/pg/reval-launch-controls.pg.test.ts` | `714a0107d0ed6ec81a84f2d6d874774dfdfad6ccc1806d5cc2b832727ecc3000` | 108 |
| `tests/reval-deadline.test.ts` | `75339742e30609eaeddaf034e7b132b232d7af1f00897541d9a0646ef94e4145` | 124 |
| `tests/reval-handshake.test.ts` | `b2157e42d45100049868c119eafb8807409af7158dc03d35e3eefdda58986d19` | 127 |
| `tests/support/reval-closure-harness.ts` | `c63323a51cd79ff0f15d60067d6d32406fe9ac642564f6a8361a3ba3872e7ba0` | 84 |
| `tests/support/reval-controller-harness.ts` | `9b33bc75eb1a755931df6eae68b45d9034bd6126ee6ffd66bf26bf76f6baf556` | 109 |
| `tests/support/reval-launch-harness.ts` | `f18afe8fb20a9e8164a82acc6cb3ae6f099fda7f87439c58298107b92502d7dc` | 57 |
| `tests/support/reval-scripted-child.ts` | `9e38217da596c02eca499d1ade0dc7a9f2d323e337810a70b7692ca6a2675922` | 26 |
| `tests/support/reval-spy-child.ts` | `95798a6cdf95d3fdab52d449e8f85d222da8ac762a5287ec662da288a324f9d5` | 14 |

Since the final3 record, exactly 4 of these files changed: `tests/support/reval-pty.ts`, `tests/pg/reval-launch.pg.test.ts`, `tests/pg/reval-launch-controls.pg.test.ts` and `tests/pg/reval-native-unix.pg.test.ts` (the teardown fix). The current hashes are the ones in the tables above.

## 9. Disclosed limits and residuals (no requirement violations known)

- **Receive-time phases:** the private-channel phases are receive phases. A frame C sent before receiving HELLO cannot be told apart by S, because its launch frame carries no nonce by contract. E rejects requests without its own nonce. The R2 cases that are detectable at receive time are all enforced.
- **PostgreSQL backend teardown:** after a cancel and a client disconnect, PG's own teardown waits for an external ACCESS EXCLUSIVE lock on `pg_database` held by a superuser (the native stall test); it ends as soon as that lock is released. The statement itself is cancelled within the budget.
- **Opus obs. 3:** E's per-statement timeouts follow the brief's formula and can add up past DE; C's latch and bounded backend cleanup apply.
- **Opus obs. 4:** the socket-dir ancestor check is mode-based within the same-UID trust boundary.
- **Inherent (brief/RS-D):** helper TOCTOU (the full image is `UNVERIFIED`); a socket swap between checks; JS password-string residency; same-UID/kernel trust. Native fixture evidence is never MEASURED; `verifiedPass`/`liveAcceptanceEligible` stay false.
- **RC5 compatibility is PENDING** until a separately approved re-pin; I adopted nothing.
- **A3:** production refuses until RS-B.

## 10. Cleanup, processes, ownership

- **Docker:** all my DBs, roles and owners from the tests and probes were dropped. Only the 5 older foreign DBs remain, with 0 stray test roles and 0 non-superuser owner roles.
- **Native cluster:** no databases, and the only `atlas_*` role is root's fixture admin. The cluster stays root-owned and running for root's end cleanup.
- **Processes:**
  - The 90 leaked processes (45 O/C pairs, §1) were ended gracefully with SIGHUP. One orphaned mutation-run process was killed earlier.
  - After final5 and after the repro, the audit (matching `scripts/reval-server/`, all test entries, `dist/apps/api/src/main.js`, `/usr/bin/script`, `node --experimental-strip-types`, playwright) found NO process.
  - No temp copies remain.
- **Not done:** no commits, pushes, deploys or activation; root-owned requirements, resolutions, model/effort evidence, seals, status and historical files were not edited.

**Checkout write ownership is explicitly RETURNED to root** as my final action, after all writes, tests and cleanup. This is for a bounded independent re-review of THIS RC2 artifact. Neither RC1 review counts as approval, and I claim no acceptance. Related fixes resume in this same session (642adc68) only on request.
