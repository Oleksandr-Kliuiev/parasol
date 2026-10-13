# ASK-REMOTE R-B RC2 repair report (Astra RC1 R1, R2)

**Acceptance: PENDING** fresh independent critical-boundary Astra/xhigh review. No acceptance is claimed. Scope: the two
required RC1 findings only (`docs/stage5/reviews/ASTRA_S5ASKREMOTE_RB_RC1.md`); the original R-B brief stays authoritative and
`S5ASKREMOTE_RB_IMPLEMENTATION_REPORT.md` (RC1) is unchanged. No wire/profile/prompt/schema/provider, browser, migration,
roles, schema, dependency, account/key/data/budget or deployment change; paid/provider/network calls: 0.

| Item | Value |
|---|---|
| Implementer | SAME native Claude Code session `d7982c45-9ae5-4da2-9568-3c31a1d6c269`, requested `claude-opus-5-5`, effort high; the RC2 response stream so far reports only `claude-opus-5-5` (`/tmp/atlas-stage5/askremote/rb/opus-rb-rc2.jsonl`); billing per `rc2-preflight.json` (included subscription, no API/credits/fallback); quota unknown |
| Elapsed | ≈ 18 min (handoff 2026-10-11T01:11:14Z → report 01:29Z) |
| Repair baseline | before any write: `S5ASKREMOTE_RB_RC2_REPAIR_BASELINE.json` sha256 7f02d644…; exact pathset 1282/1282 (itself excluded) and 244/244 compiled outputs matched, none missing/extra; review result, RC1 manifest/package, design seal/closure, ten norms, initial baseline, rc2-preflight and dependency seals matched (`repair-rc2/baseline/PREWRITE_VERIFICATION.json`) |
| Evidence | `/tmp/atlas-stage5/askremote/rb/repair-rc2/EVIDENCE_INDEX.json` |

## R1 — original floor at the private consumption boundary (closed)

The orchestration binds the task (its AbortSignal) to its ORIGINAL `AskDeadline` once, before egress
(`bindTaskDeadline`; first binding wins, a different second binding throws). `admitEgress` refuses to mint for an unbound
task and captures that deadline in the capability's private state. `dispatchIntent` keeps the one provider phase starting
before key resolution and adds the last gate, after secret resolution and the prepared-byte copy, synchronously before
consumption and the transport call: terminal → `NOT_SENT TERMINAL`; original remaining < 4500 ms (or phase end) →
`NOT_SENT FLOOR`; unresolvable key → `NOT_SENT KEY`. A refused capability stays MINTED, so only the private known-no-dispatch
settlement (0) applies. The orchestration maps FLOOR/TERMINAL → 504 `ASK_DEADLINE` (no new final transaction, as before) and
KEY → 503. Exactly 4500 ms passes. No caller argument, clock or reconstructed object supplies or relaxes the deadline, and
there is no optional production path without the binding (removing it fails closed: mutant N05).

## R2 — non-200 classified at the response headers (closed)

The direct transport decides a non-200 `RESPONSE(status)` with an empty body inside the response callback, before any body
byte is read, then stops the body read (response destroyed, request destroyed). Envelope validation maps every non-200 to
`UPSTREAM` (401/403 = auth), so the orchestration answers 503 `ASK_REMOTE_UNAVAILABLE`, settles `UPSTREAM_REJECTED` (whole
reservation), closes the local circuit at detection for 401/403 and runs the separate owner-held durable pause after phase2.
An oversized, stalled, failed or aborted body can no longer hide the status. The provider phase still decides timeliness:
a status or body after the phase end or terminal is discarded (`DELIVERY_UNKNOWN`). Physical settlement still waits for both
the request and the response to close; with ignored destroys the owner stays held until both actually close. Target,
headers, profile, payload and the private key boundary are unchanged; 200 handling (64 KiB cap, fatal UTF-8, duplicate keys)
is unchanged.

## Changed paths (vs the immediate repair baseline; exact hashes in `scope-final.json`)

Existing: `packages/ask/remote/{dispatch,service,transport}.ts`; `tests/ask-remote-dispatch.test.ts` (mint helper binds a
deadline; `NOT_SENT` reasons; unbound-task refusal); routing `packages/ask/remote/AGENTS.md`, `tests/pg/AGENTS.md`,
`docs/AI_CONTEXT_MAP.md`; `docs/RUNBOOK.md` §15 (two operator sentences). Added: `tests/ask-remote-floor-gate.test.ts`,
`tests/ask-remote-status-gate.test.ts`, `tests/pg/ask-remote-rc2.pg.test.ts`, `tests/support/ask-remote-http-fake.ts`, this
report. Built: `dist/packages/ask/remote/{dispatch,service,transport}.js` changed (244 total; `dist/operator/*` unchanged).
Frozen boundaries: no `prisma/` (migrations, roles, schema), dependency, norm, report/review/seal, status, brief, baseline or
preflight change.

## Verification

- **Astra repro** (`astra-rc1/adversarial.test.mjs`, copied byte-identical; the run copy changes only its results-file path
  so `astra-rc1` stays read-only, `repro/ADAPTATION.diff`): pre-fix 1/3 (R1, R2 red as reported), final 3/3.
- **New regressions**: floor-gate 6 (exact 4500; controlled 4499 after resolution; 4499 during byte work; real-time slow
  resolver vs fast control; terminal during resolution; unknown COMMIT unchanged; unbound/rebound/caller-phase cannot relax),
  status-gate 6 (401/403 × oversized/stalled/error/aborted/small; 404/429/500/502/503/301/400 × oversized/stalled/error; 200
  valid/overflow/fatal UTF-8/duplicate keys; late 200 body, stalled 200 and late 401; terminal before headers; ignored destroys
  in both close orders), real PG `ask-remote-rc2` 3 (401 oversized/403 stalled → ledger UPSTREAM_REJECTED 300000 + durable
  UPSTREAM_AUTH pause; 500 error body; exact 4500 vs 4499 with real reservation → NO_DISPATCH 0 in original periods).
- Focused PG 74/74, including the accepted R-A remote, non-superuser, race/ledger/roles and Ask physical/helper-boundary tests.
- **ALL14** (`checks/run1`, 2026-10-11T01:19–01:24Z, all exit 0): npm test 405/405 (393 + 12), schema:validate, db:generate,
  typecheck, ui:typecheck, ui:build, api:build, api:smoke, test:pg 687/687 (684 + 3), db:check:pg17, db:check:drift,
  test:ui 73/73, git diff --check, untracked whitespace.
- **Production**: fresh copy, `npm ci` (unchanged lockfile), generate, build, dev prune → 0 of 244 outputs differ; operator
  manifest unchanged; foreign-cwd fixture MOCK/OFF browser and asset checks pass; staged DB OFF/MOCK/REMOTE startup under
  the network trap: readiness passes, remote 503 `ASK_REMOTE_NOT_ADMITTED`, 0 policies, 0 network attempts.
- **Mutations** (isolated copies; root identity before/after identical): new N01–N08 all KILLED (dispatch floor recheck,
  rebinding, unbound mint bypass, 503 instead of 504, missing binding, header classification, body read not stopped,
  early physical release). Original 17 requalified (M12b adapted to the two reasoned terminal lines): 15 KILLED, M12a
  SURVIVED (redundant layer; M12b killed), M03a KILLED by the rolling-admission side effect (as in RC1). **M13 changed from
  KILLED to SURVIVED**: the new R1 dispatch-boundary floor independently refuses the same commit-latency case; the combined
  M13c (both floor layers removed) is KILLED.
- PG cleanup: metadata inventory equal to the baseline; the four pre-existing `atlas_it_*` databases untouched.

### Failed attempts (preserved under `repair-rc2/logs`)

`unit-remote-1.log`: my RC1 dispatch unit tests failed after R1 (they minted without a task deadline and expected the
reason-less `NOT_SENT`); updated. `ask-remote-floor-gate` first run: one wrong expectation (empty synthetic bank compiles
SUMMARY as INSUFFICIENT, not ANSWER); fixed in the test. No ineffective product repair attempt.

## Residuals and qualifications

- The direct transport is exercised through an in-process `https.request` stand-in; the real TLS socket/DNS/EU endpoint and
  real response timing are not exercised offline (R-EVAL). A non-200 status is classified from headers only; the error body is
  never read or recorded.
- The floor check reads the same monotonic original deadline as before; a process stall between the final gate and the
  socket write is not observable in-process (the gate is the last statement before the synchronous transport call).
- All RC1 residuals remain (model ID ≠ weights, semantic intent, unsanitized question, irrevocable admitted egress, abort ≠
  no charge, ledger ≠ invoice, per-process circuit, unknown outcomes retain reservations without reconciliation).
