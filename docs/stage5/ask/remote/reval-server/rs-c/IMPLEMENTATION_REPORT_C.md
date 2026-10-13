# RS-C implementation report — part C (browser pane, sealed console, 200-path E2E), rc2 (S5ASKREMOTE-REVAL-SERVER-RSC-C)

rc2 repairs the rc1 review `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCC_RC1.md` (CHANGES_REQUIRED F1–F5); see §0 and brief §5. Its
artifacts are `verification/stage5/S5ASKREMOTE_REVAL_RSCC_RC2_{MANIFEST,CHECKS}.json`.

## 0. rc2 closure
| Finding | Repair | Proof |
|---|---|---|
| F1 P2 console boundary only on `/operator` | The accepted `operatorMiddleware` gate and headers run first for every non-console path. Console paths keep the header rule → gate → assets | `reval-eval-console.pg.test.ts`: `/clients` gets no-store/CSP; a rebinding Host gets 421 on `/clients`, PAIR and Ask, with the gate counters unchanged. `reval-eval-handoff.pg.test.ts`: Host `localhost` → 421 |
| F2 P2 current-error rules | 401 → disconnect (PAIR/Ask/RESPONSE). 403 → end pair + one picker refresh + `SCOPE_REFUSED` until reselection. 409 policy change → end pair + `POLICY_CHANGED` until a fresh capability (reconnect) | `tests/operator-eval-errors.test.ts` (403, 409, 401×3, PAIR/RESPONSE 403) |
| F3 P3 edge cases | A local refusal keeps the completion and its send. Pair-revoking RESPONSE codes end the pair (policy codes also block). The 503 refusal stays visible | `operator-eval-errors.test.ts` (refusal keeps send; RESPONSE code matrix; 503 visible) |
| F4 P3 test gaps | Stale PAIR/RESPONSE completions and already-resolved stale values (abort disabled); pair-expiry timer; invalid 200 + receipt not eligible; build-manifest coverage; layout 320/768/1440; FX10 `hasFocus:false` on the wire | `operator-eval-errors.test.ts`, `reval-measured-build.test.ts`, `ui/eval-pane.spec.ts`, `ui/eval-200.spec.ts` |
| F5 P3 accuracy / carried items | Brief wording corrected (it is added in this package). The receipt states exactly what changed after each run. Carried items have destinations (§4). NB7 reports PRE→ARM (`preToArmMs`). Candidate derivation limited to `apps/api|packages` (no phantom `dist/` entries) | this report, `CHECKS.json`, `reval-nb7-rehearsal.pg.test.ts`, `identity.ts` |

Implementer: native `claude-opus-5-5` (Claude Code session `d0382327-d726-4375-8d23-49e794437702`), 2026-10-12. This report is not an
approval.

- **Gate.** The owner's direct instruction: ONE independent native Opus 5.5 `max` review in a clean session.
- **Brief.** `IMPLEMENTATION_BRIEF_C.md`, added in this package; it is not in the baseline.
- **Baseline.** `verification/stage5/S5ASKREMOTE_REVAL_RSCC_BASELINE.sha256`, taken after the RS-C-B seal.
- **Manifest and checks.** `verification/stage5/S5ASKREMOTE_REVAL_RSCC_RC1_{MANIFEST,CHECKS}.json`.
- **Not done.** No paid or provider call, activation, account, customer data, deployment or commit. Every answer in the tests comes
  from the accepted OFFLINE scripted provider seam; the production bridge seams still never resolve a key.

## 1. Delivered (brief §1)
| Item | Where |
|---|---|
| Sealed measured console build: flat, own manifest, accepted forbidden-construct scan; the ordinary `dist/operator` stays byte-identical (checked) | `scripts/operator-measured-build.ts`, `apps/operator/tsconfig.measured.json`; hooked into `scripts/operator-build.ts` |
| Measured pane: manual pairing, one fixed choice, the 04 transition table, evaluation Ask with the session header, receipt capture, manual "Send evaluation evidence" | `apps/operator/measured/*` (see its AGENTS.md) |
| The bridge S serves ONLY the measured build at `/operator/`, with the accepted console boundary on those paths. Missing or inconsistent assets → exit 44 before listening | `apps/api/src/reval/evaluation.ts`, `bridge.ts` (`BRIDGE_EXIT.CONSOLE`) |
| C's build manifest covers `dist/operator-measured` | `packages/reval/launch.ts` |
| Carried RS-C-A timer defect: an ACK-wait expiry is decided by the timer event (`ACK_WAIT_EXPIRED`), never by re-reading the clock | `packages/reval/eval-handoff-socket.ts`, `eval-runtime.ts` |
| Carried RS-C-A review N1, with the evaluation header: unrecognized route → ordinary 404; HEAD/OPTIONS on Ask → ordinary; recognized Nest route → fixed 400 (global guard, which runs only for matched routes); console paths → 400 | `apps/api/src/reval/evaluation.ts` |
| Instrument identity: RS-C-B rc3 manifest and seal pinned; enumerated RS-C-C candidate layer recorded (its digest is in the identity and must equal the RS-C-C seal's once that seal exists) | `scripts/reval-instrument/{identity,candidate,receipt}.ts` |
| Routing | `rs-c/AGENTS.md`, `docs/RUNBOOK.md`, `docs/AI_CONTEXT_MAP.md`, `scripts/reval-instrument/AGENTS.md`, `apps/operator/measured/AGENTS.md` |
| The accepted RC5 guard test enumerates the two RS-C-C R-C deltas, with their pinned old hashes: the context map, which is also the one RC5 overlay that now differs, and `scripts/operator-build.ts` | `tests/reval-rc5-guard.test.ts` (`RSCC_SOURCE_DELTAS`, `RSCC_OVERLAY_DELTAS`) |
| Test support (accepted files, extended) | `tests/support/reval-eval-server.ts`: `singleActor` sandbox and DB disconnect on close. `tests/support/reval-test-server-entry.ts`: scripted provider `BY_QUESTION` |

## 2. Decisions inside the brief (for review)
- **No change to the accepted console.**
  - The measured build compiles the unchanged `apps/operator/src` (without the ordinary `main.ts`) together with `apps/operator/measured`.
  - The accepted Ask form is never offered: the accepted view receives the capability masked to OFF. The evaluation panel reads the
    real validated REMOTE capability read-only.
  - The measured holder is a separate closure with the same token rules. It exposes the accepted operations, so the accepted
    controllers run on it unchanged, plus exactly PAIR, evaluation Ask and RESPONSE. The session token lives only there.
- **Raw handoff values.**
  - The evaluation transport keeps the exact parsed body (after whole validation), the correlation header and the one canonical
    receipt token. The controller keeps them only in its closure, for ONE manual send of the current completion.
  - The request object is the parse of the exact body the holder sends (`askRemoteBody`).
- **Pair loss.**
  - A credential, client or capability/policy change ends the pair. Other external invalidations (context, queue, page, filter,
    selection) clear the form and keep the pair.
  - A `503 ASK_REMOTE_NOT_ADMITTED` without a receipt means the gate saw no live arm or pair, so it ends the pair: fresh pairing, never
    restoration.
  - A RESPONSE refused with PAIR_REVOKED, PAIR_EXPIRED or UNAUTHORIZED ends it too.
  - The pair expiry timer drops it at `expiresAt`.
- **Console boundary only on `/operator` in bridge mode.** The accepted Host gate and security headers apply to console paths. API
  paths keep the accepted RS-C-A bridge behaviour; for example, the handoff route's own Host check still answers 400.
- **Candidate layer instead of self-pinning.** A package cannot pin its own manifest. The RS-C-C files are therefore recorded, not
  pinned, and the RS-C-C seal must carry `candidateSha256`. After acceptance the instrument then refuses any other bytes. The next
  part pins the RS-C-C manifest.

## 3. Checks (receipt `S5ASKREMOTE_REVAL_RSCC_RC1_CHECKS.json`)
Evidence highlights (full logs in the receipt):
- **200 case paths.** All 200 went through the measured pane in a real browser: 200 COMMITTED, semantic MATCH, truth true, and all 15
  FX10 cases requested `syn-obs-not-found` and read it MISSING (no focus fact, no extra focus row). The run took 1176 s, paced by
  the accepted 10 questions / 60 s per actor.
- **NB7 rehearsal on darwin/arm64** with real O/C/S processes and the real instrument code under a PTY:
  - 8 attempted: 6 successful, 1 failed before consumption (the case stayed unconsumed), 1 failed after consumption (consumed, run
    stopped);
  - ARM min 7 / p50 12 / max 38 ms; READY ≤ 2 ms; GO→COMMIT p50 358 ms;
  - Docker PG17, so this is regression evidence and was never MEASURED.

New coverage:
- **Unit.**
  - `tests/operator-eval-contracts.test.ts`: parity with the accepted server DTOs, codes and headers; the canonical-token rule;
    PAIR and RESPONSE bodies that the server decoder accepts.
  - `tests/operator-eval-controller.test.ts`: the holder; the 04 table on the accepted console controller with a fake fetch that
    ignores AbortSignal; stale completions; external invalidations; the one manual send.
  - `tests/reval-eval-runtime.test.ts`: the early-timer case gives DEADLINE.
  - `tests/reval-instrument-identity.test.ts`: RS-C-B pins, the candidate layer and the candidate seal.
- **PG.**
  - `tests/pg/reval-eval-console.pg.test.ts`: serving, N1 and exit 44.
  - `tests/pg/reval-nb7-rehearsal.pg.test.ts`: NB7.
- **Browser.**
  - `tests/ui/eval-pane.spec.ts`: real-browser 04 table, CSP and nothing retained.
  - `tests/ui/eval-200.spec.ts`: all 200 case paths; needs `ATLAS_REVAL_E2E_200=1`; paced by the accepted 10 questions / 60 s
    limit.

## 4. Residuals and open decisions
- **OPEN OWNER/ARCHITECTURE DECISION: one admitted run across the frozen order.**
  - The frozen order interleaves the 11 fixtures (FX07, FX05, FX10, FX02, …).
  - The accepted RS-B switch refuses while ANY other database backend exists (`checkNoOtherBackend`), so S must stop.
  - 04 says "Loss of I/C/S state, channel continuity or process identity stops that run".
  - Together, a single admitted run cannot follow the frozen order. Each fixture can be evaluated in its own S session (as the
    200-path E2E does, one S per fixture), but the RC5 supervisor's single-run frozen order cannot.
  - This needs an owner/architecture decision. Options:
    - a reviewed fixture-grouped order;
    - S releasing its backends while PAUSED without losing process identity;
    - a run that is defined per fixture segment.
- **Provider key pass-through** remains a PENDING owner decision (tentatively Azure environment variables).
- **The NB7 rehearsal order** puts the installed fixture's cases first. That is a rehearsal only; a real run follows the frozen order
  (see the decision above).
- **The 200-path E2E** plays C and I in the test process: the C hub methods are called directly, and I uses the REAL RS-C-B
  `receiveTransfer`. The real-process chain is covered by NB7 and the RS-C-A/RS-C-B process E2Es.
- Carried unchanged:
  - T2 (the two instrument sockets are not tied to one process);
  - admission, capability, stage and consent are ATTESTED;
  - macOS `F_FULLFSYNC`;
  - "swept vs expired-uncollected" OBSERVATION_UNAVAILABLE;
  - optional `buildManifestSha256` binding.
- **Re-carried, with destinations (rc2 F5).**
  - RS-B/RS-C-A/RS-C-C build inventory: seal one so that rebuilt `dist/` outputs can be pinned instead of recorded. This goes to the
    next instrument revision (RS-D), which pins the RS-C-C manifest. A package cannot pin its own outputs.
  - The "swept vs expired-uncollected" OBSERVATION_UNAVAILABLE distinction (a protocol change) goes to RS-D.
- **Bridge-only Host order.** A console path that carries the evaluation header gets the fixed 400 before its own Host gate (421).
  Both refusals happen before any dispatch.
- **RS-D:** PROCESS_CENSUS/DRAIN/POST census, and the egress/privacy/platform proofs (clipboard/recording sinks, browser profile).
