# S5-B implementation report — operator read journey

Status: **implemented; source and actual-code acceptance PENDING** (separate fresh explicit Astra/xhigh). Not self-accepted.
This report is implementer evidence only. Ask Atlas, LIVE/pilot/deployment are not touched.

## Identity

| Item | Value |
|---|---|
| Baseline | HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`; `verification/stage5/S5B_IMPLEMENTATION_BASELINE.json` (997/997 files verified before writing) |
| Approved brief | `S5B_IMPLEMENTATION_BRIEF_RC2.md` `24ba441d…04732`; package `5beba747…8795f`; seal `S5B_BRIEF_APPROVED.json` `e37497cd…6173`; review `ASTRA_S5B_BRIEF_RC2.md` `c4e866ad…985de` |
| Controlling architecture | Stage5 RC3 `b2fc0f89…e72a7`; S5-A seal `93fe2b27…98aa7` |
| Built console | `dist/operator` 32 assets, manifest SHA-256 `d8329d97c23662b2579c946b9e5eea6ed039ad18846ee7cad42695998ddf0b5a` (identical in the fresh production staging build) |
| Browser | Chromium 141.0.7390.37 (Playwright 1.56.1 build 1194, `~/Library/Caches/ms-playwright/chromium-1194`), `/tmp/atlas-stage5/s5b-browser-version.json` |
| Implementer | native Claude Code, `claude-opus-5-5`, effort high, firstParty claude.ai Max subscription per preflight; one fresh session, no subagents; elapsed ≈55 min; attributable quota unknown |

Exact per-file hashes of the delta: `/tmp/atlas-stage5/s5b-delta.json` (25 modified, 25 added, 0 removed; the added
`verification/stage5/S5B_IMPLEMENTATION_BASELINE.json` predates this session).

## Changed files (all within the permitted scope)

- `apps/operator/`: `AGENTS.md`, `index.html`, `styles.css`; modified `src/{contracts,controller,credential,dom,main,messages,operations,state,transport,validate-context,view}.ts`;
  new `src/{queue-query,evidence-plan,entities,panels,controller-queue,controller-evidence,validate-observations,validate-resources,validate-evidence,view-parts,view-clients,view-scope,view-context,view-queue,view-detail,view-evidence}.ts`.
- Tests: modified `tests/operator-{contracts,controller,transport,validate}.test.ts`, `tests/support/operator-ui.ts` (holdApi accepts a URL predicate),
  `tests/ui/{artifact,console-fixture,console-pg,console-races}.spec.ts`; new `tests/operator-{queue,evidence,journey}.test.ts`,
  `tests/support/operator-journey.ts`, `tests/ui/console-{journey-fixture,journey-pg,races-queue,render,visual-journey}.spec.ts`.
- Docs: `docs/AI_CONTEXT_MAP.md` (S5-B routing row), `docs/RUNBOOK.md` §11, this report.
- Unchanged: API/static server, build script, dependencies/lockfile, tsconfigs, server domain/authority/schema/migrations/fixtures,
  normative files, reviews, manifests, seals, status files. No new endpoint, permission or actor.

## Behaviour

- **Operations** (closed typed values, `operations.ts`): existing GET clients/overview; GET observations (DB: explicit
  canonical `status`/`severity`/`limit` 25/50/100 and opaque `cursor`; fixture: no query); POST `/tools/execute` with exactly
  `{version:'1',clientId,tool,parameters,requestId}` for `atera.alert.list`, `atera.ticket.get`, `huntress.incident.get` only.
  The holder injects the bearer with same-origin/omit/no-store/redirect-error/no-referrer. GET success is exactly 200, POST
  exactly 201; the one original 10 s deadline (including synchronous decode/parse/validation) and incremental 4 MiB cap apply
  to both; no retry. Fresh `crypto.randomUUID` request ID per deliberate click; a click while pending sends nothing.
- **Validation before commit** with explicit projections (`contracts.ts` types): context limited to Atera/Huntress people names,
  device hostnames/person references, confirmed links and stored reads (email/financial/M365/facts/externalDevice/receivedAt/
  safeErrorCode never retained); queue pages validated against captured scope, statuses, severities, limit, unique IDs, fixture
  no-paging; evidence bound to the captured source/resource/connection (no null fallback) and mode, get results only the selected
  ID, list results filtered by exact `SnapshotItem.externalId` (DB) or `externalEventId` (fixture) keeping truncation; diagnostic
  headers kept only as `^[A-Za-z0-9._:-]{1,128}$`.
- **State/isolation**: context → exactly one queue request; context refresh, filter/page/refresh and selection clear dependents
  synchronously; next page replaces the single retained page. Every completion checks credential epoch, scope epoch and panel
  generation; evidence additionally the selected observation and exact tuple. Current 401 disconnects; every current 403
  (context/queue/evidence) clears the scope and refreshes the picker once; picker 403 does not recurse.
- **Display**: HIGH/CRITICAL shows "Urgent: source severity …" in queue/detail/evidence regardless of confidence, route or
  priority label; confidence is labelled explanatory; entity "confirmed" only by exact ID + single current row + CONFIRMED
  link, otherwise unresolved/reference unavailable; conflict/superseded as text; OK/STALE/ERROR/MISSING/FIXTURE, as-of and
  last-success times (null = unknown), truncation and empty-vs-unavailable semantics; fixture Huntress shows the demo
  limitation with no request and no absence claim; no links, attributes or HTML from data; responsive 320/768/1440,
  semantic buttons, static live regions, focus kept on the activated control or moved to the region heading.

## Checks (final source)

`/tmp/atlas-stage5/s5b-checks.sh s5b-final-2` → `/tmp/atlas-stage5/s5b-checks/s5b-final-2/summary.txt`: all 14 exit 0 —
npm test **280/280** (S5-A 257), schema validate, generate, root and UI typecheck, UI build, API build, API smoke, PG suite
**569/569**, PG17 check, drift, browser E2E **50/50** (S5-A 31), `git diff --check`, untracked whitespace; context budget in
npm test (largest new/changed file 261 lines). The earlier run `s5b-final` (same results) was on bytes before the evidence-hint fix
below and is preserved.

Production staging (`/tmp/atlas-stage5/s5b-prod-staging.sh`, logs `/tmp/atlas-stage5/s5b-prod-staging/`): fresh copy, `npm ci`,
generate, build, `npm prune --omit=dev`, served from cwd `/`: default off 404, Host alias 421, CSP present, `/operator` and
`/operator/index.html` 404, all 32 assets byte-equal to the build, no bare/remote imports, GET clients/overview/observations 200,
POST evidence 201 with correlation echo and `demo-alert-1`, token absent from logs. Runtime package set identical to S5-A
(typescript/prisma presence after prune is pre-existing). Earlier staging runs are preserved
(`…-run1-index-mapping`: my script fetched `/operator/index.html`, which the accepted server correctly 404s; `…-run2-prefix-evidence-hint`).

Visual (`/tmp/atlas-stage5/s5b-visual/`, 18 PNGs): `s5b-{320,768,1440}-{queue,detail,evidence,db-states}.png` plus S5-A
disconnected/ready; synthetic data, connected session, captured only after the password field was cleared and the page/storage
verified token-free. Pre-fix set preserved in `s5b-visual-prefix-evidence-hint/`.

## Test coverage (B1–B9, A1–A8)

Units: queue selection/request/page validation (`operator-queue`), evidence allowlist/body parity with the server parser and
registry schema/result binding/diagnostics/entities (`operator-evidence`), POST/201 vs GET/200, deadline and cap
(`operator-transport`), controller races with abort-ignoring fake fetch incl. same-observation reselect (`operator-journey`),
parity of new copies (`operator-contracts`). Browser on the built console: fixture journey with actual Gateway 201 and fixture
audit rows (`console-journey-fixture`), PG17 filters/pages compared to the API's own pages, get/list evidence with exact
ToolExecution/AuditEvent rows, untouched domain tables, membership-removal 403 + `tool.scope_denied` and no execution row
(`console-journey-pg`), queue/evidence races (`console-races-queue`), read states/injection/malformed/urgency/entities/route
allowlist (`console-render`), emitted-code allowlists (`artifact`), responsive visuals. S5-A specs kept; only their
S5-A-phase assertions changed: "context content not rendered" became an explicit allowlist/privacy check, request lists include
the queue GET, and the S5-A context races auto-answer the queue so their held indices stay meaningful.

## Negative controls (restored bytes)

`/tmp/atlas-stage5/s5b-negative/run.py`; run1 (21 controls) and run2 (22) logs and `summary.json`; sources verified
byte-identical after each and after the run (`source-before-run2.sha256`), final rebuild manifest unchanged. Run2: 21/22
caught — tuple binding, exact-ID filter, get-only-ID, diagnostics pattern, evidence generation, generation+tuple, evidence 403
reset, pending guard, queue generation, queue selection, duplicate IDs, fixture no-paging, fixture refusal, POST 201-only, email
retention, confirmed-link requirement, fixture Huntress no request, urgency vs route, urgency vs confidence, text-only rendering,
context-refresh clearing. **Not caught alone: the evidence selected-tuple completion check** — defense in depth, because every
selection/page/scope change also resets the evidence generation; removing both checks is caught. Run1 also showed the browser
filter race missing the queue-generation control (unit caught it); the browser test now asserts the aborted load stays
"Loading", and a unit case covers same-observation reselect. `run3-evidence-hint`: the new hint assertion catches the old text.

## Findings during implementation

- A types-only module emitted an unreachable `model.js` (artifact graph test) and a message containing `console.` tripped the
  no-logging scan: types moved into `contracts.ts`, message reworded.
- Visual review: for fixture Huntress the evidence area said "press the button above" with no button; fixed, regression added.
- A browser race appeared to send while pending; diagnosis showed Playwright's pointer click waits for `aria-disabled` to clear
  (the read then genuinely timed out at 10 s and the click was a legitimate retry). The test now activates by keyboard; console
  behaviour unchanged. Temporary instrumentation was restored from byte copies.

## Residuals

- The tuple completion check is not independently testable (see above). Abort is courtesy only; stale isolation relies on
  generations, as in S5-A.
- A timed-out or aborted evidence read may still have its ToolExecution/audit outcome on the server; the UI claims no cancellation.
- Very large valid contexts (caps 1000/100×1000) render fully (stored items collapsed in `<details>`); no display paging added.
- Accepted S5-A residuals (browser-internal copies, extension/same-origin compromise, no remote token revocation) unchanged.

Sole checkout write ownership returns to Codex at the end of this session.
