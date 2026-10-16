# ASK-B implementation report — browser OFF/MOCK journey

Status: **IMPLEMENTED, acceptance PENDING** fresh explicit gpt-6-astra/xhigh. No self-acceptance. No commit, PR, remote,
deployment, LIVE or ASK-REMOTE. Sole checkout write ownership is returned to the coordinator with this report.

## Identity

| Item | Value |
|---|---|
| Implementer | Claude Code, native claude-opus-5-5, effort high (launcher-pinned), fresh session de9faf68-215d-4742-8d88-503f198c1f3e; native subscription only |
| Repository | HEAD 916a4d69853ff6da636e8609a2e0bd33aa787f66, branch planning/stage2-m365 (uncommitted baseline) |
| Brief | docs/stage5/ask/S5ASKB_IMPLEMENTATION_BRIEF.md SHA256 358769aa51663b481ed405277d6bf62ac9322fd38ed785059d84180a87cc6774 |
| Baseline | verification/stage5/S5ASKB_IMPLEMENTATION_BASELINE.json SHA256 9ee7653f083979da5196ef7079b13dab706bcfc8088248117a2743386f4a8e24 |
| Architecture | Ask RC3 package a9e43a42…ab13a; seals S5ASK_DESIGN_APPROVED 90b5ad7c…2c15, S5ASKA_APPROVED 0111e76c…f6ab, S5ASKA closure 4d02d0c0…6de8, S5B_APPROVED 2e6b7b27…37e4 — all re-verified unchanged at the end |
| Final operator build | dist/operator/manifest.json SHA256 b471a1ceca89bbd881c58be0f18655a5902119ff968783f7728c7eb35693b029 (41 assets + manifest) |

Before the first write: all 1134 baseline files, all 215 built files (no extra built file) and the 5 declared administrative
deltas matched; the only working-tree file outside the baseline was the baseline JSON itself
(`/tmp/atlas-stage5/askb/s5askb-impl/baseline-verify-pre-write.json`). Because `apps/operator` and the tests are untracked,
byte-exact baseline copies were taken from the accepted `S5ASKA_RC3_SOURCE.zip` and hash-verified against the baseline (282
files, 0 mismatches) to produce exact deltas (`existing-file-deltas.diff`).

## Write scope and exact deltas

Final scope check (`scope-final.json`): 19 changed baseline files, 18 new files, 0 removed, **0 outside the brief's
allowance**; all 182 non-operator built files byte-identical to the baseline inventory. Untouched: `packages/ask`, `apps/api`,
all server/domain/schema/roles/migrations/dependencies/lockfile/tsconfig/build scripts, the six Ask and eight console norms,
seals/reports/reviews/status files, and the optional shared browser files `contracts.ts`, `messages.ts`, `dom.ts`,
`view-parts.ts`, `main.ts` (none was needed).

New browser modules (all DOM-free except the two views; largest 143 lines):
`ask-contracts.ts` (contract copies, question rule, MOCK examples), `validate-ask-facts.ts` (bank/coverage), `validate-ask.ts`
(capability, AskErrorV1, whole answer, claim matrix), `ask-transport.ts`, `ask-state.ts`, `controller-ask.ts`,
`ask-messages.ts` (fixed dictionaries), `view-ask.ts`, `view-ask-answer.ts`.

Shared-source hooks (each within the brief's named list):

| File | Delta (+/-) | Reason |
|---|---|---|
| operations.ts | +26/-1 | `askCapability` GET kind (`/ask/capabilities`), `askPath`, exact `askBody` (UUIDv4, unchanged question, focus ≤256, ≤16 KiB UTF-8) |
| credential.ts | +14/-2 | fixed `ask()` POST with the same closure/options; body built inside the caller's deadline |
| transport.ts | +46/-13 | focused extraction: exported `bounded` (one original deadline), `sendWithin`, `readJson`, `validated`; GET/evidence paths behave exactly as before (all accepted transport tests unchanged and passing) |
| state.ts, panels.ts | +8/-1, +2 | `askCapability` / `ask` state slots; optional `askRequestId` option |
| controller.ts | +15/-4 | compose Ask controller; capability discovery after a validated client list; generation hooks on scope/credential/context reset; two controller methods |
| controller-queue.ts | +11/-5 | `QueueHooks` so queue (load/filter/page/refresh/refusal/reset) and selection changes clear Ask synchronously |
| view.ts | +4/-1 | compose the Ask view; disconnected render clears it |
| index.html, styles.css | +21, +25/-1 | static Ask region (labelled group, textarea, focus checkbox, `type="button"` Ask button, live regions, static MOCK badge) and styles |
| apps/operator/AGENTS.md, docs/AI_CONTEXT_MAP.md, docs/RUNBOOK.md | +11/-1, +1, +30/-1 | routing/rules for the now-approved operations; RUNBOOK §13 operation; §12 pointer to §13 |

Existing test deltas (additive compatibility; every accepted assertion kept):

| File | Exact delta |
|---|---|
| tests/operator-controller.test.ts, operator-journey.test.ts | harness fake fetch answers `/ask/capabilities` 404 (Ask OFF) without recording it, so S5 request indices stay as accepted |
| tests/operator-transport.test.ts | holder key list gains `ask` (one token in one assertion) |
| tests/operator-contracts.test.ts | module classification lists the 9 new modules (7 shared, 2 DOM); new named ASK-B parity test vs `packages/ask/{contracts,input,planner}.ts` |
| tests/support/operator-ui.ts | `apiRequests` excludes only the one fixed `GET /ask/capabilities`; new `askRequests`; `recordConsole` ignores only Chromium's own network line for a 404 of exactly `/ask/capabilities` (the contract's OFF signal; Chromium logs any 4xx resource) |
| tests/ui/artifact.spec.ts | route list gains exactly the two Ask routes in `operations.js`; `AskRequestV1` literal only in `operations.js`; static MOCK badge present. All security/no-network/no-storage/no-dynamic-URL/attribute/tool checks unchanged |

No other existing spec changed (`console-render.spec.ts` stays byte-identical: its injection probe allowlists only the
console's two static forms, so the Ask input is a labelled `div role="group"`, not a `<form>`).

## Behaviour implemented (Q7/Q8 and browser parts of Q1/Q3–Q6/Q9)

- **Capability.** After a validated client list, once per credential epoch (`IDLE→LOADING→MOCK|OFF|ERROR`); never before,
  never again on picker refresh, never carried across credentials. Exact 200 = 3 keys + canonical lowercase UUIDv4
  `X-Atlas-Correlation-Id` (no body correlation). Only 404 (status-only, body cancelled) is OFF: panel hidden, no input. Other
  failures: fixed state + explicit "Check Ask Atlas again". Current 401 disconnects; current 403 sets ERROR then full scope
  reset + one picker refresh (ERROR prevents re-query, no loop, no auto-select). Completions check credential epoch + own
  generation.
- **Input.** Shown only for MOCK + READY context matching the selection. Labelled textarea, code-point counter, optional
  "Use selected observation" (exact current selected ID; disabled without a selection). Local refusals (empty/whitespace,
  >2000 code points, C0/DEL/lone surrogate, focus without selection) send nothing, never trim/truncate, keep the typed text.
  RU/EN supported examples rendered from `MOCK_EXAMPLES` (parity-checked against the server planner), labelled as exact
  phrases of a local MOCK that is not an LLM; prominent static badge "Ask Atlas — local synthetic MOCK; no external model".
- **Submit.** Previous answer cleared first; exact four-key AskRequestV1 with fresh `crypto.randomUUID()` (verified
  lowercase v4); captured client path; question input and checkbox cleared synchronously before the request starts. A second
  activation while pending sends nothing. Manual retry = new question, new UUID, new server read.
- **Transport.** Same-origin bearer closure, `omit/no-store/redirect:error/no-referrer`; success exactly 200; 401/403
  status-only; any other status keeps only a validated AskErrorV1 (exact keys, known code whose fixed status equals the HTTP
  status, header = body correlation), else generic. ≤256 KiB incremental read, fatal UTF-8, JSON parse and whole validation
  inside one original 10 s budget (request serialization included); a synchronous phase crossing it is TIMEOUT.
- **Whole-answer validation.** Exact 15 top-level keys; requestId, focus (incl. missing/null), workspace, client, sourceMode,
  `mode:'mock'`, version, correlation header. Bank: ≤32 facts, refs positional `E1..En`, kind order OBSERVATION(≤24) →
  RESOURCE_STATE(≤7) → ENTITY(≤1), exact data keys, closed enums, times, nullability, unshortened IDs (≤256, scope pattern for
  connections), 4000-code-point display caps, unique observation IDs and resource tuples, FIXTURE iff fixture mode, non-focus
  observations active. Focus binding: a found focus is E1 with exactly one last ENTITY fact for it and its stored entity ID;
  otherwise no ENTITY. ENTITY shapes: CONFIRMED needs ID/kind/label/confirmation (any confirmed Atera/Huntress link; not tied to
  the focus tuple), others none; UNAVAILABLE keeps its ID. Coverage: exact keys, fixed limits, bounded counters, fixture ⇒ no
  truncation/extra focus, truncated ⇒ 100 read, observation facts = min(24, read + focusExtra) with exact omission flag,
  resourceFactsOmitted = (resource facts < resources read). urgentRefs = exactly every HIGH/CRITICAL observation fact.
  Claims: one ref each, unique, in the bank, empty iff not ANSWER, UNSUPPORTED iff intent UNSUPPORTED; exact matrix for
  SUMMARY / WHY_URGENT (only the focus fact, code by severity) / SOURCE_STATE (exact focus source/type/connection) / ENTITY
  (code = state). The planner's private choice among eligible refs is not re-derived.
- **Isolation.** A question captures credential epoch, scope epoch, context/queue/selection generations, the selected
  observation and its own generation; every completion checks all. Hooks (credential, scope, context load, queue
  load/filter/page/refresh/refusal/reset, selection) abort, invalidate and clear answer + input synchronously; disconnect,
  pagehide and bfcache restore go through the accepted disconnect. Late success/error/401/403 of older work is ignored even
  when abort is never delivered. An answer never changes context/queue/selection/detail/evidence/urgency state.
- **Rendering.** `createElement`/`textContent` only; claims via fixed dictionaries; independent urgency notice and coverage
  for every status; cards collapsed in `<details>`; citation buttons open/focus only a card of the same answer (no fetch, link,
  attribute from data). Live status region, focus fallback to the Ask heading when a focused card disappears.

## Checks (final run2, `/tmp/atlas-stage5/askb/s5askb-impl/checks/run2/`)

| # | Command | Result |
|---|---|---|
| 1 | npm test | pass 351/351 (326 established + 25 new), 0 skipped |
| 2–3 | schema:validate, db:generate | pass |
| 4–5 | typecheck, ui:typecheck | pass |
| 6–8 | ui:build, api:build, api:smoke | pass |
| 9 | pgenv test:pg | pass 616/616 (unchanged established count), 0 skipped |
| 10–11 | pgenv db:check:pg17, db:check:drift | pass |
| 12 | pgenv test:ui | pass 68/68 (50 established + 18 new) |
| 13–14 | git diff --check, untracked whitespace | clean |

Run1 (`checks/run1/`) is preserved: 13/14 passed; browser 65/68 — three accepted specs failed (two on Chromium's
capability-404 network line, one on the injection probe seeing the Ask `<form>`). Fixed by the `recordConsole` delta above
and by replacing the form with a labelled group; then run2.

New tests: `tests/operator-ask-validate.test.ts` (12: every server-compiled fixture/DB answer of every intent/status validates
exactly; hostile keys/enums/times/scope/ref/bank/coverage/urgency/claim-matrix/cap cases; paired same-system connection
goldens; LOW focus + HIGH other rejects `[focus,other]` and `[other]`), `operator-ask-transport.test.ts` (5),
`operator-ask-controller.test.ts` (7; race matrix run with abort delivered and with `AbortController.abort` disabled),
parity test in `operator-contracts.test.ts` (1). Browser: `tests/ui/ask-fixture.spec.ts` (6, real compiled fixture API; OFF,
EN/RU journeys, unsupported/insufficient, refusals, keyboard, changes, disconnect, pagehide, real 10/60 s budget → ASK_BUSY),
`ask-pg.spec.ts` (3, real DB API on disposable PG17: 8-question journey with exactly 8 `ask.completed` rows correlated to the
displayed IDs, allowlisted metadata, no SecurityAuditEvent, all 16 business tables byte-digest unchanged incl. ToolExecution/
DecisionRun/ActionRequest, question absent from DB and logs; membership removal → 403, one `ask.scope_denied`, full reset,
one picker refresh; revoked token → 401 disconnect, no audit), `ask-races.spec.ts` (6, HTTP interception for race/transport/
malformed probes only), `ask-visual.spec.ts` (3). Support: `tests/support/operator-ask.ts` (answers compiled by the accepted
`packages/ask` modules, imported read-only), `operator-ask-ui.ts`.

## Negative controls (restored bytes, `/tmp/atlas-stage5/askb/s5askb-impl/negative/`)

Unit (`summary-unit.json`, 11/11 caught with concrete assertion failures, every file restored to its exact SHA256):
N01 WHY_URGENT focus binding, N02 urgent-set equality, N03 positional refs, N04 workspace/client binding, N05 SOURCE_STATE
tuple, N06 claims-empty-iff-not-ANSWER, N07 completion guard, N08 selection hook, N09 capability epoch/generation guard, N10
double-submit guard, N11 context/queue/selection/focus/own generation counters. N03 was **first not caught**
(`N03-consecutive-refs.first-uncaught.log`): the hostile ref cases were rejected incidentally; a consistent
renumbering/permutation test was added and N03 then failed as required.
Browser (`summary-browser.json`, rebuilt after mutation and after restore; restored manifest = base): B01 completion guard →
`ask-races` "stale success ignored" fails; B02 input clearing → `ask-fixture` keyboard journey `toHaveValue('')` fails.
Accepted backend authority/fence controls are frozen ASK-A evidence; the unchanged full PG suite (616) plus the real DB browser
journeys establish preservation.

## Production, browser and visual evidence

Clean copy (`prod-staging/`, script `prod-staging.sh`): npm ci of the exact lockfile, generate, build, prune; served from cwd
`/`. Staged dist equals the repository build (0 of 224 files differ); manifest b471a1ce…b029 both; 41/41 served assets
byte-equal; no bare/remote imports. MOCK: capability 200 exact body + UUID header + no-store; Ask POST 200 with exact 15 keys,
echoed requestId, header correlation match; no token 401; Gateway evidence POST 201. OFF: `/operator/` 200, both Ask routes
404, `/clients` 200. Console disabled: `/operator/` 404, API 200. Token and question absent from all logs. Dependency
classification unchanged from the accepted S5 staging (typescript/prisma remain runtime packages; Playwright/PGlite absent).
Browser: @playwright/test 1.56.1, Chromium 141.0.7390.37 headless (`browser-version.json`).

Synthetic PNGs (`visual/askb-{320,768,1440}-{panel,answer,unsupported}.png`, hashes `visual-sha256.txt`): captured only after
the password and question inputs were empty and the page was verified token-free and question-marker-free; no horizontal
overflow at any width; all 9 files contain no marker bytes. Visually inspected (full pages and crops): badge, examples,
input, claims with citation, urgency notice, coverage and cards wrap legibly. A draft set (`visual-draft/`) preceded a badge
prominence fix. No trace/HAR/video/failure screenshots; Playwright's text failure-context files from failing development runs
were checked marker-free and moved to `failed-attempts/`.

## Failed attempts (all in `/tmp/atlas-stage5/askb/s5askb-impl/failed-attempts/` or as named logs)

1. Fixture spec authoring: limit assertion after a later fill; keyboard Tab expected a disabled checkbox. Test fixes.
2. Helper typed into the input while it was correctly hidden during a context reload. Helper now waits for visibility.
3. Shared fixture process exhausted the real 10/60 s actor budget (correct `ASK_BUSY`); now one process per test plus an
   explicit budget journey.
4. Race spec: Playwright treats `aria-disabled` as not enabled, so a duplicate `click()` waited for the 10 s budget; diagnosed
   with temporary logging (pre-debug copy `races.before-debug.ts` restored), duplicates now forced; Chromium logs a 500
   resource line, asserted exactly.
5. PG spec counted the POST twice across helpers; raw request list used.
6. First full run (run1) — see Checks.

## Risks and limits

- MOCK only: no external model, general language understanding or production claim; fixture authority is synthetic. 409
  `ASK_SCOPE_CHANGED`, 429 from global capacity, 503/504 are proven in the browser through interception and units (DB 409/
  barrier behaviour remains ASK-A PG evidence); the real 10/60 s budget 429 and real 401/403 are proven end to end.
- OFF consoles now send one capability GET per credential; Chromium shows its own 404 network line in DevTools.
- The browser derives some honesty checks from the approved bank rules (focus first, entity last, coverage counts,
  truncated ⇒ 100 read, fixture never truncated). They match the accepted server; a future server change to those rules
  would be rejected as RESPONSE_INVALID until the browser copy is updated (parity-tested constants only cover limits/enums).
- The completion guard is layered (abort, own generation, scope/credential epochs, three counters, focus); N11 removes all
  counters together, single counters are not separately killable because the own generation also covers them.
- Every scope/selection change erases a typed but unsent question (required). A locally refused question stays in the field.
- Response `Cache-Control: no-store` is not required by the browser validator (requests use `cache:'no-store'`).
- The question string lives in request closures until the exchange settles; no persistence or forced erasure is claimed.

Acceptance: PENDING fresh explicit gpt-6-astra/xhigh actual-code review; required findings return to this same session.
