# Stage5 architecture RC1 — independent review (Fable)

Reviewer brief: fresh INITIAL independent architecture review of the frozen eight-file Stage 5 package (local read-only operator console, first slice). Requested model `claude-fable-5-1` / high, native claude.ai Max, first-party, extra usage disabled. Requested model is self-identity only; the root records the actual response model stream. No other reviewer's verdict was read. Read-only session; no builds, generators, database, tests, network or secrets. `.env` present in the tree was not opened.

## Verdict: CHANGES_REQUIRED

Two required corrections (R1, R2); both are package-text amendments within the proposed architecture. No source change is implied before closure. Nonblocking items N1–N9 and residuals follow.

## Identity and preservation checks (all PASS)

| Check | Result |
|---|---|
| `verification/stage5/S5_DESIGN_RC1_MANIFEST.json` sha256 | `7a1a9ea9…234dc` matches brief |
| `verification/stage5/S5_DESIGN_RC1_PACKAGE.zip` sha256 | `349bea14…177f86` matches brief and manifest `archiveSha256` |
| Manifest `packageHash` `eb2ca966…415388` | Recomputed under the stated rule (sha256 of sorted `<sha256>  <path>\n` lines): match |
| Eight per-file sha256 in manifest | All match the working tree |
| Archive contents | Exactly the eight manifest paths; every entry byte-identical to the tree |
| Baseline `S5_DESIGN_BASELINE.json` sha256 | `bad263dc…20b4d` matches manifest; head `916a4d6`, branch `planning/stage2-m365` |
| Baseline preservation | 894 baseline files; 891 byte-identical; 3 changed = exactly the declared routing deltas (`AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `docs/DEVELOPMENT_WORKFLOW.md`), before/after hashes match; 0 missing; 0 undeclared |
| Source changes | None under `apps/ packages/ connectors/ prisma/ scripts/ tests/` |
| Routing deltas content | Stage5 pointers only (`AGENTS.md:39`, `docs/AI_CONTEXT_MAP.md:11`, `docs/DEVELOPMENT_WORKFLOW.md:202`); no requirement or acceptance change |
| Files not in baseline | The 8 package files, `IMPLEMENTATION_STATUS.md`, `REVIEW_STATUS.md`, 4 verification files, `.env` (not read) |
| Preflight `S5_DESIGN_PREFLIGHT.json` | claude.ai / firstParty / max, extraUsageEnabled false, providerOverrides false |

## Required findings

**R1 — Fixture-mode observations endpoint does not implement the query the console relies on.**
`apps/api/src/atlas.module.ts:63-65` returns `context.observations` wholesale: no `status`, `severity`, `limit` or `cursor` parameter is read; the fixture page has `nextCursor: null`, `truncated: false` (`fixtures/run-demo.ts:30`). Only the db controller parses the query (`apps/api/src/db/clients.ts:26-31`, `apps/api/src/http-boundary.ts:30-41`).
Package conflict: `01_SPEC.md:8-9` ("Severity/status filters, page size25 and next-page navigation use the existing server query/cursor"), `02_CONTRACTS.md:21-23`, and `06_ACCEPTANCE.md` B1/B8 bind "actual fixture and PG" journeys. `02_CONTRACTS.md:28-32` validates shape, enums and scope but never membership in the requested selection, so nothing stops mislabelled content.
Counterexample: fixture mode, operator sets severity=CRITICAL, limit=25. The server returns every active observation of all severities (up to 100) with unchanged `counts/total`; the console shows them under a "CRITICAL" filter at page size 25 with no RESPONSE_INVALID. This violates the invariant that presentation never misstates the selection, and B1 is unachievable in fixture mode as written.
Closure (text only): (a) add to `02_CONTRACTS.md` §Runtime validation: every returned item must satisfy the requested status and severity sets and `items.length ≤ requested limit`; otherwise fixed `RESPONSE_INVALID` with no payload. (b) state that fixture mode supports only the default selection (OPEN+ACKNOWLEDGED, all severities, no cursor) and that B1 filter/pagination evidence is PG-only; non-default filters in fixture mode must yield the fixed `RESPONSE_INVALID` rather than unfiltered rows. Alternatively declare the filter controls db-mode-only in `01_SPEC.md:8-9`. Either way the package must say which.

**R2 — "typecheck (including browser)" is not executable under the current root TypeScript configuration without an unspecified baseline change.**
`tsconfig.json` includes `apps/**/*.ts` with `types: ["node"]`, no DOM lib, `module: NodeNext`. `04_ARCHITECTURE_AND_UX.md:5` places browser modules under `apps/operator/`; `04:15-16` prescribes "a separate DOM-only tsconfig"; `05_IMPLEMENTATION_PLAN.md:22` requires "typecheck (including browser)" as a checkpoint check.
Counterexample: `npm run typecheck` (`tsc --noEmit` on the root config) compiles `apps/operator/*.ts` with Node types only, so `document`/`window` DOM types fail; or the implementer adds `lib: ["DOM"]` to the root config, leaking DOM globals into all server/package typing. Neither option is authorized or described, and `tsconfig.json` is a preserved baseline file.
Closure (text only): state in `04` §Build that the root `tsconfig.json` gains `exclude: ["apps/operator"]` as its only change, that `apps/operator/tsconfig.json` (DOM lib, no Node types, `rewriteRelativeImportExtensions`, native ESM) is the sole typechecker for browser modules, and that the checkpoint check means both commands. Record this as a declared baseline delta at S5-A. Copied enum modules used by Node parity tests must be DOM-free and importable with `.ts` extension by `node --experimental-strip-types`.

## Nonblocking improvements

- **N1 Read audit wording.** `README.md:8` says "existing read audit … writes remain mandatory". In db mode GET `/clients`, `/overview`, `/observations` write no client audit (`packages/graph/prisma-context.ts` has no audit sink). Only scope denials (`apps/api/src/db/auth.ts:62-67`, workspace security audit) and tool executions (`packages/tools/gateway.ts:54-73`) write. Say so, to prevent acceptance tests expecting rows for GET reads.
- **N2 Fixture bearer vs browser pre-validation.** `03:13` normalizes "only as the accepted bearer parser permits" (`packages/auth/token.ts:8`, 20–256 char b64token). The fixture guard compares raw bytes to `ATLAS_DEMO_TOKEN` (`atlas.module.ts:24-28`) with no pattern. A demo token containing `!` would be accepted by the server and refused by the console. State that fixture journeys use a demo token satisfying `BEARER_TOKEN_PATTERN`.
- **N3 Execution-id header optional.** Fixture `POST /tools/execute` sets only `x-atlas-correlation-id` (`atlas.module.ts:78-83`); db mode adds `x-atlas-tool-execution-id` on success only (`apps/api/src/db/tools.ts:40`). `02:55` and B3 should treat the execution header as optional diagnostic text.
- **N4 Evidence parameter preconditions.** Name the patterns: `connectionId` must match `SCOPE_ID_PATTERN` (`packages/graph/scope-context.ts:10`), `ticketId`/`incidentId` must match `EXTERNAL_ID_PATTERN` (`packages/graph/mapping.ts:39`); a non-matching stored reference yields visible evidence-unavailable with no request, otherwise the gateway audits `tool.rejected` (`gateway.ts:61`). For `atera/alert`, local exact-ID filtering must use `externalId ?? id` exactly as `packages/tools/registry.ts:77` (fixture items carry `id`, snapshot items `externalId`). Atera alert events use `externalEventId = input.id` (`connectors/atera/normalizer.ts:13`), the same ID space the server's `one()` assumes.
- **N5 Picker wording.** `02:32` "Responses cannot set … selectable client IDs" contradicts the picker being fed by GET `/clients` (`02:10`). Reword: only GET `/clients` of the current credential epoch populates the picker; no other response may add or select a client.
- **N6 403 on evidence.** Tool denial or forbidden client on `POST /tools/execute` is 403 (`gateway.ts:54-55`, `http-boundary.ts:15`); `03:33` resets the whole client selection on any 403. Safe but heavy; either scope an evidence 403 to the evidence panel plus picker refresh, or state the global reset deliberately.
- **N7 S5-A/S5-B boundary.** Workspace epoch comes from the first `/overview` (`02:29-30`), so S5-A "validated client selection" must already fetch and validate `ClientContextV1` (A6). Say that S5-A fetches and validates context without rendering it; S5-B renders.
- **N8 Static path semantics.** Specify `/operator` without trailing slash → 404 (custom allowlist middleware, no serve-static redirect), consistent with `redirect:'error'` and the journey URL at `01:5`.
- **N9 "whitespace" check.** No dedicated script exists; name the exact command in `05:22-23`.

## Confirmations (no finding)

- Allowed operations exist with the stated contracts: `GET /clients` → `ClientSummary[]` (`prisma-context.ts:69-76`, `[]` when no membership); `/overview` → `ClientContextV1` with `workspaceId/clientId/mode/completeness/generatedAt` (`packages/core/contracts.ts:253-262`); `/observations` → `ObservationPage` whose items carry scope, `source/connectionId/resourceType/externalEventId/confidence/route/priority/reasonCodes/conflictOfEventKey/supersededById` (`contracts.ts:172-178`); `POST /tools/execute` v1 body keys exactly `version/clientId/tool/parameters/requestId`, `requestId` `^[A-Za-z0-9._:-]{8,64}$` (UUID fits), parameters ≤2048 chars (`http-boundary.ts:56-68`).
- `ResourceView` has no scope envelope (`contracts.ts:239-244`); package statement correct. Snapshot items are server-bounded at 100 (`packages/sync/snapshots.ts:19`), within the console bound of 1000.
- Query limits: server max 100 (`CONTEXT_OBSERVATION_LIMIT`), comma lists ≤100 chars, repeated params → 400; page size 25 and default statuses align with `activeObservationStatuses`.
- Auth semantics: missing, malformed or unknown token → bare 401 (`db/auth.ts:21-23`); scope denial, malformed or nonexistent client → identical 403 with security audit (`db/auth.ts:45-67`), matching `03:27-35`.
- Loopback binding and `ATLAS_API_PORT` (`main.ts:12-25`); env fail-closed style exists (`main.ts:13,22`); `tests/support/api-process.ts:43` already supports refusal tests (A1). Smoke and PG tests address `127.0.0.1:<port>` (`scripts/api-smoke.ts:10`, `api-process.ts:27`), so the opt-in exact-Host gate does not break existing checks.
- TypeScript 5.9.3 pinned; `rewriteRelativeImportExtensions` already used by `apps/api/tsconfig.json`, so native-ESM browser emit with `.js` extensions is feasible without a bundler. No new runtime dependency needed; `@nestjs/platform-express` is present for middleware and static serving.
- `tests/context-budget.test.ts` scans `.ts/.css` everywhere except `node_modules/dist/.git`, so `apps/operator` sources and CSS fall under the 700-line cap automatically and emitted `dist/operator` is skipped.
- Security contract is internally consistent: memory-only closure, CSP with `connect-src 'self'`, same-origin relative fetch (no CORS, no preflight), `credentials:'omit'`, epoch and generation checks on every completion, no innerHTML. Stated non-claims (in-flight reads after revocation, no browser-internal zero-copy) match current API read-transaction semantics; no retroactive Stage 1 guarantee is claimed.
- Scope discipline: no new endpoint, model, permission, migration, Gateway entry, mutation, OIDC, vendor or model call; Ask Atlas and LIVE correctly excluded.

## Residuals (not blocking; record for S5-A/S5-B briefs)

- Context has no server bound on entities or links (`prisma-context.ts:39-46`). A client exceeding the console's 1000-item caps gets `RESPONSE_TOO_LARGE`, and because the queue cannot start before context validates (`03:31-32`) it becomes entirely unusable in the console. Acceptable fail-closed for synthetic data; note as a known limit.
- `Person.email` is in `ClientContextV1` (`contracts.ts:101`, selected at `prisma-context.ts:40`); the pre-S5-B field allowlist brief must explicitly decide display or non-display.
- A pinned browser E2E runner will change `package.json` and `package-lock.json` (baseline files); declare as a delta at the checkpoint per `04:17-19`.
- Browser extensions and compromised same-origin JS remain outside the credential boundary, as the package states.

## Model/billing note

Requested `claude-fable-5-1` / high on native claude.ai Max first-party, extra usage disabled; self-identification is not proof. Preflight recorded at `verification/stage5/S5_DESIGN_PREFLIGHT.json`. This report does not seal, edit status, or claim implementation acceptance. The same text is persisted at `/Users/oleksandr/.claude/plans/fresh-initial-independent-architecture-drifting-crystal.md`.