# ASK-REMOTE R-C implementation report (S5ASKREMOTE-RC-rc1)

Status: **IMPLEMENTED; acceptance PENDING fresh independent Astra/xhigh.** Offline engineering checkpoint only. No paid or
provider call, key, account, admission, `ask:remote` grant, real data, R-EVAL, deployment, commit or PR.

## Identity and execution

- Implementer: native Claude Code `claude-opus-5-5`, effort high (preflight), fresh session
  `52b493a5-deaf-4f34-8374-c9b253f641bd`; actual response model in the session stream `claude-opus-5-5`, `apiKeySource: none`
  (included subscription; no API/credits/fallback). Quota attribution unknown. Sole checkout writer; no other agent or model
  subprocess. Elapsed about 40 minutes wall clock (2026-10-11 04:28Z launch → 05:08Z), excluding Astra review.
- Before any write: `verification/stage5/S5ASKREMOTE_RC_IMPLEMENTATION_BASELINE.json` (sha256 `510b3707…a4443f2`) verified
  exactly — 1298 working files (baseline itself excluded), 244 compiled outputs, 12 dependency seals, brief/preflight/design
  seal and closure hashes, HEAD `916a4d6`, branch `planning/stage2-m365`. Proof `/tmp/atlas-stage5/askremote/rc/impl/PREWRITE_PROOF.json`.
- Instructions read explicitly (safe mode): root AGENTS.md, AI_CONTEXT_MAP rows, DEVELOPMENT_WORKFLOW roles/handoff/provider,
  docs/stage5/AGENTS.md, docs/stage5/ask/AGENTS.md, remote AGENTS/README/DESIGN_STATUS/02/05, apps/operator/AGENTS.md.
  No contract contradiction found; no public-contract/authority change was needed.

## Changed behavior (browser only; existing server V2 contracts authoritative and unchanged)

- **Capability.** GET `/ask/capabilities` once per credential as before. The body's own `contractVersion` selects the exact
  validator: exact V1 = MOCK (unchanged), exact `AskCapabilityV2` = REMOTE with EVERY disclosure key (fixed provider/model/
  profile/sent/dataClass/region/retention, reserve number 300000, lowercase UUIDv4 admissionId, canonical positive decimal
  policyVersion string ≤ 2^63−1 checked with BigInt and kept as the string, never a Number). 404 alone = OFF; 503
  `ASK_REMOTE_NOT_ADMITTED` and every other failure = unavailable with a manual retry (never OFF). Capability is shown as
  information, not authority.
- **Request.** New closed operation `AskRemoteOperation` and builder `askRemoteBody` (operations.ts) → exact five-key
  `AskRequestV2` with the four-key acknowledgement copied from the operation (never defaulted/injected); new holder method
  `askRemote` (credential.ts) — the same private POST path/options. MOCK keeps sending exact V1; no fallback or downgrade.
- **Consent (controller-ask.ts, ask-state.ts).** `AskState.consent` (boolean for the current draft only). A REMOTE submit needs
  the consent state AND the box as shown; question, focus and disclosure tuple are captured before input and consent are
  cleared; fresh UUIDv4 per submit; one pending question. Consent resets on edit, send, focus change (both directions), credential,
  client/scope, context, queue, page, filter, observation, capability refresh, disconnect, pagehide and bfcache restore.
  REMOTE-only `questionEdited` invalidates a pending question and clears consent/answer while keeping the draft; MOCK typing is
  a no-op (accepted behavior). Local refusal `CONSENT` sends nothing.
- **Generations.** New disclosure generation (capability load/refresh, credential, current policy change) joins every
  completion guard. A CURRENT validated 409 `ASK_REMOTE_POLICY_CHANGED` clears input/answer/consent, marks Ask unavailable and
  offers only "Refresh the remote Ask disclosure"; no auto refresh/resubmit. Refresh is a full Ask boundary even when the same
  tuple returns. Stale success/error/401/403/409 never changes state; actual current browser 401/403 keep accepted behavior.
- **Answer.** `validateRemoteAnswer`: exact 15 V1 keys + `provenance`, AskAnswerV2/remote/db (captured context db too), exact
  fixed provenance; then the SAME shared V1 predicates (`answerFacts`: request/focus/scope binding, bank, coverage, urgency,
  claim matrix). V1 validation is unchanged (refactor only). Remote error codes accepted only on REMOTE questions and capability
  discovery, with their fixed statuses; MOCK exchanges keep the V1 list. `AskAnswerView.mode` added.
- **View.** Fixed local disclosure (headline “OpenAI GPT-6 Luna interprets the question; Atlas compiles facts locally.”, what
  leaves Atlas, separate API billing, owner-verified retention, synthetic only, information-not-permission), visible cost
  notice “Up to US$0.30 reserved per attempt; unknown outcomes retain this reservation.”, the four tasks, a details block with
  the fixed values and the admission tuple; separate initially unchecked consent “I consent to sending this question to OpenAI
  and confirm it is synthetic.”. No links/selectors/key entry/policy editor. MOCK label/intro/examples only in MOCK; REMOTE
  badge, pending, origin and unsupported texts; badge “mode not confirmed” while unavailable (ERROR) — a visible change for a
  MOCK capability error too, so no MOCK claim is made when the mode is unknown.

## Changed paths

Existing (17): apps/operator/{AGENTS.md,index.html,styles.css}; apps/operator/src/{ask-contracts,ask-messages,ask-state,
ask-transport,controller-ask,controller,credential,operations,validate-ask,view-ask-answer,view-ask}.ts; docs/AI_CONTEXT_MAP.md
(R-C row only); docs/RUNBOOK.md (new §16); tests/operator-transport.test.ts (exact holder surface + `askRemote`, see F1).
Added: tests/operator-ask-remote-{validate,transport,controller}.test.ts; tests/ui/ask-remote-{ui,races,pg}.spec.ts;
tests/support/{operator-ask-remote,operator-ask-remote-ui,ask-remote-console}.ts; this report. Removed: none.
Built delta: 14 `dist/operator/*` files (js, index.html, styles.css, manifest); 244 outputs total; no server module changed.
No backend, Prisma/migration/roles, provider adapter, ledger, auth, dependency/lockfile/tsconfig, norm, history, status,
baseline, preflight or seal change (scope-final.json). Largest module: controller-ask.ts 220 lines.

## Tests and evidence

Focused units (19 new): V2 parity with the R-B server values; policyVersion parity with the server parser on 36 edge values
incl. 2^53+1, max, max+1, padded/exponent/Unicode digits, Number/BigInt inputs; capability V2 rejections (39 hostile bodies, missing header, V1/V2 mixing); every
server-compiled V2 answer (6 focus cases × 5 intents) validates and equals the V1 view of the same intent except `mode`;
V2 envelope/shared-predicate rejections cross-checked against V1; remote codes; AskRequestV2 accepted unchanged by the R-B
parser; holder/transport caps, fatal UTF-8 and the one 10 s budget; controller consent/edit/focus/boundary/409/current-vs-stale
auth with ignored abort. Browser route-stub (9 new): disclosure/consent/capture-then-clear/exact body/local citations incl. a
detached stale citation; malformed answers and remote errors; NOT_ADMITTED unavailable; 409→manual refresh→new consent/UUID/
version; keyboard journey at 320/768/1440 without overflow; REMOTE typing during pending vs MOCK typing; every boundary × late
success/error/409/401/403 with a newer spinner; credential replacement, pagehide, bfcache. Real PG (4 new, distinct from route
stubs): compiled remote composition + console in-process with the R-B scripted offline provider seam and a network trap —
consented journey with real ledger (3 × SETTLED/USAGE_VERIFIED/222) and fixed audit, question only in the captured synthetic
request; actual policy revision → 409 before reservation → refresh → success; upstream 429/500/404/401 → 503 UNAVAILABLE
without sign-out/scope/OFF (401 then pauses the policy → 409 → refresh → NOT_ADMITTED); missing `ask:remote` → actual 403
reset; revoked token → actual 401; plus an actual compiled process in REMOTE with production seams and no policy.

ALL14 (run1, 2026-10-11 05:00–05:06Z, all exit 0): npm test 424/424 (405 accepted + 19); schema:validate; db:generate;
typecheck; ui:typecheck; ui:build (41 assets); api:build; api:smoke; test:pg 687/687; db:check:pg17; db:check:drift; test:ui
86 passed (73 accepted + 13); git diff --check; untracked whitespace. No earlier assertion removed or weakened.

Production: clean sealed-source copy, npm ci, generate, build, dev prune (staging run2): staged dist = repository dist (0 of 244
differ); served assets 41/41 match, CSP; foreign cwd `/` fixture MOCK browser workflow and OFF (404, no panel); console
disabled 404; fixture+remote refused; DB smoke under the network trap: off/mock/remote(no policy)/remote(INACTIVE policy) —
remote capability and POST 503 NOT_ADMITTED (POST with a foreign tuple 409), real Chromium shows "unavailable, not switched off",
no form, no MOCK claim; 0 network attempts; policy stays INACTIVE v1; token/question absent from logs.

Mutations (isolated copies, root identity verified unchanged; pristine unit and browser controls pass): 22/23 meaningful mutants
KILLED by relevant assertions — consent bypass, consent state ignored, edit hook off, edit hook in MOCK, policy 409 ignored,
refresh without clearing, provenance unchecked, V2 mode mock, V2-only urgency weakening, mode downgrade to V1, stale auth, stale
finally clearing a newer spinner, disclosure fixed values unchecked, Number policyVersion, defaulted acknowledgement, 503 as
OFF, auto refresh after 409, remote codes in MOCK, and browser consent render / edit wiring / MOCK examples in REMOTE.
M05 (disclosure generation removed from the completion guard) SURVIVES by design: every disclosure boundary also resets the Ask
work generation, so it is a redundant defense-in-depth layer (qualified, as the brief allows). R-B mutants are not reused.

## Preserved failures (scratch FAILURES.md)

F1 exact holder-surface test vs the new closed `askRemote` operation — intended; expected list extended, still exact.
F2 browser race test defect (re-clicked the selected observation; its own edit invalidated the held question) — test fixed.
F3 production DB smoke waited for queue rows the standard seed does not have; one own staged server leaked on that error and was
terminated (DB already dropped; inventory unchanged) — script fixed, staging re-run in full. No product-code repair was needed.

## Cleanup and residuals

PG inventory names before/after identical (5 databases incl. 4 pre-existing `atlas_it_*` untouched, 28 roles); all owned
disposable databases dropped; staging copies and mutant copies removed; no subprocess left running. Residuals as 02/05: the
question is not sanitized and accepted egress is irreversible; consent is an operator declaration, not authority; unknown
outcomes keep the reservation; real provider/TLS/quality/latency unverified (R-EVAL NOT_ADMITTED); the route-stub suites do
not prove authorization. Evidence: `/tmp/atlas-stage5/askremote/rc/impl/EVIDENCE_INDEX.json`, `scope-final.json`.

**Next:** Codex packages the exact source/evidence; fresh independent Astra/xhigh reviews the actual code. Required fixes return
to this SAME session. R-C stops here.
