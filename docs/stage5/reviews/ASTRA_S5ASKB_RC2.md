# ASK-B S5ASKB-rc2 independent acceptance

**APPROVE. Required open: none. Required closed: R1, R2, R3.** The repaired browser OFF/MOCK implementation closes the three RC1 findings on the exact artifact below. Independent reproducers, hostile cases, restored negative controls, full regressions and production checks support acceptance. No implementation repair was made by this reviewer.

Reviewer: fresh explicitly assigned **gpt-6-astra / xhigh**, selected for the focus concurrency/isolation change. The native assignment establishes runtime selection. Provider response-model telemetry and attributable usage are unavailable; neither is claimed. No external inference, API billing or credits were used.

## Exact artifact and preservation

| Item | Identity |
|---|---|
| Artifact | S5ASKB-rc2 |
| Package | `ea8620f374420c7fef3c6261ef3a37d9417add2a0bd3d664eef907a6875d41ad` |
| Manifest SHA256 | `c3ed0686cfaa210671f2bde7b680aa5d5be4a11ab59a247cf9a7f5c2bd389912` |
| Source archive SHA256 | `e252bed65bf8c16465a6cdc543a4b4b43851d375f4bd7f35641fd4610ed40825` |
| Bound implementation evidence SHA256 | `d34aa43357880266bbe4811d5e5945c865cb9c913e1989f819a6fcb49c676cde` |
| Repair baseline SHA256 | `1c06fefbd1dcc977ccaa0d6650a3f6083b23e14e0cf6a21a28661e02fc0480f8` |
| Original implementation baseline SHA256 | `9ee7653f083979da5196ef7079b13dab706bcfc8088248117a2743386f4a8e24` |
| HEAD / branch | `916a4d69853ff6da636e8609a2e0bd33aa787f66` / `planning/stage2-m365`; dirty/untracked artifact, not HEAD-only |
| Operator manifest SHA256 | `720983066e9ad0419b876d45d13178b27e7d26e4903d323e8b5a8e1befd15be6` |

Original checkout `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1` remained read-only. Work was confined to `/tmp/atlas-stage5/askb/astra-s5askb-rc2`. Independently recomputed source, working and built hashes match: **1,110 archived source files, 1,169 manifest working files, 224 built files**. The intentional manifest self-exclusion remains. All **149 bound proof files** exist with matching hashes. Before/after hashing of all **11,191 original files outside Git internals**, including dependencies, ignored files and dist, is identical in paths, bytes and hashes (`identity-*.json`, `original-*.json`). No review Node child remains (`cleanup.json`). Git state was never changed in the original.

The repair changes exactly 16 existing files, adds two focused tests and the repair report, plus packaging records; no baseline file is removed. The full RC1→RC2 delta additionally includes the declared coordinator administrative/review records. Against the original implementation baseline, all 24 changed paths match the declared delta; backend/API/core/schema/roles/dependencies and controlling norms are preserved. All **182 nonoperator built files** remain byte-identical. Primary and restored-negative copies reproduce all 1,110 source and 224 built hashes; the production copy reproduces all 224 built hashes (`scope.json`, `final-integrity.json`).

**Clerical count correction:** `manifest.preservedBaselineFiles` says 1,114. The actual baseline has 1,134 files, 24 changed and zero removed, hence **1,110 unchanged**. Exact path/hash inventories and aggregate identities are correct. This is nonblocking metadata, corrected here without altering the sealed manifest (`manifest-count-correction.json`).

## Required-finding closure

### R1 — CLOSED: honest INSUFFICIENT rendering

`apps/operator/src/ask-messages.ts:74` and `:87`; `view-ask-answer.ts:106`.

A supported empty-ref plan remains valid even with eligible evidence and a present focus. The view now states only that no supported claim was compiled. Optional notes are limited to established predicates: an empty bank, a focus-dependent request with null focus, or a present SOURCE_STATE focus without its exact tuple among returned resources. Missing returned focus is described as absent from this answer's evidence. No planner selection rule is reimplemented, and no legitimate empty plan is rejected.

The adapted original independent browser reproducer compiles empty plans with the unchanged accepted compiler and the actual fixture server context. All four supported intents render INSUFFICIENT with **six facts and a known focus**, neutral text, no false absence/selection note, retained cards and urgency (`probe-browser.*`). The independently rerun suite also covers genuinely absent focus, missing exact tuple and empty-bank notes. Independent negative control making the empty-evidence note unconditional fails the concrete rendered assertion (`negative-r1.log`).

### R2 — CLOSED: deliberate focus changes invalidate older work

`apps/operator/src/view-ask.ts:51`; `controller-ask.ts:107`, `:119`, `:136`; `ask-state.ts`.

A user checkbox change synchronously increments focus and request generations, clears the answer/question and pending status, and retains the new choice only when an observation is selected. Submitting keeps the sent choice, so focused requests remain usable. Scope/selection/context/queue/credential resets clear it programmatically without generating a user change. All completion state changes, including authorization handling, pass the captured credential/scope/context/queue/selection/focus/request checks first. The transport finally callback only cleans its local timer/listener/abort; it does not mutate panel state.

Independent actual-Chromium proof covers **two READY directions plus sixteen PENDING combinations**: both focus directions × late success/429/401/403 × with/without a newer pending question, with `AbortController.abort` suppressed. Old outcomes cannot render, reset scope, refresh the picker or clear the newer spinner; deliberate new submissions use distinct UUIDs and forced duplicate clicks send once. Two held responses are from the actual fixture API; the repeated matrix uses accepted-compiler HTTP seams, explicitly only race proof. Choice persistence and detached old citations after focus reset pass (`probe-focus.*`).

The full browser suite independently verifies keyboard Space/focus retention, actual fixture delayed-response recovery, credential replacement, current401 disconnect, current403 full reset/one picker refresh and all accepted context/filter/page/selection/pagehide/bfcache behavior. Actual confined-PG browser tests provide authority proof. Independent controls removing the checkbox listener and removing the completion-currentness guard fail concrete input-clear and late-render assertions. Fixed-diagnostic reruns reproduce both failures; exact bytes and all built outputs are restored (`negative-r2-*-safe.*`, `negative-r2-safe.json`, `final-integrity.json`).

### R3 — CLOSED: coverage and focus lifecycle agree

`apps/operator/src/validate-ask.ts:134`; `validate-ask-facts.ts:119`.

Only an actual extra DB focus (`coverage.focusExtra`) is exempt from active-page lifecycle checks. Fixture coverage still forbids extra focus. The original reproducer now accepts valid DB extra-RESOLVED and fixture active controls and rejects both nonactive/no-extra variants as whole responses (`probe-coverage.*`). An additional independent **16-case** lifecycle/page-size matrix covers every accepted lifecycle with page sizes 0/2/24/100: true extra focus remains valid, nonactive on-page focus rejects, the page cap holds, and inverted omission flags reject (`probe-lifecycle.*`). The inconsistent RC1 positive test was correctly replaced with paired assertions. Reverting the new gate to the old unconditional focus exception causes the original reproducer to fail (`negative-r3.log`).

## Independent verification

| Check | Result and evidence |
|---|---|
| Unit/PGlite | **358/358**, zero failures/skips; `unit.log` |
| Root/browser typecheck | Pass; `typecheck.log`, `ui-typecheck.log` |
| API/operator build | Pass; all **224** built hashes reproduced; `api-build.log`, `final-integrity.json` |
| Actual PostgreSQL suite | **616/616**, zero failures/skips; `pg.log`, `run-pg.mjs` |
| Full actual browser suite | **73/73**, retaining all 50 established console regressions; `browser.log` |
| Independent compiler/validator probe | **50** matrix combinations, **13** hostile rejections, four supported nonempty-bank INSUFFICIENT cases, mixed eligible SUMMARY accepted; `probe-validation.*` |
| Independent transport probe | **19** checks: Unicode/control boundaries, opaque ID, exact body/fixed options, fatal UTF-8, incremental cap, wrong scope/status, original serialization deadline, never-settling read/cancellation; `probe-transport.*` |
| Independent focus/browser closure | 2 READY +16 PENDING combinations; four empty-plan intents; obsolete E1 handlers across newer answers/focus reset/disconnect; no current-panel mutation or citation network; `probe-focus.*`, `probe-browser.*` |
| Independent negative controls | Six distinct controls (R1, focus listener, completion currentness, R3, scope, all-bank urgency), eight concrete failing executions including two safe-diagnostic reruns, exact restoration and rebuild; `negative*.json`, corresponding logs/scripts |
| Fresh production | Sealed copy; offline clean install, generate, build, dev-prune all pass; foreign cwd `/`; **41/41** served assets match, MOCK200, Gateway201, OFF404/hidden Ask, actual browser workflow; `production-*`, `probe-production.*` |
| Synthetic visual review | Personally inspected independent 320/768/1440 Ask-region PNGs, plus final bound insufficient crop; wrapping, controls, claims, urgency, coverage and cards legible; no horizontal overflow; `visual/production-ask-*.png` |
| Preservation | Original11,191-file inventory identical; primary/restored-negative source1110+build224 exact; `identity-after.json`, `final-integrity.json` |

PG/browser tests used only the silent approved wrapper with one absolute runner and explicit child cwd/argv. Wrapper contents, environment, database URLs and credentials were never read or printed. The actual DB browser journey exercises a context-only actor, supported RU/EN input, insufficient/unsupported outcomes, correlated allowlisted audits, unchanged business-table digests, membership deletion→403 and token revocation→401. No HTTP mock is used to claim authority.

Source review confirms capability lifetime differs from Ask scope lifetime; once-per-credential discovery follows validated clients, exact200/header validation and own404 OFF. Fixed operations keep the bearer in its closure; request and response caps use one original budget. Whole-answer validation retains exact shapes/projections, scope/focus binding, consecutive refs, exact compiler matrix, unique claim refs, SOURCE tuple and ENTITY confirmed-ID/kind semantics, coverage and independent ALL-bank urgency for every status. Safe text DOM and request-local card maps remain intact. No partial answer, source URL, action route, provider inference or history was introduced.

I assessed all14 bound final check logs/summaries, including schema validation/generation, smoke, PG17/drift and whitespace. The independent full unit/PG/browser/type/build checks above reproduce the affected acceptance evidence; the other standalone checks are reviewed hash-bound implementation evidence, not falsely claimed independent reruns. The seven implementer negative controls/16 failing runs and preserved failed attempts were assessed as supplemental evidence. The UUID-test repair sets the version digit deterministically without weakening the malformed-ID assertion; the CSS delta adds only spacing.

## Qualifications and residuals

- First reviewer focus-probe attempt used an ordinary second Playwright click. It waited for `aria-disabled` to clear, spent the request's ten-second deadline and then failed a spinner assertion. This was a harness error, not a product failure. The preserved attempt/diagnosis and corrected forced-click matrix are in `probe-focus-attempt1.*` and `probe-focus.*`. Repeated race cases use explicitly qualified compiler seams to avoid treating the server's ten-question rolling budget as a race failure.
- Two initial negative logs contained Node assertion value diffs with synthetic rendered HTML or a synthetic draft. Those value diffs were removed; fixed failure text, original log hash/byte count and a sanitization receipt are preserved. Probes now emit only the first fixed diagnostic line; both controls were rerun and fail identically with safe logs (`diagnostic-sanitization.json`, `negative-r2-safe.json`). No credential or real customer data was involved. This review-harness correction is not application privacy evidence.
- Production `npm prune` normalizes only root version metadata at `/version` and `/packages//version` in its isolated lockfile. Dependency entries, application source and built bytes do not change; original and primary/negative lockfiles remain exact (`production-lock-normalization.json`).
- Focus generation and Ask request generation deliberately overlap; the acceptance claim is for the complete currentness boundary. Tests do not pretend that each redundant comparison is separately observable.
- Screenshots are synthetic and taken only after token/question inputs were empty and token/marker-free checks passed. No trace, HAR, video or failure screenshots were taken. Actual Chromium version: **141.0.7390.37**.
- Acceptance is for the approved browser OFF/MOCK checkpoint and preserved accepted dependencies. It grants no deployment, LIVE/pilot, vendor read or external-inference approval.

**Final disposition: APPROVE — requiredOpen [], requiredClosed [R1, R2, R3].** Evidence inventory: `EVIDENCE.json`.
