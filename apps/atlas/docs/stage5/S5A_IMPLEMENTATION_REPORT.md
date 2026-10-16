# S5-A implementation report — local serving, credential and client boundary

**Status: implemented; independent fresh Astra/xhigh actual-code acceptance PENDING. Not self-accepted.**
This report is implementer evidence only. It does not advance S5-B, Ask Atlas or LIVE.

## Identity

| Item | Value |
|---|---|
| Implementer | Claude Code, native `claude-opus-5-5`, effort high, one cohesive session, no subagents; native firstParty claude.ai Max (preflight verification/stage5/S5A_PREFLIGHT.json) |
| Base | HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, dirty inventory verification/stage5/S5A_BASELINE.json |
| Baseline check before code | all 926 baseline files matched their SHA-256; no extra/absent files (only the pre-existing S5A_BASELINE.json itself) |
| Approved design | eight-file RC3 package `b2fc0f89605cc27039044ff6f934cb06ee3180f23f8372ab2f427388ce4e72a7` recomputed from S5_DESIGN_RC3_MANIFEST.json (all 8 files OK); seal S5_DESIGN_APPROVED.json `bd6e49ac7f20692d242c744062f7ae780fedee413f41d5759e912108f6220c60` verified; frozen files untouched |
| Built console bundle | dist/operator manifest SHA-256 `091fe87cbb50ccee6763adff7fa606bbf3e0467eab57cfa19bfbee8ea8236093` (16 assets) |

## Delivered (S5-A only)

- **Opt-in serving** (`apps/api/src/operator/`, thin wiring in `apps/api/src/main.ts`). `ATLAS_OPERATOR_UI` unset/`0` off,
  `1` on, any other value (including empty) refuses startup. Enabled: assets are loaded once from `dist/operator` (path
  derived from the compiled main.js location, independent of cwd) and validated against the generated flat manifest
  (regular non-symlink files directly in the real directory, size cap, size + SHA-256); any mismatch fails closed with
  `OPERATOR_UI_ASSETS_UNAVAILABLE`. Requests are served from memory by exact path only: `/operator/` (index) and the
  manifest's `/operator/<name>`; `/operator`, `/operator/index.html`, the manifest, every other or encoded path and non-GET/HEAD
  are 404, no redirect/listing/fallback. Disabled: no middleware, API and headers unchanged, no UI files required.
- **Host gate and headers** (enabled only, before body parsing, auth, audit, static or API dispatch): exactly one
  `Host: 127.0.0.1:<configured port>` and an origin-form target, else 421. No forwarded-header trust, alias, CORS, proxy
  or API base. Every enabled response (assets, API, 401/403/404/421) carries the exact 03 CSP, `Cache-Control: no-store`,
  `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. Nothing logs Authorization or bodies.
- **Build**: `npm run ui:build` (scripts/operator-build.ts) runs the pinned TypeScript 5.9.3 on `apps/operator/tsconfig.json`
  (DOM/ES libs, `types: []`, NodeNext ESM, `rewriteRelativeImportExtensions`, no source maps, comments stripped), copies
  fixed HTML/CSS, rejects unexpected output or forbidden constructs and writes the deterministic manifest.
  `api:build` now includes `ui:build`. Root tsconfig only excludes `apps/operator`.
- **Browser credential/transport** (`apps/operator/src`): the bearer token exists only in the `createCredentialHolder`
  closure (no getter/export/serialization; frozen operation-only API). Input is never trimmed; the accepted
  `BEARER_TOKEN_PATTERN` copy (parity-tested) refuses malformed input without network. The password field (no name,
  autocomplete/spellcheck off) is cleared before the request. Token entry is disabled outside
  `http://127.0.0.1:<port>/operator/`. Only two fixed GETs exist (`/clients`, `/clients/<encoded id>/overview`) with
  `credentials:'omit'`, `redirect:'error'`, `cache:'no-store'`, `mode:'same-origin'`, no referrer. One original 10 s deadline
  covers request, incremental ≤4 MiB body read (declared or streamed overflow cancels), UTF-8 decode, JSON parse and
  validation; the result settles locally even when fetch ignores AbortSignal. No retry; fixed codes only, no body echo.
- **State machine** (`controller.ts`): DISCONNECTED → CONNECTING → READY / DISCONNECTED on 401. Credential epoch,
  scope epoch and per-panel generations; every completion is checked before any change. Replacement/disconnect abort
  and clear synchronously before a new request. Current 401 → global disconnect. Current 403 on a context → full scope
  clear and exactly one picker refresh, no auto-select; a 403 on the picker itself → scope clear and a visible error, no
  further refresh (no loop). Pagehide clears token, data and the input; pageshow from bfcache → disconnected.
- **Validated picker**: whole list or nothing (≤10 000, scope-ID pattern, no duplicate IDs, additive fields dropped);
  local name/ID search; at most 250 rows in server order with an explicit limitation message. Selection only from the
  validated list; never automatic.
- **Context validation without rendering**: `validateContext` checks contract version, requested client, credential
  workspace (first context establishes it; later ones must match), mode/completeness consistency, every person/device/
  link/observation scope, CONFIRMED-only V1 links (no M365), strict Atlas enums/times, observation page counts/total/cursor,
  resource status ↔ items ↔ mode, and the reviewed item shapes (DB SnapshotItem with free-text `status`; fixture
  normalized alert/incident with matching scope/source tuple; fixture ticket id/title/status); caps people/devices/links
  1000, queue 100, resources 100, items 1000 → `RESPONSE_TOO_LARGE`. Only the identity (client, name, mode,
  completeness, generatedAt) is kept; content is not rendered. Display strings are shortened at 4000 code points with a
  visible marker; IDs are never shortened.
- **UI**: compact navy header (Local console / Read-only / actual context-mode / session badges, Disconnect), light
  work surface, teal accent; landmarks, labels, visible focus, polite status regions rebuilt only when their state
  changes; keyboard-only flows; no queue/chat/action placeholder and no invented metrics. Mode labels: "Synthetic
  fixture context" for `fixture`, "Database-backed context" for `db` (never LIVE/production).

### Interpretations recorded for review

1. Empty `ATLAS_OPERATOR_UI` is treated as "other value" (startup refusal), not as unset.
2. Host refusal status is 421 Misdirected Request; non-asset `/operator…` paths and non-GET/HEAD are 404.
3. The enabled security headers (including CSP) are set on API responses too, per "Host/security headers cover API and
   assets"; business bodies/status codes are unchanged.
4. An explicit picker refresh keeps the current selection; the server decides at the next request.
5. If the first client list fails with a non-401 error the session stays CONNECTING with the error and Refresh.
6. Observation `connectionId`/`externalEventId` are type-checked in context validation; their request-format checks
   belong to the S5-B evidence action, where an invalid reference is "evidence unavailable" (02), not a context failure.

## Changes against the S5-A baseline

New implementation files (39, including this report; baseline metadata excluded): `apps/operator/{AGENTS.md,index.html,styles.css,tsconfig.json}`, `apps/operator/src/{contracts,controller,
credential,dom,main,messages,operations,origin,state,transport,validate-clients,validate-context,validate-core,view}.ts`,
`apps/api/src/operator/{assets,console,http,manifest}.ts`, `scripts/operator-build.ts`,
`tests/operator-{contracts,controller,server,transport,validate}.test.ts`, `tests/pg/operator-http.pg.test.ts`,
`tests/ui/{playwright.config,artifact.spec,console-fixture.spec,console-pg.spec,console-races.spec,console-visual.spec}.ts`,
`tests/support/operator-{dist,fixtures,ui}.ts`, and this report. Largest file 236 lines.

Modified baseline files (declared S5-A deltas):
- `apps/api/src/main.ts` — import, flag/asset preparation before mode dispatch, `app.use` of the middleware, one log line.
- `tsconfig.json` — `"apps/operator"` added to `exclude` only.
- `package.json` — `api:build` appends `&& npm run ui:build`; new `ui:typecheck`, `ui:build`, `test:ui`; devDependency
  `"@playwright/test": "1.56.1"`.
- `package-lock.json` — pure additions: root devDependencies entry and `node_modules/{@playwright/test,playwright,
  playwright-core,fsevents}` (all `dev`; fsevents optional). npm's automatic lock root `version` 1.0.0→1.1.3 was reverted;
  no other version/integrity/classification changed; the non-dev package set is identical (159 entries).
- `docs/AI_CONTEXT_MAP.md` — one Stage5 code routing row and one command row. `docs/RUNBOOK.md` — new §11.

No frozen normative file, review, archive, manifest, seal, status, workflow, Gateway/read/domain service, migration,
fixture or existing test was changed. No new endpoint, permission, actor, DTO or API semantic.

## Tests (acceptance mapping)

| File | Count | Covers |
|---|---|---|
| tests/operator-contracts.test.ts | 6 | bearer/scope/source pattern parity incl. edge samples, existing fixture tokens, enum parity, encoded fixed paths, exact origin, DOM-free shared modules (A3, A6) |
| tests/operator-validate.test.ts | 6 | list/picker/caps, context scope/links/enums/shapes/caps, additive fields (A4, A6) |
| tests/operator-transport.test.ts | 4 | holder surface, request options, status mapping, declared/streamed cap with cancel, single deadline, abort-ignoring fetch, no retry (A3, A5, A6) |
| tests/operator-controller.test.ts | 8 | malformed token, replacement, no auto-select, client switch, workspace, 403 once/no loop, 401, disconnect (A4, A5, A7) |
| tests/operator-server.test.ts | 5 | flag values, disabled without assets, loader (format, names, traversal, symlinks, hash/size), Host gate incl. duplicate/absolute/HTTP/1.0/forwarded, headers, exact paths (A1, A2) |
| tests/pg/operator-http.pg.test.ts | 4 | compiled API from a private dist copy: default off + no headers + no UI files, invalid flags, missing/tampered assets, other cwd + served bytes = built, enabled Host gate/headers/no exposure in fixture and DB mode, gate precedes auth/audit (A1, A2) |
| tests/ui/artifact.spec.ts | 3 | manifest = built files, closed relative ESM graph, no inline code/handlers/remote/storage/logging/HTML injection; Authorization only in credential.js (A1, A7) |
| tests/ui/console-fixture.spec.ts | 6 | built modules under enforced CSP (inline probe refused), password field cleared, Authorization only on fixed GETs, nothing retained, malformed/wrong token, explicit selection, content not rendered, disconnect/reload/pagehide/bfcache/tabs, keyboard (A1, A3, A4, A7, A8) |
| tests/ui/console-races.spec.ts | 8 | abort-ignoring fetch; deferred replacement, stale 401/500, client switch stale success/403/500/401, current 401, current 403 once, superseded refresh, malformed/mismatch/redirect/oversize, 250-row picker, 10 s timeout without retry (A5, A6, A7) |
| tests/ui/console-pg.spec.ts | 4 | disposable PG17: valid stored token journey without new audit rows, unknown/revoked/expired 401, no clients, membership removed → server 403 + security audit → one refresh (A4, A7) |
| tests/ui/console-visual.spec.ts | 3 | 320/768/1440 no horizontal overflow, landmarks/labels; screenshots when requested (A8) |

Negative controls (temporary source defects, then byte-identical restore; logs /tmp/atlas-stage5/s5a-negative/):
removed context staleness check (initially NOT detected by the browser suite — tests were then strengthened to assert
an aborted request settles as stale, not as an error; now detected by unit and browser), removed clients staleness check
(detected after adding the superseded-refresh browser test), removed CONFIRMED-link check, Host gate accepting any host,
removed streamed byte cap, password field not cleared — all detected.

## Commands and results

`/tmp/atlas-stage5/checks.sh s5a-final`, logs /tmp/atlas-stage5/s5a-checks/s5a-final/ (2026-10-10T12:45:10Z–12:48:17Z). All 14 exit 0:

| Check | Command | Result |
|---|---|---|
| unit + PGlite + context budget | `npm test` | 252/252 pass (includes 29 new operator tests) |
| schema validate / generate | `npm run schema:validate`, `npm run db:generate` | pass |
| root typecheck | `npm run typecheck` | pass |
| browser typecheck | `npm run ui:typecheck` (`tsc --noEmit -p apps/operator/tsconfig.json`) | pass |
| UI build | `npm run ui:build` | 16 assets, manifest SHA-256 `091fe87cbb50ccee6763adff7fa606bbf3e0467eab57cfa19bfbee8ea8236093` |
| API build (includes UI build) | `npm run api:build` | pass, same manifest |
| API smoke | `npm run api:smoke` | PASS (UI disabled default) |
| PostgreSQL 17 suite | `npm run test:pg` (PG wrapper) | 569/569 pass (includes 4 new operator HTTP tests) |
| PG17 SQL check / drift | `npm run db:check:pg17`, `npm run db:check:drift` | pass / no drift |
| browser E2E | `npm run test:ui` (PG wrapper) | 24/24 pass (Chromium 141.0.7390.37) |
| whitespace | `git diff --check` + untracked trailing-whitespace scan | clean |

Check logs were scanned for connection URLs and bearer values: none (matches were only test titles containing
"bearer"). No earlier failed full run exists; focused failures during development are described above.

## Browser runner and visual evidence

- `@playwright/test` 1.56.1 dev-only, integrity `sha512-vSMYtL/zOcFp…Tdg==` equals /tmp/atlas-stage5/browser-runner-pin.json;
  transitive `playwright`/`playwright-core` 1.56.1, optional `fsevents` 2.3.2. Install `npm install --save-dev
  --save-exact --ignore-scripts` from the public npm registry.
- Browser: Chromium 141.0.7390.37 (Playwright build 1194; headless runs use chromium-headless-shell 1194), installed by
  `playwright install chromium` from Playwright's official download into the local cache only.
- E2E: CSP enforced (`bypassCSP:false`), service workers blocked, no trace/video/HAR/failure screenshots; tokens synthetic,
  asserted only as booleans, never sent into the page by the test.
- Screenshots (real built console, synthetic fixture client, after the password field was cleared):
  /tmp/atlas-stage5/s5a-visual/s5a-{320,768,1440}-{disconnected,ready}.png.

## Production staging

/tmp/atlas-stage5/s5a-prod-staging.sh, logs /tmp/atlas-stage5/s5a-prod-staging/: copy of package files and sources →
`npm ci` → `npm run db:generate` → `npm run api:build` → `npm prune --omit=dev` → serve from `/`. Result: Playwright
packages absent; runtime packages and generated `.prisma/client` present; enabled `/operator/` 200, asset 200, `/operator`
404, `/clients` with bearer 200, alias Host 421, CSP present, served main.js equals built; disabled `/operator/` 404 and
`/clients` 200. `typescript` and `prisma` remain after prune because the baseline lock already classifies them
`devOptional` (optional peers of `@prisma/client`); unchanged by S5-A. No new runtime dependency.

## Residuals

- Not production authentication: memory-only local bearer; logout does not revoke; browser extensions or compromised
  same-origin script, browser-internal copies and already-seen data are outside the boundary (03).
- The browser abort/timeout does not cancel or roll back server work; an in-flight authorized read may complete after
  revocation per accepted API semantics.
- A context above the console caps is unavailable to this console (RESPONSE_TOO_LARGE), including its future queue.
- `X-Powered-By: Express` remains (unchanged default). bfcache restore is handled by `pageshow`; Chromium may not
  bfcache a `no-store` page at all, in which case back navigation reloads disconnected.
- Context content, queue, evidence and their UX are S5-B; Ask Atlas and LIVE/pilot remain separate and deferred.
