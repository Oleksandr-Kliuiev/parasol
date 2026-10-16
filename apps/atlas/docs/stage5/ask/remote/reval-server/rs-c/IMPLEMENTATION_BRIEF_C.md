# RS-C implementation brief — part C (browser pane, sealed console, 200-path E2E), rc1 (S5ASKREMOTE-REVAL-SERVER-RSC-C)

Status: written by the implementer (native `claude-opus-5-5`, Claude Code session) on 2026-10-12. This brief is NOT an approval.

Gate (the owner's direct instruction of 2026-10-11): ONE independent native Opus 5.5 `max` review in a clean session, with
bounded re-reviews in that session.

Out of bounds for this part:
- any paid or provider call, activation, account, customer data or deployment;
- provider key pass-through. It stays a PENDING owner decision, so bridge-mode S still never resolves a key. Answers in the tests
  come only from the accepted OFFLINE scripted provider seam of the in-process test server.

## 0. Identity and parents
- **Architecture.** SERVER-DESIGN-rc4:
  - 04 "Pairing and arm", "Synthetic evaluation focus choice" (with its exact transition table), "Registration lifetime and exact
    Ask ingress pipeline", "The server must bind the actual values", "Ingress and threat coverage";
  - 03 FX10 and "all 200 case paths";
  - 05 rows RS-C, Browser focus, Browser generations, Handoff, GO integration, Integration.
- **Parents.** RS-C-A rc2 (seal `S5ASKREMOTE_REVAL_RSCA_APPROVED.json`) and RS-C-B rc3 (seal `S5ASKREMOTE_REVAL_RSCB_APPROVED.json`),
  with their `carriedToRSCC` items.
- **Baseline.** `verification/stage5/S5ASKREMOTE_REVAL_RSCC_BASELINE.sha256`, taken after the RS-C-B seal.

## 1. Scope
IN:
1. **Sealed measured console build.** A dedicated build `dist/operator-measured/`, produced by `scripts/operator-measured-build.ts` from
   the unchanged `apps/operator/src/**` plus the new `apps/operator/measured/**`. It is flat, gets its own asset manifest and the same
   forbidden-construct scan as the accepted build. The ordinary `dist/operator` stays byte-identical, and no `apps/operator/src`
   file changes.
2. **Serving.** Bridge-mode S serves ONLY the measured build at `/operator/` through the accepted asset loader and Host/header
   middleware. Missing or inconsistent assets mean S exits before it listens. Ordinary servers are unchanged: `ATLAS_OPERATOR_UI`
   serves the ordinary build, and the measured build is never served there.
3. **Build measurement.** C's build manifest (`packages/reval/launch.ts`) covers `dist/operator-measured`, so the served assets
   are part of `buildManifestSha256`, which the registration and every SNAPSHOT bind.
4. **Browser evaluation pane** (§3).
5. **Carried server fixes.**
   - (a) RS-C-A `nextAck`: a timer expiry is a DEADLINE by construction, never decided by re-reading a clock that can lag the
     timer.
   - (b) RS-C-A N1: with the evaluation header,
     - unrecognized routes stay the ordinary 404;
     - HEAD/OPTIONS on Ask paths keep their ordinary rejection;
     - recognized non-Ask routes are still a fixed 400.
6. **Instrument identity revision** (§2): it pins RS-C-B and records the RS-C-C candidate layer.
7. **Proofs** (§4):
   - the 04 transition table in a real browser;
   - all 200 case paths, including the 15 FX10 ones, through the pane;
   - the NB7 consecutive ARM/READY rehearsal on this platform, with injected failures before and after consumption.
8. **Routing that the RS-C-B chain pinned**: `rs-c/AGENTS.md`, `docs/RUNBOOK.md`, `docs/AI_CONTEXT_MAP.md` and the instrument's
   AGENTS.md.

OUT (RS-D): PROCESS_CENSUS/DRAIN/POST census, platform and privacy proofs (no clipboard/recording sinks), the OS-level browser
profile, and real provider egress.

## 2. Instrument identity revision (`scripts/reval-instrument/identity.ts`)
- **Anchors.** The RS-C-B rc3 manifest and its seal are added (status `ACCEPTED_RS_C_B_RC3`, bound by manifest path and hash).
  The expected map gains RS-C-B's changed and added files. Its rebuilt-output set also covers `.ts` sources that RS-C-B changed.
- **Candidate layer (RS-C-C, not yet accepted).**
  - An enumerated list `CANDIDATE.paths` names every chain-pinned path that RS-C-C changes, together with the `dist/` outputs of
    those sources. These paths are RECORDED, not pinned:
    - their bytes give `candidateSha256`, which is folded into `executionToolSha256`;
    - a change after start is therefore refused by the pre-GO check and by the RC5 pre-submit check.
  - Any other chain-pinned path must match exactly, as before.
  - When `verification/stage5/S5ASKREMOTE_REVAL_RSCC_APPROVED.json` exists, its status must be `ACCEPTED_RS_C_C_*` and its
    `candidateSha256` must equal the computed one (`CANDIDATE_SEAL_MISMATCH` otherwise). After acceptance the instrument
    therefore runs only the accepted bytes.
  - Before acceptance, the receipt's `revision.candidate` says `{id:'RS-C-C', sha256, accepted:false}`.
  - The next part pins the RS-C-C manifest.
- **Admin overlays.** RC5's pinned admin overlay table is still checked. A path in the candidate list (for example
  `docs/AI_CONTEXT_MAP.md`) is recorded instead of compared with RC5's pinned hash.

## 3. Browser evaluation pane (`apps/operator/measured/`, measured build only)
- **Composition (`main-measured.ts`).**
  - It wires the accepted session, context, queue and evidence controllers and views unchanged, so connecting, client selection,
    context, queue and capability behave exactly as accepted.
  - The ordinary Ask form is never offered. The measured main renders the accepted view with the Ask capability masked to OFF.
    The evaluation panel reads the real capability state (REMOTE V2 disclosure) read-only.
- **Measured credential holder (`credential-measured.ts`).**
  - It is a separate closure with the same token rules as the accepted holder: no getter, no storage, the exact bearer format,
    and the fixed fetch options. It exposes the accepted `CredentialHolder` operations, so the accepted controllers can use it.
  - It adds exactly three closed operations:
    - PAIR: `{contractVersion:'RevalBrowserHandoffV1',operation:'PAIR',pairingNonce}`;
    - an evaluation Ask, which is the exact AskRequestV2 body sent with `X-Atlas-Evaluation-Session`;
    - RESPONSE.
  - The session token is held ONLY inside this closure, set from a validated PAIR200 and cleared on every invalidation. No caller
    passes a header, URL or arbitrary body.
- **Pairing panel.**
  - It is a plain manual control: a password-type nonce field and a Pair button. It is available once a credential is connected
    and a validated REMOTE capability exists, never discovered from capability.
  - PAIR200 is validated exactly. The ≤2 KiB body must contain `pairId`, `sessionToken`, `serverBootId`, `expiresAt` and the exact
    `evaluationFocus` (registrationId, fixtureId, fixtureGeneration, requestedFocus, focusState, syntheticFreshnessAt).
  - The nonce field is cleared before the request.
  - Any failure shows a fixed code. There is no automatic PAIR.
- **Synthetic pane.** It appears only after a valid PAIR200.
  - It starts with an empty draft, no choice and no consent.
  - It offers ONE labeled choice for the installed fixture: "No focus" for NONE, or the exact requestedFocus ID for FOUND/MISSING.
  - It shows the accepted fixed disclosure text with a per-question consent checkbox.
  - Ask is enabled only for a non-empty valid draft, the deliberate choice, current consent, a current pair and a current
    capability tuple.
- **State machine (`eval-state.ts`, DOM-free).** It implements EXACTLY the 04 table:
  - repeated typing keeps the newest draft;
  - a selection keeps the draft and the new choice;
  - an edit after selection clears the choice and consent;
  - consent applies only to the current generation;
  - submit captures the immutable tuple, then synchronously clears the draft, choice and checkbox without self-invalidating;
  - a current completion shows only the eligible answer or error and the handoff button;
  - external invalidations clear the draft, choice, consent, answer and handoff, and invalidate pending work;
  - stale success, error or finally changes nothing.

  External invalidations are credential, scope, context, queue, page, filter, selection, capability, policy, pair
  expiry/revocation, disconnect, pagehide and bfcache. A separate pending-request generation ensures that the form clearing at
  submission is not taken for an edit.
- **Evaluation Ask (`eval-transport.ts`).**
  - It uses the accepted 10 s budget, 256 KiB cap and V2 whole-answer validator.
  - In private closure state it keeps the exact submitted request object and, for a valid 200 answer or an eligible AskErrorV1
    error, the exact parsed body, status, `X-Atlas-Correlation-Id` and `X-Atlas-Evaluation-Receipt`.
  - The receipt header must be a canonical 43-character token. Nothing else is kept.
- **Send evaluation evidence.**
  - A manual button sends RESPONSE with the captured immutable values only while that request is the current completion. Every
    invalidation clears the reference.
  - 204 is shown as "evidence sent to the server". It does not prove the instrument committed. Any other result is a fixed code.
  - There is no retry and no second send.
- **Privacy.** Question, answer, nonce and tokens are never put into storage, URL, history, console, DOM attributes or logs.
  `pagehide` and a bfcache restore disconnect and drop everything.

## 4. Proofs
- **Unit (`tests/operator-eval-*.test.ts`).**
  - The transition table, including stale completions.
  - PAIR200, receipt and RESPONSE validation.
  - The measured holder: closed operations, no token exposure, header and body exactness.
- **Browser (Playwright, `tests/ui/eval-*.spec.ts`, built measured console on in-process bridge S).**
  - The 04 table with real typing, selection and checkbox.
  - Readiness for NONE, FOUND and FX10 MISSING.
  - PAIR on an unregistered server gives 404.
  - The ordinary console has no pairing control.
  - CSP is enforced, with no storage and no token in the DOM.
- **200-path E2E (`tests/ui/eval-200.spec.ts`).** For every fixture, the test switches the fixture (accepted maintenance code) and
  starts the in-process bridge S with the OFFLINE scripted provider. Then, for every frozen case of that fixture:
  1. The test arms the case as C and sends READY as I.
  2. The browser types the case's question, selects its fixed choice, checks consent, clicks Ask and clicks Send evaluation
     evidence.
  3. The test as I receives the TRANSFER and reruns the accepted RC5 validators against the frozen case. It requires
     `requestMatchesFrozen` and the exact observationId; for all 15 FX10 cases it also requires the frozen absent ID with
     MISSING/hasFocus:false.
  4. The test ACKs, gets COMMIT and a 204, and collects the terminal observation.
- **NB7 rehearsal.**
  - Consecutive ARM/READY cycles on this host run through the measured run (the real RS-C-B instrument code) against the
    in-process S and C hub.
  - It reports attempted, successful and failed counts and the ARM/READY latency distribution.
  - It injects one failure before consumption (no case consumed) and one after (case consumed, run stopped).
- **Server fixes.** A deterministic test of the early-timer case, which must give 504 DEADLINE. The N1 matrix with the header:
  unrecognized → 404, HEAD/OPTIONS on Ask → ordinary, a recognized route → 400.
- **Full suite.** Everything RS-C-B ran, plus `npm run test:ui`.

## 5. rc2 amendment
Source: review `docs/stage5/reviews/OPUS_S5ASKREMOTE_REVAL_RSCC_RC1.md` (CHANGES_REQUIRED, F1–F5). The implementer wrote this amendment;
it is NOT an approval.
- **§1.2 (F1).** The bridge S applies the accepted console boundary to EVERY request, as the console-enabled ordinary server does:
  the exact Host is checked before any static or API dispatch (421), and the security headers are set on every response.
  - The handoff route and the evaluation gate therefore see a wrong Host only after it has been refused with 421. An invalid
    Origin still gets 400.
  - Console paths run the evaluation-header rule (400) before their own gate and assets.
- **§3 (F2), the 04 "apply existing current-generation error rules" clause.**
  - A current 401 (PAIR, evaluation Ask, RESPONSE) disconnects.
  - A current 403 (evaluation Ask FORBIDDEN, or PAIR/RESPONSE SCOPE_MISMATCH) ends the pair and refreshes the picker once.
    Pairing stays blocked (`SCOPE_REFUSED`) until the operator deliberately selects the client again. The full accepted scope
    reset would need an accepted `src` change, so the reviewer-allowed alternative is used.
  - A current 409 `ASK_REMOTE_POLICY_CHANGED`, or a RESPONSE refused with POLICY_CHANGED/ADMISSION_NOT_ACTIVE, ends the pair and
    blocks it (`POLICY_CHANGED`) until a fresh capability object exists. In this build that means a reconnect, and the fixed text
    says so.
- **§3 (F3).**
  - A local refusal keeps an eligible completion and its one send.
  - Every RESPONSE refusal for which the server revokes the pair ends it locally.
  - A refusal that ends the pair stays visible.
- **§4 (F4/F5).**
  - New tests:
    - stale PAIR/RESPONSE completions and already-resolved stale values;
    - the pair-expiry timer;
    - an invalid 200 with a receipt;
    - C's build manifest covers `dist/operator-measured`;
    - panel layout at 320/768/1440 px;
    - on the wire, `{question, hasFocus}` per case, with `hasFocus:false` for all 15 FX10 cases.
  - NB7 now also reports the PRE→ARM interval (`preToArmMs`, a receipt v3 case key) against C's 2 s PRE-age bound.
