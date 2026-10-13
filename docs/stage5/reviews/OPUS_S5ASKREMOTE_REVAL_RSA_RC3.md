# OPUS — RS-A rc3 bounded code re-review (own independent RS-A review session)

- **Artifact:** `S5ASKREMOTE-REVAL-RSA-rc3`, packageHash `ae4fb782f4c4ab47fa172ba75f984b5165d54427dbee6e93bd822db37c926216`.
  - Frozen set: `verification/stage5/S5ASKREMOTE_REVAL_RSA_RC3_{MANIFEST,CHECKS,LINEAGE,BUILD_INVENTORY}.json` and `…_RC3_PACKAGE.zip`.
  - Resolutions: `…_REVIEW_RESOLUTIONS.json`, sha `759f85d5…`.
- **Prior assessment:** my own RC2 review of `cd13f162…17df` (CHANGES_REQUIRED, R2-F1). The archived copy `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSA_RC2.md` is byte-identical to my report (sha `c3c12fe9…8d3`).
  - Earlier: my RC1 review of `1f5cd250…a05c`.
- **Requirements unchanged and verified:**
  - BRIEF rc4 `e8f87336…` (`IMPLEMENTATION_BRIEF.md` `caa8a5b4…`, `ACCEPTANCE_CHECKS.md` `5b2b3062…`)
  - `VERIFICATION_ADDENDUM.md` `59c2fd7f…`
  - architecture RC4 `9fa16222…`
  - No new nonce or wire field.
- **Read-only:**
  - No checkout, DB or network writes; my mutation check ran on a temporary copy, deleted afterwards.
  - I did not read the other reviewer's verdict or report, nor implementer history. No subagents.
  - Paid product calls: 0. Activation: none.

## Verdict: **APPROVE_RS_A**, with 0 required findings

All of my required findings (RC1 F1–F5 and RC2 R2-F1) are closed on the actual RC3 source, tests and final evidence. The RC2→RC3 delta is a bounded, sound repair that restores the existing invariants, with no regression found.

This approval covers only packageHash `ae4fb782…6216` with the CHECKS and evidence listed below. It does not cover activation, admission, RS-B/C/D, or loaded-image binding: `loadedBinding` stays `UNVERIFIED` and RS-D is pending.

---

## 1. Identity (before and after my review; unchanged)

**Artifact integrity**

| Check | Result |
|---|---|
| packageHash recomputed (compact sorted `{path,sha256}`; 541 entries, sorted and unique) | `ae4fb782…6216` ✔ |
| Worktree vs manifest | 541/541 match ✔ |
| ZIP vs manifest | 541 entries, 0 mismatches ✔ |
| Identical re-verification at the end of the review | ✔ |

**Baseline and frozen dependencies**

| Check | Result |
|---|---|
| Baseline delta | still exactly the same 14 paths, none missing ✔ |
| RC5 execution files | all 120 unchanged ✔ |
| RC4 normative docs | exact ✔ |
| Six admin overlays | at their pins ✔ |
| Archived RC1 manifest and ZIP | intact (`f68c45bf`, `084b5cfb`) ✔ |
| Archived RC2 manifest, ZIP and CHECKS | intact (`421b0699`, `1f2c1787`, `3aa1cab5`) ✔ |

**RC2→RC3 delta, computed by me from the two manifests**
- 19 changed and 2 new; none removed.
  - Changed: `packages/reval/{channel,owner-exec,pause,physical,server-link}.ts`, `apps/api/src/reval/bridge.ts`, `scripts/reval-server/owner-exec.ts`, their 6 dist outputs, and 6 test/support files.
  - New: `tests/reval-reread-window.test.ts`, `tests/support/reval-gated-executor.ts`.
- This equals `rc3/final/rc2-to-rc3-delta.json` exactly. No change to the controller, migration, roles, readiness, `owner-cli`, payloads or `peer.c`.

**Final evidence ran on these exact bytes**
- The build inventory recomputed now is `583a4ca8…` (268 files), equal to final pre, final post, and both unit runs.
- All 84 RS-A source/test entries in `rc3/final/manifest.out` equal the RC3 manifest hashes. The 11 entries not listed are frozen baseline dependencies, verified exact.
- The only differences are two root-admin JSONs updated after the run (`…AUTHOR_MODEL_EVIDENCE.json`, `…REVIEW_RESOLUTIONS.json`), which are not code.

**Classification records**
- The resolutions file classifies `tests/reval-reread-window.test.ts` (`d3d7f659…`, matching the manifest).
- `tests/support/reval-gated-executor.ts` (`f7c362c3…`, matching the manifest and RC3 report) is classified by root in this instruction and recorded in CHECKS and the report, but is absent from the durable resolutions file. This is record hygiene only (§5).
- The earlier F4 and RC2 classifications are unchanged.

---

## 2. Closure of my required findings

| Finding | Status | Evidence |
|---|---|---|
| **R2-F1:** E connect timeout `min(300, DE − now)` | **CLOSED** | See R2-F1 below |
| **RC1 F1:** byte cap and sequence | closed, still holds | See F1 below |
| **RC1 F2:** `OWNER_REQUIRED` | closed, still holds | See F2 below |
| **RC1 F3:** required checks | closed, still holds | See F3 below |
| **RC1 F4:** §10 paths | closed (root classification) | See F4 below |
| **RC1 F5 / RC2 TAP 76:** evidence and paired record | closed | See F5 below |

**R2-F1 — E connect timeout `min(300, DE − now)`**

*Source*
- `owner-exec.ts`: `E_CONNECT_TIMEOUT_MS = 300`. `connectTimeoutMs = min(300, remaining)` and `budgetMs = remaining`, where `remaining` runs to E's own deadline (≤ DE − 50, slightly stricter than the brief).
- `physical.ts`: the new `PhysicalExpectation.connectTimeoutMs` caps both pg `connectionTimeoutMillis` and the bounded connect await at `min(cap, left)`, distinct from the encompassing physical budget. The session `statement_timeout` stays at the budget.
- The production entry `scripts/reval-server/owner-exec.ts` uses the exported `productionExecConnect`. The C reader and S are unchanged, since no cap is passed.

*Test (through `productionExecConnect`)*
- With a 1200 ms deadline, `connectionTimeoutMillis` is exactly 300, and the budget is >300 and ≤1200.
- With 120 ms remaining, it is ≤120.
- A stalled connect is cut at about 300 ms (`REFUSED DEADLINE`) and the late client is destroyed unused.
- 28P01/28000/42501 → `OWNER_REQUIRED`; a wrong tuple → `REGISTRATION_MISMATCH`.

*Native production chain:* wrong owner password → `OWNER_REQUIRED` ×2, plus both closures.

*My mutations:* E cap 500 → that test fails; pg connect ignoring the cap → it fails too.

**RC1 F1 — byte cap and sequence (closed, still holds)**
- My repro on RC3 (real controller, unchanged since RC2): 700 attempts → `FAILURE CENSUS_LIMIT_EXCEEDED` with sequence `"1"`, owner-CLI check `null`. The 10-attempt control → `SNAPSHOT`.
- The reread byte cap is retained (`pause.ts` `snapshotFitsEnvelope`). Tests pass in both final5 and my run.

**RC1 F2 — `OWNER_REQUIRED` (closed, still holds)**
- See R2-F1. Real-E Docker and native tests pass in the final run.

**RC1 F3 — required checks (closed, still holds)**
- Handshake, concurrency, TOMBSTONE, RV004 and local-exit tests are unchanged and pass. The final PG run covers all of them.

**RC1 F4 — §10 paths (closed by root classification)**
- Root classification, with hashes verified.

**RC1 F5 / RC2 TAP 76 — evidence and paired record (closed)**
- The complete required suite ran on the final bytes (§3).
- The same-run paired record (`rc3/final/unit-paired-rerun.log` `e5722b52…`) has identical identity before and after.
- Its probe uses the exact child argv under `/usr/bin/script`: banner, then `ExecError: CORPUS_IDENTITY_MISMATCH`, `PROBE_EXIT 1`, `receipts=0`.
- TAP 76 remains a **failed** test, qualified indirectly. It is not counted as passing, nor does its own output prove the cause. I approve sufficiency under root's decision.

---

## 3. RC2→RC3 delta and regression assessment

### Pending-reread protocol-violation window (sound)

**Source**
- `channel.ts`: `isViolation()` = PROTOCOL or FRAME_TOO_LARGE, persistent once set. A normal EOF/ERROR is not a violation.
- `pause.ts`:
  - The strict E channel stays open through the single reread.
  - `violated()` is re-checked after the reread.
  - The channel is closed in the same synchronous step as the decision (no await in between).
  - A violation at any time before the decision → `CONTAINMENT_UNCONFIRMED` + latch, never a closure.
  - A normal E EOF still closes.
- At E, S and `ServerLink`, oversize now also counts as a violation (E exits with PROTOCOL, S is killed, the bridge exits with LAUNCH).

**Test: `tests/reval-reread-window.test.ts`**
- Runs the real controller with a real AF_UNIX pair to O and production `checkResponse`.
- The gated child sends one valid result and then exactly one anomaly while C's reread is held. The gate is deterministic: the observer is registered after C's own listener on the same socket.
- Each of duplicate, partial, oversize and malformed gives:
  - O-validated `FAILURE CONTAINMENT_UNCONFIRMED` (sequence 1)
  - the next PAUSE_EXPORT latched (sequence 2) with no respawn
  - the child reaped
- Control: a single result followed by a normal EOF gives `CLOSURE` ×2, two spawns, two rereads.

**My mutations:** removing the post-reread check fails the test, and so does dropping FRAME_TOO_LARGE from violations.

### Test-isolation fix
- `pg_stat_activity` probes in 3 PG tests are now scoped by `datname`. They previously saw executors from other test databases in the parallel run. This is an isolation fix and does not weaken any assertion.

### No other production change
- PTY teardown behavior is unchanged from RC2: `owner-cli.ts` and `controller.ts` are untouched. My RC2 PTY verification stands (SIGHUP and O death end O/C; a master close without SIGHUP leaves O/C alive — a disclosed residual).

### Final current evidence (`rc3/final`; every log hash equals `steps.tsv`)

| Step | Result |
|---|---|
| typecheck, ui-typecheck, db-generate, schema-validate, db-drift, db-pg17, api-build | all exit 0 |
| `test:pg` (`aa0139bd…`) | **725/725**, 0 skipped/cancelled; native fixture ran (descriptor `13de8799…`, PG 17.11) |
| Native results | role flags all false; start equality; APPLIED + NO-OP closures; 5 physical negatives; wrong password → `OWNER_REQUIRED` ×2; real-backend stall |
| `test:ui` (`ede0de73…`) | 86 passed |

**Unit, first complete unfiltered run** (`unit-paired.log` `4657c6ae…`)
- 509 tests: 500 pass, 9 fail.
- The 9th failure is TAP 204, `m365-database.test.ts:21` ("M365 migrations need no pre-created role; schema invariants…"), P0001 "the root leaf has the attempt bounds". I verified the cause:
  - The run spanned 16:59:56–17:01:28Z, crossing 17:00:00Z.
  - The unchanged baseline helper `tests/m365-sql-invariants.ts` (sha = baseline `2b771e53…`) re-evaluates `date_trunc('hour', now()) − 2h` in each separately executed statement.
  - The P0001 comes from the accepted, unchanged Stage 2 trigger migration.
  - RS-A's edit to that file touches a different test (the roles.sql password-status test).
  - The control run passes 8/8 (`bf08ad29…`), and my own run of the file passes.
- This failure is disclosed, not waived and not counted as passing. It is pre-existing baseline nondeterminism, outside RS-A scope.

**Unit, final complete unfiltered rerun on identical bytes** (`unit-paired-rerun.log` `e5722b52…`)
- Timing and identity: 17:10:10–17:11:42Z, with source `adc6a9ce…`/1753 and build `583a4ca8…` the same before, after, and as the first run.
- Exit 1, **qualified**: 509 tests, 501 pass, 8 fail, 0 skipped/cancelled/todo.
- 7 module-load wrappers, each with its own `CORPUS_IDENTITY_MISMATCH` stack, plus TAP 76 (`PTY_TEST_TIMEOUT step 1`, covered by the paired probe).
- Per-name reconciliation, which I re-derived myself from this TAP by exact test name: 38 pass + 1 fail + 71 blocked/unregistered = 110, every historical name accounted for.
  - This matches `rc5-reconcile.json`.
  - The 71 blocked tests are not current passes.
- The RC5 guard drifts only with `[RC_SOURCE_DRIFT, RC_BUILD_DRIFT]`. All RC5 test files are at their pins.
- Historical 110/110 archive proof retained: `HISTORICAL_RC5_FINAL_CHECKS.json` `d90892a8…`, log `0eb98e5c…`.

---

## 4. Checks I verified vs not run

**Run by me** (pure; `/tmp` only)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `tsc -p apps/api/tsconfig.json --outDir /tmp/rsa-review-build3` | 203/203 JS byte-identical to `dist` |
| `build-peer` into `/tmp` | `9624a353…83c1` (= RC3 manifest) |
| `node --test`: 8 RS-A unit files (protocol, payloads, static, physical-peer, rc5-guard, deadline, handshake, **reread-window**) + `context-mapper` + `m365-database`, historical view set | **52/52 pass, 0 skip**; tamper results as recorded |
| Mutation check on a temp copy (4 RC2-defect reintroductions) | all detected; copy removed |
| F1 byte-cap repro | holds |
| Name-based 110 reconciliation of the final rerun | 38 + 1 + 71 = 110 |
| Leftover RS-A processes | none running |
| Hashes: package, ZIP, baseline, RC5, RC4, overlays, RC1/RC2 archives, resolutions, `manifest.out` and build inventory | as in §1 |

**Inspected, not rerun:** final full PG (725), UI (86), DB/schema steps, both unit runs and the paired probe, rc5-files (`7640d3e1…`), and the M365 control. Reasons: mutating `api:build`, DB access, or a long runtime.

**Not reviewed:** the other reviewer's report; the implementer conversation.

---

## 5. Residuals and non-blocking notes

**Inherent and disclosed residuals**
- helper TOCTOU, so the image is `UNVERIFIED` (RS-D)
- socket swap between checks
- JS-resident passwords
- E per-statement timeout formula (brief)
- socket-dir ancestor check by mode bits only (same-UID boundary)
- receive-time phases (S launch frame has no nonce)
- PG backend teardown waits for an external superuser lock on `pg_database`
- a SIGKILLed terminal emulator without hangup leaves O/C (and S in LAUNCH mode) alive until a SIGHUP; I verified this empirically in RC2
- A3 (production refuses until RS-B)
- RC5 compatibility PENDING (no re-pin adopted)
- Pre-existing hour-boundary nondeterminism in the baseline test `tests/m365-sql-invariants.ts` (via `m365-database.test.ts:21`). It is outside RS-A scope and should be tracked separately; it is not an RS-A defect.

**Record notes (non-blocking)**
1. Add `tests/support/reval-gated-executor.ts` (`f7c362c3…`) to the durable resolutions file alongside `reval-reread-window.test.ts`.
2. My RC2 observations remain advisory:
   - an abandoned operation's late `dropReader()` against a successor operation (theoretical, fail-closed)
   - the reader's session `statement_timeout` is fixed at connect time
3. The Docker cleanup record lists 3 roles belonging to the foreign pilot database, and 0 `atlas_rv_*` roles. The native cluster has no databases; only the fixture admin remains, and it was left running by root.

**Status that must not change**
- `verifiedPass` and `liveAcceptanceEligible` stay false.
- RS-B/C/D are not implemented.
- No data/budget admission, provider, customer, deploy or activation.

## 6. Identity, effort and telemetry limits

- **Model:** this re-review was launched in my own RS-A review session as native `claude-opus-5-5` / xhigh. I cannot verify the effective backend model or effort from inside the session, and self-identification is not evidence. Root records that externally.
- **Usage:** elapsed time and token/quota attribution are unavailable to me.
- **Process:** the author's xhigh repair session, its model evidence, and the prior interruption correction are disclosures, not acceptance. No earlier reviewer or implementer approval substitutes for acceptance of this exact artifact.
- **Scope of this verdict:** applies only to packageHash `ae4fb782…6216` with these CHECKS and this evidence. Any later change needs renewed review.
