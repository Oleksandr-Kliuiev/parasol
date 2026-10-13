# ASK-B S5ASKB-rc1 independent acceptance

**CHANGES_REQUIRED — R1, R2 and R3 must close before ASK-B acceptance.** The established test suites pass, but independent hostile-state and browser probes demonstrate three public-contract failures. No implementation repairs were made.

Reviewer runtime assignment: **gpt-6-astra, xhigh, fresh context**. This is the first independent actual-code acceptance review of this ASK-B artifact. The explicit native assignment establishes the requested runtime selection; provider response-model telemetry and attributable usage are not exposed, so neither is claimed. No external inference, API billing or credits were used.

## Exact reviewed identity and preservation

| Item | Value |
|---|---|
| Artifact | S5ASKB-rc1 |
| Package | `0b4ab289f229e8f01f3e7584d0fd7ffc478547905da42cecde38ad6cdd9f8f30` |
| Manifest SHA256 | `329e75bf2227c5c03ccaa6bcaf4114d17ea509225d833ef5a4c957b021281cbf` |
| Sealed source archive SHA256 | `64d113bb0f934143f81fe950e4257eaef2b811b6582708f67c8469a21e4e6760` |
| Bound implementation evidence SHA256 | `885369011e097101ac85e2cde64959013236d73f4ed4a4e37063d871b858a033` |
| Baseline SHA256 | `9ee7653f083979da5196ef7079b13dab706bcfc8088248117a2743386f4a8e24` |
| HEAD / branch | `916a4d69853ff6da636e8609a2e0bd33aa787f66` / `planning/stage2-m365` (dirty/untracked artifact; HEAD alone is insufficient) |
| Operator manifest SHA256 | `b471a1ceca89bbd881c58be0f18655a5902119ff968783f7728c7eb35693b029` |

Original repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`, kept read-only. All work was inside `/tmp/atlas-stage5/askb/astra-s5askb-rc1`. Source, working and built aggregate hashes were independently recomputed; 1,097 archived source files, 1,156 manifest working files and all 224 built files matched. The sole additional Git-enumerated file was the manifest itself, an intentional packaging self-exclusion. All 125 bound proof files exist and match their recorded hashes.

Against the implementation baseline, exactly the declared 19 existing files changed; no baseline file was removed. Backend/core/schema/roles/dependencies and controlling norms remain unchanged; all 182 nonoperator built files are byte-identical. The final manifest has 19 new source/report files plus three packaging/baseline records; the implementation report's earlier 18-new count is a pre-report count, not the controlling inventory.

The complete original filesystem file inventory, including dependencies, ignored files and built outputs, was hashed before and after: **11,372 files, identical paths, bytes and hashes** (`identity-before.json`, `identity-after.json`, `original-before.json`, `original-after.json`). All 1,097 reviewed source files and 224 built files match in the primary and restored-negative scratch copies. No matching test/API child process remained.

## Required findings

### R1 — P2: insufficient-answer text asserts absence that the contract does not establish

**Location:** `apps/operator/src/ask-messages.ts:70`–74; unconditional use at `apps/operator/src/view-ask-answer.ts:106`.

**Trigger:** A supported plan contains zero refs while its valid returned bank has observations/resources and a present focus. The approved compiler matrix explicitly permits this and produces `INSUFFICIENT`, zero claims, preserving bank/coverage/urgency. The validator correctly accepts it. The view nevertheless says SUMMARY has no observation or stored-read fact to summarize. WHY_URGENT and ENTITY tell the operator to select an observation even when the same rendered answer confirms the requested focus and includes its eligible fact. SOURCE_STATE similarly presumes a missing prerequisite from the status alone.

**Independent proof:** `probe-browser.mjs` compiles valid empty plans using the unchanged accepted compiler and the actual fixture server's context, then delivers them through an explicitly qualified HTTP response seam. All four supported intents render `INSUFFICIENT` with **six facts and a known focus**. SUMMARY displays the false no-facts assertion; the two focus messages give selection guidance despite the known focus. `probe-browser.json` contains only fixed/boolean metadata. `probe-browser.log` records the concrete failed assertion. This is rendering/contract proof, not an authority claim.

**Impact:** The UI turns a lack of compiled claims into an unsupported claim about missing source evidence, contradicting the cards and weakening the approved bounded-absence semantics.

**Closure:** Use a neutral no-supported-claims explanation, or distinguish only conditions actually established by the validated bank/focus. Do not reject these valid answers or reimplement private planner selection. Add rendered tests for all four supported empty-ref intents with eligible evidence present, alongside genuinely absent focus/fact cases. Preserve evidence, coverage and independent urgency for every status.

### R2 — P2: a manual focus checkbox change does not invalidate Ask work

**Location:** `apps/operator/src/view-ask.ts:46`–52 and `apps/operator/src/controller-ask.ts:100`–104.

**Trigger:** With a selected observation, complete an Ask without focus, then type a draft and manually toggle “Use selected observation.” The old answer and draft remain. Alternatively hold an actual fixture Ask response in transit, then type a draft and toggle the checkbox. The request remains pending and its old-focus answer renders after release. The view installs no focus-change handler; the controller has no corresponding focus generation hook. Capturing `state.observationId` does not detect null-focus ↔ selected-focus changes when the selected row stays the same.

**Independent proof:** `probe-focus.mjs` delays an actual fixture API response using HTTP interception. `probe-focus.json` records `answerCleared:false`, `inputCleared:false`, `pendingInvalidated:false`, and `lateAnswerRendered:true`; `probe-focus.log` preserves the failed assertion. No credential or source text is printed. The approved Q7 matrix explicitly includes delayed results across **observation/focus change**, and the implementation brief requires focus changes to clear/invalidate synchronously.

**Impact:** A visible focus change leaves earlier-focus work active and permits it to overwrite the answer panel, bypassing an approved generation boundary.

**Closure:** Route deliberate checkbox changes through an explicit controller invalidation/generation path and clear the applicable answer/question state synchronously. Keep programmatic checkbox clearing on submit distinct from a user focus change so normal focused submissions remain usable. Capture/check the resulting focus identity for every outcome. Cover both directions, ready/pending states, ignored aborts, stale success/error/401/403 and a newer pending request; preserve current authorization handling and single-submit behavior.

### R3 — P2: whole-answer validation allows a nonactive focus to masquerade as an active-page row

**Location:** `apps/operator/src/validate-ask.ts:65`–72, in combination with the unconditional focus exception in `apps/operator/src/validate-ask-facts.ts:115`–117. The existing test at `tests/operator-ask-validate.test.ts:142` explicitly accepts the inconsistent case.

**Trigger:** A bank's focus observation is RESOLVED (or another nonactive lifecycle), but coverage says `focusExtra:false`, with `observationsRead` adjusted to keep the numeric bank-count equation valid. The validator accepts it. It also accepts a RESOLVED fixture focus although fixture coverage disallows extra focus rows. The public contract defines observationsRead as the active page and focusExtra as true exactly for a returned focus outside that page. The accepted reader reuses the active page's row when focus is on-page; it cannot produce this combination.

**Independent proof:** `probe-coverage.mjs` first accepts valid DB extra-RESOLVED and fixture active-focus controls. It then demonstrates acceptance of both malformed variants. `probe-coverage.json` records all four booleans; `probe-coverage.log` records the failed rejection assertion. This checks public state/coverage consistency, not planner membership or an invented source-order rule.

**Impact:** A malformed whole response survives validation and misreports a resolved observation as part of the active read instead of rejecting the entire answer.

**Closure:** When focusExtra is false, any returned focus must have an active-page status. Continue permitting every accepted lifecycle for an actual extra DB focus, including active rows beyond the page. Replace the inconsistent positive test with paired positive/negative tests and retain exact bank counts, fixture restrictions, omitted flags and all existing matrix checks.

## Independent verification and reviewed evidence

| Check | Result / proof |
|---|---|
| Unit/PGlite suite | **351/351**, zero failures/skips; `unit.log` |
| Typecheck / browser typecheck | Both pass; `typecheck.log`, `ui-typecheck.log` |
| Isolated API/operator build | Pass; exact 224-file artifact; `api-build.log`, `scratch-integrity.json` |
| Actual PostgreSQL suite | **616/616**, zero failures/skips; `pg.log`, `run-pg.mjs` |
| Full actual browser suite | **68/68**, including all 50 established regressions and 18 ASK-B additions; `browser.log` |
| Additional matrix/hostile probe | 50 compiler/validator combinations, 13 independent hostile rejections, four supported nonempty-bank INSUFFICIENT cases and a valid mixed eligible SUMMARY; `probe-validation.*` |
| Obsolete citation controls | Old E1 handler opens only its detached card; newer panel remains byte-identical, no network, current cards remain closed; after disconnect no panel resurrection; `probe-browser.*` |
| Independent negative controls | Removing scope, positional-ref, all-bank urgency or completion-generation guards causes concrete assertion failures; all four restored to exact source hashes; `negative.json`, `negative-*.log` |
| Restored negative build | Rebuilt after restoration; all 224 built files and all source files match; `negative-restored-build.log`, `scratch-integrity.json` |
| Production install/build/prune | Fresh sealed copy; `npm ci --offline`, generate, build, prune all pass; `production-*.log`, `production-setup.json` |
| Production serving + browser | Launched with cwd `/`; all **41/41** served assets match; MOCK capability 200, actual browser answer/citations/disconnect, Gateway evidence 201; OFF capability 404, Ask hidden, clients work; `production-browser.json` |
| Visual inspection | Personally inspected three synthetic Ask-region PNGs at viewport 320/768/1440: wrapping, badge, claims, urgency, coverage and opened cards are legible, no horizontal overflow; `visual/production-ask-*.png` |
| Original preservation / cleanup | 11,372 original files unchanged; no remaining matching API/browser-test process; `identity-after.json`, `cleanup.json` |

The full PG/browser runs use the real confined disposable PG path, including ASK-B authorization/audit integration: context-only actor journey, membership removal/full 403 reset and one picker refresh, token revocation/401 disconnect, exact correlated allowlisted audits, and unchanged business-table digests. No HTTP interception is used to claim authority. PG execution used only the silent approved wrapper with one absolute runner argument and explicit child cwd. Its contents, environment, URLs and credentials were never read or printed.

I inspected the implementation's 14 final check summaries and relevant final logs, not just totals: schema validation/generation, both typechecks/builds, API smoke, PG17/schema-drift checks, browser tests and whitespace checks all passed in bound run2. The old-test deltas are narrowly scoped to the declared capability/OFF compatibility and approved route/module checks. Fresh regressions independently reproduce the 351/616/68 totals. I did not claim independent reruns of every standalone implementation check; the remaining standalone check results are hash-bound reviewed evidence.

Source inspection confirmed fixed operations/options, closure-held credential, exact four-field request and response projections, codepoint/byte caps, one original transport budget, exact claim matrix/source tuple/entity semantics, mandatory all-bank urgency, safe text DOM and request-local card maps. Existing transport tests exercise deadline crossings in serialization/read/decode/parse/validation. Existing controller/browser tests plus independent negative controls establish the covered credential/scope/context/queue/selection generations; R2 is the uncovered focus-checkbox boundary.

## Qualifications and residuals

- First browser-probe attempt used independently regenerated fixture IDs, so focus was missing. It still demonstrated SUMMARY's no-facts contradiction, but was insufficient for present-focus claims. The original attempt is preserved in `probe-browser-attempt1.*`; the corrected probe uses the actual server context and proves all four present-focus cases. No application fix was made.
- The first scratch-integrity assertion detected production `package-lock.json` normalization by npm: only root version metadata at the top level and `packages[""]` changed. The exact before/after hashes and structural delta are in `production-prune-lock-delta.json`; no dependency entry, reviewed application code or built byte changed. The original and other scratch source copies are untouched. This expected isolated install/prune effect is preserved rather than hidden; `final-integrity-attempt1.*` records the initial check failure.
- Synthetic screenshots were taken only after both inputs were empty and DOM token/question-marker checks passed. No trace, HAR, video, failure screenshot or real customer/credential capture was made. Negative logs retain only fixed test/assertion diagnostics; request/answer/source payload dumps are discarded rather than persisted.
- Production screenshots exercise the real pruned build, with Chromium **141.0.7390.37**. Fixture authority is synthetic. The actual PG suite supplies database authority evidence. R1 and R2 HTTP seams prove only the specified rendering/race behavior; R3 is a direct validator probe.
- Backend authority/fence/ownership behavior and controlling contracts were preserved. This review grants no deployment, live-source, remote-inference or external-provider approval.
- R2 changes a concurrency/isolation boundary, so closure should receive fresh explicit Astra/xhigh acceptance of the repaired exact artifact after the same implementation session addresses required findings. Green existing suites alone do not close these independent failures.

**Disposition: CHANGES_REQUIRED.** Evidence inventory: `EVIDENCE.json`. No dependent checkpoint should advance on S5ASKB-rc1.
