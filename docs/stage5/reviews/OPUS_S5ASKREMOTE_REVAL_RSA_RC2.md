# OPUS — RS-A rc2 bounded code re-review (own independent RS-A review session)

- **Artifact:** `S5ASKREMOTE-REVAL-RSA-rc2`, packageHash `cd13f162c0eabc555bff18460820127aa3b7aeef82396be6e0739726e11817df`.
- **Frozen files:**

  | File | sha256 (prefix) |
  |---|---|
  | `verification/stage5/S5ASKREMOTE_REVAL_RSA_RC2_MANIFEST.json` | `421b0699` |
  | `…_RC2_CHECKS.json` | `3aa1cab5` |
  | `…_RC2_LINEAGE.json` | `a01a31be` |
  | `…_RC2_PACKAGE.zip` | `1f2c1787` |
  | `…_RC2_BUILD_INVENTORY.json` | `f1dfb219` |
  | `…_REVIEW_RESOLUTIONS.json` | `cf4802ea` |

- **Previous review:** my own RC1 review of `1f5cd250…a05c`. The archived copy `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_RC1.md` is byte-identical to my report (sha `6def7f09…12b4`).
- **Requirements unchanged and verified:**
  - BRIEF rc4 `e8f87336…` (`IMPLEMENTATION_BRIEF.md` `caa8a5b4…`, `ACCEPTANCE_CHECKS.md` `5b2b3062…`)
  - `VERIFICATION_ADDENDUM.md` `59c2fd7f…`
  - architecture RC4 `9fa16222…`
- **Read-only:** no checkout, DB or network writes. I did not read the other reviewer's verdict or report, nor implementer history. No subagents. Paid product calls: 0. Activation: none.

## Verdict: **CHANGES_REQUIRED**, with one P3 finding (bounded, one-line class)

All five of my RC1 findings are closed on actual source, tests and the final5 evidence (§2). The RC1→RC2 delta introduces no safety regression.

One undisclosed deviation from a normative BRIEF §6 sub-deadline was introduced by this repair (R2-F1 below). Everything else, including the full current suite, PG17/native, UI, schema, typecheck, build, reproducibility, tamper and RC5 qualification, is verified. A narrow bounded re-review of the R2-F1 fix (plus the affected checks) suffices.

---

## 1. Identity (before and after my review; unchanged)

**Artifact integrity**

| Check | Result |
|---|---|
| packageHash recomputed (compact sorted `{path,sha256}`; 492 entries, sorted and unique) | `cd13f162…17df` ✔ |
| Worktree: all 492 files vs manifest | 0 mismatches ✔ |
| ZIP vs manifest | 492 entries, 0 mismatches ✔ |
| Identical re-verification after all my checks | ✔ |

**Baseline and frozen dependencies**

| Check | Result |
|---|---|
| Baseline delta | still exactly the same 14 paths as RC1, none missing ✔ |
| RC5 execution files | all 120 unchanged ✔ |
| RC4 normative docs | exact; only the 2 allowed dependency files differ ✔ |
| Six admin overlays | at their RC5 pins ✔ |
| Archived RC1 manifest, ZIP and CHECKS | unchanged (`f68c45bf`, `084b5cfb`, `02d49195`) ✔ |

**RC1→RC2 delta, computed by me from the two manifests**
- Code, tests and dist: 36 changed and 11 new, 0 removed. This equals `final5/rc1-to-current-delta.json` (`36319cc8…`) exactly.
- No change to the 14 baseline-modified files, `reval.sql`, `reval-role.ts`, `envelope.ts`, `codes.ts`, `owner-cli.ts`, `payloads.ts`, `peer.c` or `launch.ts`.

**Final5 ran on these exact bytes**
- The build inventory recomputed now is `a20cc144…` (268 files), identical to final5 pre and post.
- All 82 RS-A source and test entries recorded in `final5/manifest.out` equal the RC2 manifest hashes.
- The only differences are two root-admin JSONs updated after the run (`…AUTHOR_MODEL_EVIDENCE.json`, `…REVIEW_RESOLUTIONS.json`), which are not code.

**Root resolutions: recorded conditions hold**
- The 9 RC1 paths classified under F4 match their recorded RC1 hashes. Seven of them changed in RC2, and I reviewed those changes as part of the delta.
- `tests/support/poweroffice-envelope.ts` is unchanged.
- The 10 RC2 repair paths and the paired-record log (`a60e4c50…`) match the RC2 manifest.

---

## 2. Closure of my RC1 required findings

| RC1 finding | Status | Evidence (source / tests / run) |
|---|---|---|
| **F1 (P2):** byte cap; sequence skip; reread without cap | **CLOSED** | See F1 below |
| **F2 (P3):** owner auth failure → `OWNER_REQUIRED` | **CLOSED** | See F2 below |
| **F3 (P3):** missing required checks | **CLOSED** (5/5) | See F3 below |
| **F4 (P3):** §10 path conformance | **CLOSED by root classification** | See F4 below |
| **F5 (P3):** evidence renewal and TAP 76 qualification | **CLOSED** | See F5 below |

**F1 — byte cap, sequence skip, reread without cap**

*Source*
- `controller.ts` `send()` takes exactly one sequence per response, and the FrameError fallback reuses it.
- `snapshot-reader.ts` `snapshotFitsEnvelope()` is a deterministic worst-case 06 envelope check. It is used by `exportSnapshot` (→ `CENSUS_LIMIT_EXCEEDED`) and by the `pause.ts` reread (over cap → null → `CONTAINMENT_UNCONFIRMED` + latch).

*My repro (re-run on the frozen RC2 controller)*
- 700 attempts → `FAILURE CENSUS_LIMIT_EXCEEDED` with sequence `"1"` and the owner-CLI check `null`.
- The 10-attempt control is unchanged.

*Tests (final5)*
- `reval-deadline.test.ts`: O-validated continuity.
- `reval-handshake.test.ts`: reread latch, with a small-census control.
- PG `reval-snapshot` (700 real rows) and PG `reval-controls`: real reread after a confirmed commit → latch; control closes.

**F2 — owner auth failure → `OWNER_REQUIRED`**

*Source*
- `physical.ts` `connectFailure()` → `PhysicalAuthError` keeps only the SQLSTATE (28P01/28000/42501). Everything else is `PhysicalMismatchError` or `DeadlineExceeded`.
- `owner-exec.ts:62-68` maps these to `OWNER_REQUIRED` / `REGISTRATION_MISMATCH` / `DEADLINE`.

*Tests*
- PG `reval-controls`: real E, wrong password → `OWNER_REQUIRED`, no statement, no latch, a second call spawns again.
- Native production chain: `FAILURE OWNER_REQUIRED` ×2 with policy and fence unchanged (`test-pg.log` REVAL_EVIDENCE).

**F3 — missing required checks (5/5 closed)**
1. **§2e handshake:** `reval-handshake.test.ts` runs the production S/E libraries with secret and connect spies, plus a positive control.
   - Coalesced and fragmented duplicates, wrong-phase frames, missing frames, a duplicate arriving while the secret read is pending, and a forged nonce (E).
   - Controller side: silent child, frame-before-HELLO, double HELLO, and a duplicate result → latch.
   - Implementation: strict private channels (`channel.ts`). The S-launch-frame no-nonce limit is disclosed and inherent to the brief.
2. **Concurrent reserve/revoke/settle:** PG `reval-controls`, with E verified to hold its locks.
3. **TOMBSTONE pre-state:** refused with no routine call.
4. **RV004:** run through the real definer, with an 8-tuple control.
5. **Local exits 10/11/12:** O shows them as `LOCAL` codes from C's actual exit (PG `reval-launch-controls`). Exit 12 is also covered pre-proof with no frame (`reval-deadline`).

**F4 — §10 path conformance**
- `S5ASKREMOTE_REVAL_RSA_REVIEW_RESOLUTIONS.json` classifies the 9 RC1 paths plus `poweroffice-envelope.ts` and the 10 RC2 paths. It records no behavior or authority expansion.
- I verified the recorded hashes. Each new file is ≤500 lines.

**F5 — evidence renewal and TAP 76 qualification**
- The complete suite ran on the final RC2 bytes (final5, see §4).
- TAP 76 is accepted under root's explicit decision via the same-run paired record (`final5/unit-paired.log`):
  - identity before/after identical
  - the exact child argv under `/usr/bin/script` prints the banner, then `ExecError: CORPUS_IDENTITY_MISMATCH`, `PROBE_EXIT 1`, `receipts=0`
- The original test remains a **failed** test, qualified indirectly; it is not counted as passing, nor does its own output prove the cause. I approve this paired record as sufficient.
- Record hygiene (non-blocking): CHECKS `findings.OpusF5.dir` still names `final3`, while `finalRun`/`finalSuite` correctly name final5.

---

## 3. New required finding

### R2-F1 — P3 — E's connect timeout no longer follows BRIEF §6 `min(300, DE − now)` (introduced in RC2, undisclosed)

**Paths and lines**
- `packages/reval/owner-exec.ts:62` now passes `Math.min(500, …)` (RC1: `Math.min(300, …)`) as E's physical `budgetMs`.
- `packages/reval/physical.ts:98` gives the connect `connectionTimeoutMillis: left`, where `left` is the remainder of that budget after the filesystem checks.
- Called via `scripts/reval-server/owner-exec.ts:14`.

**Trigger:** a slow owner connect or auth (for example a busy postmaster).

**Impact**
- The owner connect may take up to about 500 ms instead of the brief's normative `min(300, DE − now)`. This reduces the time left for the E transaction before DE.
- It remains bounded by E's own deadline, C's D, and the latch rules, so there is no safety or closure impact. It is a silent change to a normative brief parameter made by a repair that was meant to restore requirements.
- Neither the RC2 report nor CHECKS mentions it, and no test pins E's connect bound.

**Required:** either restore `connect ≤ min(300, DE − now)` (for example E's physical budget `min(300, …)`, or cap `connectionTimeoutMillis` at that value), or obtain an explicit root/brief clarification.

**Required check:** a unit assertion on the E connect bound (spy `ConnectOptions.connectionTimeoutMillis ≤ min(300, remaining)`). Rerun the affected unit/PG/native checks on the new identity.

---

## 4. Delta and regression review (RC1→RC2)

### Controller and protocol (sound)

**Per-operation deadline (`deadline.ts` `bounded()`)**
- One absolute deadline per operation, at t0+1800 (the first operation includes startup).
- A guard answers 40 ms before the deadline with the operation's fixed code: startup → sticky `DEADLINE`; IDENTITY → `IDENTITY_UNVERIFIED` with S killed; SNAPSHOT → `CENSUS_UNAVAILABLE`; PAUSE_EXPORT → `DEADLINE` before the request, or `CONTAINMENT_UNCONFIRMED` + latch after it. E is killed and never treated as proof of rollback.
- Abandoned work cannot reply, assign a reader or launch S; late clients are destroyed.

**Other controller changes**
- `requestSent` is reset per invocation and set synchronously before the send.
- Owner EOF cancels outstanding work at once, with bounded cleanup.
- Strict private channels close synchronously, within the same `data` event, on unsolicited or partial frames. Waiters are always registered synchronously before a peer could legitimately send.
- `PAUSE_EXPORT` peer proof is bounded by requestBy (a timeout is `DEADLINE`; a mismatch is `IDENTITY_UNVERIFIED`).
- RC1 observation 1 is fixed (the reread drops the reader on failure).

**Physical binding**
- Steps 1–6 share one budget, with session `statement_timeout` = remaining budget, and late clients are destroyed.
- The native real-backend stall evidence: `DeadlineExceeded` at 803 ms on an 800 ms budget, and the statement was cancelled with the lock still held.

### Migration guard (d) (sound tightening)
- INSERT now re-checks client, actor, policy, admission and the exact registration/dataset (schema-qualified), so the required "FK negatives still refused under `session_replication_role=replica`" actually holds.
- Probe evidence: `fk-replica.log` OK → `fk-replica-after.log` RV010.

**Changed RC1 assertions**
- 23503→RV010: the guard now fires before the FK.
- The plant for the missing admission row was re-done.
- Both are justified, and the new isolated guard test adds per-defect valid controls in both normal and replica mode, plus "owner cannot enable replica" (42501).

### PTY teardown fix (test-only; verified)
- `PtySession.stop()` sends SIGHUP to O, waits, then SIGKILLs and reports survivors. All PTY tests assert `forced: []`, and native negatives now end with `quit`.
- Limit: `stop()` collects the process tree at call time, so `forced: []` is vacuous when O has already exited.
- The production requirement is tested directly: `reval-launch-controls` SIGKILLs O during two stalls, and C must be gone within 1.5 s, S stopped, backends gone, and no late S.

**My own pure check:** the production `owner-cli` library under a Python-allocated PTY, with a stub controller (no DB):

| Case | O | C (stub) |
|---|---|---|
| SIGHUP to O | exited after 25 ms (status 0) | saw EOF and exited |
| SIGKILL of O | killed | saw EOF and exited |
| PTY master closed with no SIGHUP | **both still alive after 10 s** | **still alive** |

The last row confirms the disclosed residual. A terminal emulator killed or crashed without a SIGHUP leaves O/C (and S in `LAUNCH` mode) alive until a SIGHUP arrives. On this host, merely closing the master does not hang O up. The owner-EOF requirement itself is preserved, not waived.

### Final current evidence (final5; log hashes equal `steps.tsv`)

| Step | Result |
|---|---|
| typecheck, ui-typecheck, db-generate, schema-validate, db-drift, db-pg17, api-build | all exit 0 |
| `test:pg` (`d7665cfd…`) | **725/725**, 0 skipped/cancelled; native fixture ran (descriptor `13de8799…`, PG 17.11) |
| Native results | owner/runtime/reader super=false, bypassRls=false; start equality; APPLIED + NO-OP closures; 5 physical negatives; wrong password; real stall |
| `test:ui` (`b12f8422…`) | 86 passed |

**Unfiltered unit run (`a60e4c50…`)**
- Exit 1, **qualified**: 506 tests, 498 pass, 8 fail, 0 skipped/cancelled/todo, across 87 files.
- 7 module-load wrappers (cli, liability, operator, receipt, repair, replay, session), each with its own `CORPUS_IDENTITY_MISMATCH` stack.
- 1 registered test, TAP 76 (`PTY_TEST_TIMEOUT step 1`), covered by the paired probe.
- Reconciliation (`rc5-reconcile.json`): 38 executed and passing + 1 failing + 71 blocked/unregistered = 110 historical. Registered names are equal. All RC5 test files are at their pins.
- The 71 blocked tests are not current passes.

**RC5 guard**
- Drift is exactly `[RC_SOURCE_DRIFT, RC_BUILD_DRIFT]`, caused by the enumerated deltas.
- Historical 110/110 archive proof retained: `HISTORICAL_RC5_FINAL_CHECKS.json` `d90892a8…`, log `0eb98e5c…`, with before/after ok and per-file inventory equal.

---

## 5. Checks I verified vs not run

**Run by me** (pure; `/tmp` only)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `tsc -p apps/api/tsconfig.json --outDir /tmp/rsa-review-build2` | 203/203 JS byte-identical to `dist` |
| `build-peer` into `/tmp` | `9624a353…83c1` (= RC2 manifest) |
| `node --test` on 7 RS-A unit files (protocol, payloads, static, physical-peer, rc5-guard, deadline, handshake) + `context-mapper` + `m365-database`, with the historical view env set | **49/49 pass, 0 skip**; tamper outputs as recorded |
| F1 repro (real controller) | closed |
| PTY SIGHUP / hangup / kill check (production owner CLI) | results in §4 |
| `git diff --check` | exit 0 |
| Trailing whitespace in RS-A code | none |
| `packages/reval` file sizes | all ≤500 lines |
| Package, ZIP, baseline, RC5, RC4, overlay, RC1-archive and resolution hashes | as in §1 |

**Inspected, not rerun:** final5 full PG (725), UI (86), DB/schema steps, the unfiltered unit and paired probe, and the rc5-files run (`67275bf5…`). Reasons: mutating `api:build`, DB access, or a long runtime.

**Not reviewed:** the other reviewer's report; the implementer conversation.

---

## 6. Residuals and non-blocking observations

**Inherent and disclosed (unchanged)**
- helper TOCTOU, so `loadedBinding` stays `UNVERIFIED` (RS-D pending)
- socket swap between checks
- JS-resident passwords
- E's per-statement timeout formula
- ancestor check by mode bits only
- receive-time phases (S launch frame has no nonce)
- PG backend teardown waits for an external superuser lock on `pg_database`
- A3 (production refuses until RS-B)
- RC5 compatibility PENDING (no re-pin adopted)
- the PTY/terminal residual verified in §4

**Observations**
1. **Late `dropReader()` from abandoned work.** An abandoned operation's late `dropReader()` could, in theory, destroy a successor operation's fresh reader. In practice the abandoned query fails within milliseconds of the destroy, well before O can send the next request, and the effect would be fail-closed (a reconnect or `CENSUS_UNAVAILABLE`).
2. **Session `statement_timeout` is fixed at connect time.** The reader's session timeout is set to the connecting operation's remaining budget and then governs later IDENTITY rechecks. A reconnect made late in an operation could leave a very small timeout, risking a spurious recheck failure (S killed: fail-closed, an availability cost only). Consider a per-recheck `SET statement_timeout`.
3. **Stale CHECKS pointer.** `findings.OpusF5.dir` points to final3.

**Status that must not change**
- `verifiedPass` and `liveAcceptanceEligible` stay false.
- RS-B/C/D are not implemented.
- No data/budget admission, provider, customer, deploy or activation.

## 7. Identity, effort and telemetry limits

- **Model:** this re-review was launched in my own RS-A review session as native `claude-opus-5-5` / xhigh. I cannot verify the effective backend model or effort from inside the session, and self-identification is not evidence. Root records that externally.
- **Usage:** elapsed time and token/quota attribution are unavailable to me.
- **Process:** the author's medium effort, the orchestrator's premature stop and recovery, and the model evidence are disclosures, not acceptance. No earlier reviewer or implementer approval substitutes for acceptance of this exact artifact.
- **Scope of this verdict:** applies only to packageHash `cd13f162…17df` with the CHECKS and evidence listed above. The R2-F1 repair requires renewed review of the exact new identity.
