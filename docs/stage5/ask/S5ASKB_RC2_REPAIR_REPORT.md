# ASK-B RC2 repair report — R1, R2, R3

Status: **REPAIRED, acceptance PENDING** fresh explicit gpt-6-astra/xhigh. No self-acceptance; no commit, PR, remote,
deployment, LIVE or ASK-REMOTE. Sole checkout write ownership is returned with this report. The RC1 report
(`S5ASKB_IMPLEMENTATION_REPORT.md`, SHA256 b8fd467a…598b) and all RC1/review evidence are unchanged.

## Identity

| Item | Value |
|---|---|
| Implementer | Same ASK-B session de9faf68-215d-4742-8d88-503f198c1f3e, native claude-opus-5-5, effort high (launcher-pinned); native subscription only |
| Review / brief | docs/stage5/reviews/ASTRA_S5ASKB_RC1.md e8ff975d…b3f7; docs/stage5/ask/S5ASKB_RC2_REPAIR_BRIEF.md 13376372…8c |
| Repair baseline | verification/stage5/S5ASKB_RC2_REPAIR_BASELINE.json 1c06fefb…80f8 (RC1 package 0b4ab289…8f30) |
| Final operator manifest | dist/operator/manifest.json 720983066e9ad0419b876d45d13178b27e7d26e4903d323e8b5a8e1befd15be6 (41 assets + manifest) |
| Seals | design 90b5ad7c…, ASK-A 0111e76c…, S5-B 2e6b7b27… re-verified unchanged |

Before the first write: all 1163 baseline source files, all 224 built files and the 5 administrative deltas matched; no extra
source or built file (`/tmp/atlas-stage5/askb/s5askb-rc2-impl/baseline-verify-pre-write.json`). Byte copies of the files to be
repaired were taken from the verified tree (`baseline-src/`) for exact deltas (`repair-deltas.diff`).

## Closure per finding

### R1 — honest INSUFFICIENT rendering (closed)

`ask-messages.ts`: the per-intent RC1 texts (`ASK_INSUFFICIENT_TEXT`, "no observation or stored-read fact…", "This needs a
selected observation…") and "not found in this client's stored read" are removed. An INSUFFICIENT answer now always shows
`ASK_INSUFFICIENT_NEUTRAL` ("No supported claim was compiled for this question. This is not a finding about the source…")
and only notes established by the validated request/bank (`insufficientNotes`, DOM-free): `EMPTY_EVIDENCE` (bank has no
facts), `ASKED_WITHOUT_FOCUS` (focus-dependent intent asked with focus null), `NO_EXACT_TUPLE_READ` (SOURCE_STATE: the focus
fact is present and no returned RESOURCE_STATE has its exact source/type/connection). A requested focus that is not in the
bank is stated by the focus line only: "It is not among the evidence returned with this answer." No valid answer is rejected;
no planner choice is re-derived. `view-ask-answer.ts` renders the neutral box (`.ask-insufficient`) plus notes; cards,
coverage and the all-bank urgency notice are unchanged for every status.

Proof: `tests/operator-ask-rc2.test.ts` (accepted compiler, valid empty plans of all four supported intents with eligible
evidence and present focus → INSUFFICIENT, zero claims, no notes; established absent cases; the real MOCK planner's own
SOURCE_STATE case), `tests/ui/ask-rc2.spec.ts` R1 rendered tests (all four intents with 6 facts + present focus show only the
neutral text, no misleading phrase, cards/coverage/urgency kept; four genuinely absent cases show exactly their one note).
These use an explicitly qualified HTTP response seam for rendering only.

### R2 — deliberate focus change is a generation boundary (closed)

`ask-state.ts`: `useFocus` (the operator's choice) is state. `controller-ask.ts` `focusChanged(useFocus)`: increments a new
focus-choice generation, aborts/invalidates the Ask work, increments the input generation (question cleared) and sets
`ask` to IDLE with the new choice (true only with a selected observation). Every completion additionally checks the captured
focus generation. `controller.ts` exposes `askFocusChanged` (minimal shared hook). `view-ask.ts` listens to the checkbox
`change` event (user changes only) and renders `checked` from `ask.useFocus`; the textarea clearing no longer touches the
checkbox. Programmatic changes stay distinct: a send keeps the sent choice (so the request remains current and the
selected→null/null→selected matrix is reachable in READY and PENDING); scope/selection/queue/context/credential resets clear
the choice without firing `change`. Behaviour change vs RC1: RC1 unchecked the box on send; RC2 keeps it (declared;
the test helper now sets the box before typing because a deliberate change clears a draft).

Proof: unit (both directions on READY; PENDING with late success/error/401/403 under abort never delivered; newer pending
keeps its spinner against every old outcome; fresh UUID; single submit; late 401 after credential replacement; reset clears
the choice). Browser `ask-rc2.spec.ts`: keyboard Space on the checkbox both directions (answer/draft/status cleared, choice
and keyboard focus kept); race with ignored fetch abort and disabled `AbortController.abort` (both directions × late
success/error/401/403 with a newer pending question, plus toggle-without-new-question late success/error); an ACTUAL fixture
MOCK server response held in transit across a checkbox change never renders, then a focused question succeeds.

### R3 — focus/active-page coverage consistency (closed)

`validate-ask.ts`: the focus is exempt from the active-page lifecycle rule only when `coverage.focusExtra` is true
(`activeExceptFocus(evidence, coverage.focusExtra && focus ? focus.ref : null)`); `validate-ask-facts.ts` documents the
parameter as the extra focus ref. Fixture mode still forbids focusExtra, so a fixture focus must be active. The inconsistent
RC1 positive at `tests/operator-ask-validate.test.ts:142` now expects INVALID; a new paired test covers DB extra focus with
RESOLVED/OPEN/ACKNOWLEDGED/SUPPRESSED (valid), the same rows claimed on-page with the count adjusted (nonactive INVALID,
active valid), on-page RESOLVED/SUPPRESSED INVALID, fixture active focus valid, fixture nonactive INVALID with and without
focusExtra. All other bank/coverage/matrix checks unchanged.

## Exact delta from the repair baseline

16 changed + 2 new files (`scope-final.json`); none outside ASK-B scope; no existing S5 spec, backend, API, schema,
dependency, lockfile, build script, norm or status file changed; all 182 non-operator built files byte-identical.

| File | +/- | Purpose |
|---|---|---|
| apps/operator/src/ask-messages.ts | +31/-7 | R1 neutral text, established notes, `insufficientNotes` |
| apps/operator/src/view-ask-answer.ts | +7/-3 | R1 rendering |
| apps/operator/src/ask-state.ts, controller-ask.ts, controller.ts, view-ask.ts | +8/-3, +22/-7, +4/-1, +5/-2 | R2 focus choice + generation |
| apps/operator/src/validate-ask.ts, validate-ask-facts.ts | +2/-1, +6/-3 | R3 |
| apps/operator/styles.css | +3 | spacing of the INSUFFICIENT box and urgency notice (seen in visual review) |
| apps/operator/AGENTS.md, docs/RUNBOOK.md | +2/-2, +2/-2 | documentation accuracy: focus-choice boundary |
| tests/operator-ask-validate.test.ts | +30/-1 | R3 paired tests; RC1 inconsistent positive inverted |
| tests/operator-ask-transport.test.ts | +1/-1 | latent RC1 test flake fixed (see failures) |
| tests/support/operator-ask.ts, operator-ask-ui.ts | +11, +5/-2 | empty-plan answers; checkbox set before typing |
| tests/ui/ask-visual.spec.ts | +8/-1 | INSUFFICIENT capture |
| tests/operator-ask-rc2.test.ts, tests/ui/ask-rc2.spec.ts | new | R1/R2 proof |

## Checks (final run2 on final bytes, `/tmp/atlas-stage5/askb/s5askb-rc2-impl/checks/run2/`)

All 14 pass: npm test **358/358** (351 + 7 new), schema:validate, db:generate, typecheck, ui:typecheck, ui:build, api:build,
api:smoke, pgenv test:pg **616/616**, db:check:pg17, db:check:drift, pgenv test:ui **73/73** (68 + 5 new; real fixture and
confined-PG Ask journeys with real auth/audit retained), git diff --check, untracked whitespace. Zero skipped. Run1
(`checks/run1-pre-css/`, also 14/14 with the same counts) preceded the CSS spacing fix and visual-spec addition.

## Negative controls (`negative/summary.json`, final build base manifest 72098306…)

Seven new restored-byte controls, each removing one repaired guard, 16 focused runs, every run a concrete assertion failure;
each file restored to its exact SHA256; browser controls rebuilt after mutation and after restore (manifest = base):
R1a focus note unconditional (unit + rendered), R1b empty-evidence note unconditional (unit + rendered), R1c RC1 misleading
text restored (unit + rendered), R2a checkbox listener removed (intercepted race + actual fixture server), R2b focus-change
invalidation removed (unit + intercepted race + actual fixture server), R2c focus change without clearing (unit + keyboard),
R3 nonactive-no-extra guard reverted (unit). The pre-CSS full run is preserved in `negative/pre-css/`. The RC1 13 controls and
the reviewer's 4 remain immutable evidence.

## Production, browser, visual

`prod-staging/` (script `prod-staging.sh`, checker `prod-check.mjs`, metadata only — no bodies): fresh copy, npm ci, generate,
build, prune; staged dist = repository build (0 of 224 differ, manifest 72098306… both); served from cwd `/`.
MOCK: 41/41 served assets byte-equal, CSP, capability 200 exact body + UUID header + no-store, Ask 200 with 15 keys, echoed
requestId, header correlation match, no token 401, Gateway evidence 201; real Chromium 141.0.7390.37 workflow: badge, focused
answer with urgent claim, checkbox kept after send, deliberate uncheck clears answer and draft, neutral INSUFFICIENT text,
citation opens a card with no request, disconnect hides Ask, page token-free, 0 console errors. OFF: Ask routes 404, panel
hidden, 0 console errors (only Chromium's capability-404 line is excluded). Console disabled: `/operator/` 404, API 200.
Token and questions absent from all logs. As the reviewer noted, `npm prune` normalizes the staged copy's package-lock.json
(staged only; repository lockfile unchanged).

Visuals (`visual/askb-{320,768,1440}-{panel,answer,unsupported,insufficient}.png`, hashes `visual-sha256.txt`): 12 PNGs
captured after password and question inputs were empty and token/marker checks passed; no overflow; inspected (crops in
`crops/`): neutral INSUFFICIENT box with its one note, urgency, coverage and cards legible with correct spacing. Pre-fix
captures preserved in `visual-pre-css/`. No trace/HAR/video/failure screenshot.

## Failed attempts (preserved under `failed-attempts/` or named files)

1. RC2 browser test used `page.unroute` with a new matcher (no-op), and an RC1 transport test was found flaky: the
   expression `randomUUID().replace(/-4/, '-1')` still yields a valid v4 UUID about 1 in 16 times (1255/20000 measured; it
   replaced the second group's leading 4). Fixed by setting the version digit by index (0/20000). Latent since RC1.
2. Negative control R1a: an unconditional `return` and then an intent-narrowing condition each made the browser TypeScript
   build fail; the runner's `finally` restored the bytes; a non-narrowing condition is used.
3. First control run: R2b was not caught by the intercepted race (a newer submit already voids the old work); a
   toggle-without-new-question case was added, and R2b is now caught at all three levels (`summary.first-run.json`).
4. Visual review found the new box and the urgency notice touching; CSS spacing added; checks, negatives, production and
   visuals were rerun on the final bytes.

## Limitations

- R1/R2 race and rendering proofs use an HTTP response seam (rendering/race only); R2 is also proven against the actual
  fixture server; authorization stays proven by the unchanged PG suite and real DB browser journeys.
- In `current()` the focus-choice generation is layered with the Ask own generation (focusChanged resets both); R2b removes
  both together. Removing only the comparison is not separately observable.
- A deliberate checkbox change erases a typed draft (required by the brief); resets still clear the choice.

Acceptance: PENDING fresh explicit gpt-6-astra/xhigh actual-code review of these exact repaired bytes.
