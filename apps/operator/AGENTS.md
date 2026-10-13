# Local operator console (Stage 5)

Contracts: `docs/stage5/` (02 contracts, 03 security/state, 04 architecture); S5-B field allowlists, limits and the
evidence table: `docs/stage5/S5B_IMPLEMENTATION_BRIEF_RC2.md`. S5-A: opt-in serving, memory-only credential with epochs,
fixed transport, validated client picker. S5-B: validated context projection, observation queue, selected detail and
explicit stored evidence. ASK-B (dual-approved Ask RC3, `docs/stage5/ask/`, brief `S5ASKB_IMPLEMENTATION_BRIEF.md`): the
capability-gated OFF/MOCK Ask panel. ASK-REMOTE R-C (dual-approved remote DESIGN RC2, `docs/stage5/ask/remote/02`, brief
`S5ASKREMOTE_RC_IMPLEMENTATION_BRIEF.md`): the REMOTE V2 capability/request/answer, disclosure, per-question consent and
disclosure/policy generations in the same Ask modules (offline only; no activation). LIVE and any other chat/action remain gates.

| Concern | File |
|---|---|
| Browser copies of accepted patterns/enums/limits and the validated projection types (parity: `tests/operator-contracts.test.ts`) | `src/contracts.ts` |
| Fixed operations (GET clients/overview/observations, closed evidence POST), credential closure, bounded transport | `src/operations.ts`, `src/credential.ts`, `src/transport.ts` |
| DB queue selection (canonical, offered page sizes); evidence allowlist/tuple; confirmed-only entity rule | `src/queue-query.ts`, `src/evidence-plan.ts`, `src/entities.ts` |
| Response validators (whole response or fixed code, explicit projections) | `src/validate-core.ts`, `validate-clients.ts`, `validate-context.ts`, `validate-observations.ts`, `validate-resources.ts`, `validate-evidence.ts` |
| State, epochs/generations; session/picker/context, queue and evidence controllers | `src/state.ts`, `src/panels.ts`, `src/controller.ts`, `src/controller-queue.ts`, `src/controller-evidence.ts` |
| DOM: safe construction, shared parts, one view per region, composition | `src/dom.ts`, `view-parts.ts`, `view-{clients,scope,context,queue,detail,evidence}.ts`, `view.ts`, `main.ts`, `index.html`, `styles.css` |
| Ask Atlas (OFF/MOCK): contract copies (parity with `packages/ask`), whole-answer/capability/error validation, bounded Ask transport, state, controller, fixed text, panel and answer/citation views | `src/ask-contracts.ts`, `validate-ask-facts.ts`, `validate-ask.ts`, `ask-transport.ts`, `ask-state.ts`, `controller-ask.ts`, `ask-messages.ts`, `view-ask.ts`, `view-ask-answer.ts` |
| ASK-REMOTE (R-C): V2 copies (parity with `packages/ask/remote/{contracts,budget}.ts`), BigInt-range policyVersion, closed AskRequestV2 builder, V2 capability/answer/remote-code validation sharing the V1 predicates, consent/edit/disclosure generations, fixed disclosure text | `ask-contracts.ts`, `operations.ts`, `credential.ts` (askRemote), `validate-ask.ts`, `ask-transport.ts`, `ask-state.ts`, `controller-ask.ts`, `ask-messages.ts`, `view-ask.ts`; tests `tests/operator-ask-remote-*.test.ts`, `tests/ui/ask-remote-*.spec.ts` |
| Server: flag, asset manifest/loader, Host gate + headers | `apps/api/src/operator/{console,manifest,assets,http}.ts`; build `scripts/operator-build.ts` |

Rules:
- The token exists only inside `createCredentialHolder`. Never add a getter, export, log, storage, cookie, URL, DOM value
  or attribute for it. State (`state.ts`) never holds it. Malformed input is refused, never trimmed.
- Operations are closed typed values: no caller URL/method/header/tool/parameters. GET success is exactly 200; the evidence
  POST success is exactly the controllers' 201. Tool names/parameters come only from `evidence-plan.ts` and the validated
  selection; a malformed reference or unsupported source/type (and fixture Huntress) sends nothing. No retry.
- Every completion checks credential epoch, scope epoch and panel generation before changing state; evidence also the
  selected observation and its exact source tuple. Abort is not isolation. Any current 401 disconnects; any current 403
  (context, queue or evidence) clears the scope and refreshes the picker once, no auto-select, no recursion.
- The queue starts only after a validated context; filter/page/refresh clear page, selection and evidence first; next page
  replaces the one retained page; server order is kept. Fixture contexts: GET with no query, no filter/paging control.
- Validate whole responses before committing; unknown enums/shapes are `RESPONSE_INVALID`, caps `RESPONSE_TOO_LARGE`.
  Copy explicit projections; never retain/spread raw objects, Person.email, facts/externalDevice/receivedAt, safeErrorCode,
  financial/M365 content. Show fixed codes/messages only, never server bodies or raw JSON.
- Source HIGH/CRITICAL is visibly urgent (text, not colour alone) whatever the confidence, route or priority label. An entity
  is "confirmed" only by exact ID + one current row + a CONFIRMED link; otherwise unresolved/unavailable. Conflict and
  superseded references are text only. Empty evidence means "not in this stored read"; truncated empty may exist beyond it;
  ERROR/MISSING are unavailable, never empty. Overview, queue and evidence are never presented as one atomic snapshot.
- Render with `createElement`/`textContent` only; attributes only from literal names (`aria-*`) with computed values; no
  `innerHTML`, inline script/style, handler attributes, links from source values, remote resources, eval or source maps
  (`tests/ui/artifact.spec.ts`). New operations need a reviewed contract change.
- Modules listed as shared in `tests/operator-contracts.test.ts` stay DOM-free; only `dom.ts`, `view*.ts`, `main.ts` touch
  the document, and no view module imports the credential or transport. Browser code is checked by `npm run ui:typecheck`.
- Ask (docs/stage5/ask/03 "Browser state"): only GET `/ask/capabilities` and POST `/clients/:id/ask` exist, built by
  `operations.ts` and sent only by the holder; success exactly 200; capability once per credential after a validated client
  list, only 404 means OFF (no panel); input only for MOCK + current validated context. The request is exactly AskRequestV1
  (fresh lowercase UUIDv4, question unchanged ≤2000 code points, optional exact selected observation ID). The whole answer
  is validated (exact keys, request/focus/scope binding, bank, coverage, urgency set, claim matrix) or discarded. Every
  completion checks credential/scope/context/queue/selection/focus-choice/own generation; every such change, including a deliberate
  "Use selected observation" change (kept as the operator's choice), clears answer and question synchronously. Claims render only through `ask-messages.ts`; citations open cards of the same answer only. No question,
  answer or history is kept beyond the one current answer; nothing is stored, logged or put in a URL.
- ASK-REMOTE (docs/stage5/ask/remote/02): the SAME two operations through the holder. The capability body decides the mode by
  its own contractVersion: exact V1 = MOCK (unchanged), exact V2 = REMOTE with every disclosure key; 404 alone is OFF; 503
  ASK_REMOTE_NOT_ADMITTED and every other failure are unavailable with a manual retry. REMOTE sends only AskRequestV2, built by
  `askRemoteBody` from a closed operation whose acknowledgement the controller captured at submit (never defaulted here); MOCK
  sends only V1; no fallback/downgrade. policyVersion stays a string (BigInt range check), never a Number. A REMOTE submit needs
  the consent state AND the box as shown; question, focus and tuple are captured before input and consent are cleared. Consent
  resets on edit, send, focus, credential/scope/context/queue/page/filter/observation, capability refresh, disconnect, pagehide
  and bfcache; the REMOTE-only edit hook also invalidates a pending question (MOCK typing changes nothing). The disclosure
  generation joins every completion guard; a CURRENT validated 409 ASK_REMOTE_POLICY_CHANGED clears input/answer/consent and
  marks Ask unavailable with only a manual refresh. Remote error codes are accepted only on REMOTE questions and capability
  discovery; an AskAnswerV2 is validated by the shared V1 predicates plus exact version/mode/db/provenance. Disclosure text is
  fixed local text (`ask-messages.ts`): no link, selector, key entry or policy editor; no MOCK label/examples in REMOTE.
- Server middleware stays opt-in (`ATLAS_OPERATOR_UI=1`): disabled API behaviour must not change. Serve assets from the
  in-memory manifest only; no filesystem lookup per request, redirect, listing or fallback.

Checks: `npm test` (units `tests/operator-*.test.ts`), `npm run ui:typecheck`, `npm run ui:build`, `npm run test:pg`
(`tests/pg/operator-http`), `npm run test:ui` (Playwright, CSP enforced, no trace/video/HAR; DB journeys need the PG wrapper;
visual screenshots only with `ATLAS_UI_VISUAL_DIR`, taken after the password field is cleared and verified token-free).
