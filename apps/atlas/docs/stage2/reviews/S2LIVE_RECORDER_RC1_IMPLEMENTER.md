# S2-LIVE recorder RC1 — implementer report

Implementer: native Claude Code `claude-opus-5-5` / `high` (requested by Codex; effective effort as launched), one cohesive
writer session, sole owner of checkout writes from handoff until this report. Date 2026-10-08. This is a candidate for fresh
Astra xhigh **recorder preparation** acceptance. It is not live evidence, not L1–L4 acceptance and no live dispatch was made.

## Identity verified before editing

HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`. S2-C-rc2 307 files recomputed to
`e43cc185…be3c0`; normative 11 to `1d3b1064…a1efb`; RC5 brief `494c614b…a2f5`; approved plan package `7cfdc792…f2e3`;
all 470 writer-baseline entries matched. After the checks the only changed pre-existing file is `docs/AI_CONTEXT_MAP.md`
(the permitted routing row). It belongs to the S2-C 307 package, so the candidate delta includes it. Normative 11 and RC5
are unchanged. Exact candidate hashes: `verification/stage2/S2LIVE_RECORDER_RC1_CHECKS.json`.

## Changed paths

New: `scripts/stage2-live-pilot.ts` (19 lines); `packages/ops/pilot/` `AGENTS.md` 30, `classify.ts` 80, `receipts.ts` 79,
`recorder.ts` 128, `guard.ts` 32, `config.ts` 107, `project.ts` 163, `driver.ts` 144; tests `tests/pilot-recorder.test.ts` 186,
`pilot-redirect.test.ts` 90, `pilot-admission.test.ts` 124, `pilot-privacy.test.ts` 118, `pilot-process.test.ts` 62,
`tests/pg/pilot-driver.pg.test.ts` 168, support `tests/support/pilot-support.ts` 79, `pilot-preload.ts` 6; this report and
`verification/stage2/S2LIVE_RECORDER_RC1_CHECKS.json`. Modified: one row in `docs/AI_CONTEXT_MAP.md`. No accepted core,
schema/migration, existing test, dependency/lockfile, `.env`, normative, status or prior report file was edited.

## Behaviour and implementation decisions

- **Entry/order** (`driver.ts`). Clean process → config → runtime env presence → output collision → new receipts file →
  fetch guard + recorder → `openRuntimeDatabase` → `assertRuntimeRole` → `authenticateToken` immediately before the
  operation → pilot authority → `runOperatorCommand` → projection → `run-end` receipt. The pilot performs one command per
  process. It has no continuation, retry, reset, requeue, disable, rebind or worker pass. `scripts/ops.ts` is not imported.
- **Clean process** (`config.ts`). The pilot refuses non-empty `NODE_OPTIONS`. It also refuses any `execArgv` outside
  `--experimental-strip-types`, `--no-warnings` and `--disable-warning=ExperimentalWarning`. This covers `--import`,
  `--require`/`-r`, loaders, `--inspect` and `--env-file`. Any `ATLAS_TEST_*` variable is treated as a test-harness or mock
  marker and refused.
- **Config.** The config has exact keys `{version:1, command, flags, scope:{client, connections}, output:{receipts, private?}}`.
  The allowlist is m365-probe, m365-sync, m365-status, m365-directory, correlation, live-read, mapping and confirm-link. Other
  commands are refused before `parseInvocation`. The flags then pass through the accepted `parseInvocation` unchanged. The
  client and connection must match the approved scope. The stock seed client and seed connections are refused, and so is an
  actor in the demo workspace. The config cannot express an Actor or a permission.
- **Authority.** The accepted command boundary still checks its own permissions and audits denials (`ops.scope_denied`
  preserved; PG test). The pilot adds only the RC5 requirement for mapping and confirm-link: `m365:read` on the same
  membership that holds `mapping:review`. That pilot refusal writes no security audit, because the accepted command never
  runs.
- **Composition.** The context gets recorded Stage 1 `HttpTransport` and recorded `GraphTransport`. Tokens use
  `ClientCredentialsTokenProvider` over the recorded `AuthTransport`. It also gets the real `EnvSecretResolver(env)` and
  `envCursorKey(env)`. `config()`/`runtime()` throw `PILOT_CALLBACK_REFUSED` and halt the run, so no Decisions provider can be
  built. The shared cursor key (reference and ≥32 bytes) is checked in memory before DB access for m365-directory and
  correlation.
- **Classification** (`classify.ts`). One kind maps to one method: token POST, Graph GET, Stage 1 GET. A strict raw-URL check
  rejects https violations, userinfo, ports, fragments, whitespace/controls/backslashes and parser-normalised text. Graph uses
  the accepted `assertGraphUrl` per endpoint. The token URL must equal `tokenEndpoint(<tenant GUID>)`. Atera and Huntress
  allow fixed path patterns with allowed and required query names; the tenant-scope parameter is required. Class names are
  fixed constants. A refusal halts the run and writes a URL-free refusal receipt.
- **Recorder** (`recorder.ts`). It writes and fsyncs a dispatch receipt, then makes exactly one dispatch, then writes the
  completion receipt.
  - If the pre-dispatch receipt fails, nothing is dispatched and the result is `PILOT_RECORDER_FAILED`.
  - Stage 1 receives exactly `{method:'GET', headers, signal, redirect:'error'}` and never uses `fetchTransport`. Graph and
    auth inits pass by identity; an init without `redirect:'error'` is refused.
  - A thrown dispatch records `httpStatus:null` and `DISPATCH_FAILED` or `DISPATCH_TIMEOUT`, then rethrows the original
    error so the accepted service keeps its own mapping (e.g. `UPSTREAM_TIMEOUT`).
  - Response bodies are never read, cloned or cancelled.
  - **Decision:** if the completion receipt fails after a real call, the Response is still returned unchanged to the
    accepted service. The run is marked incomplete and every later dispatch is refused. This avoids local state contradicting
    what upstream actually did. The consequence: such a command can report success while the pilot exits 1 with
    `COMPLETION_RECORD_FAILED` (tested).
  - The recorder takes counts per class from its own receipts; item and page counts come only from service output.
- **Receipts** (`receipts.ts`). Shapes are exact: `run-start`, `dispatch`, `completion`, `refusal` and `run-end`. Each key and
  value is validated, and keys are written in a fixed order. Files are opened with `wx` and mode 0600, and each line is
  written in full and fsynced. An existing file is `PILOT_OUTPUT_EXISTS` and is left untouched.
- **Guard** (`guard.ts`). It captures `globalThis.fetch` in a closure and installs a guard. The guard halts the recorder
  (`UNRECORDED_FETCH`) and rejects, making zero network calls. Its `dispatch` closure goes only to `createRecorder`; the native
  function is never exported or put into a context. `restore()` is exact and idempotent and runs in `finally`.
- **Projection** (`project.ts`). Each command's output is projected field by field through typed checks. Local IDs become
  run-local aliases (`connection-1`, `request-1`, …); there are no hashes. A final walk allows only codes, ISO timestamps,
  aliases, digits and known literals. Anything unexpected becomes `PILOT_PROJECTION_REFUSED`, and the pilot exits 1.
  - Correlation keeps resolution, coverage, gaps, relation codes and proof labels (vendorField, link statuses and counts).
  - It omits evidence IDs/hashes, person IDs, event keys, per-sign-in time and error code.
  - Directory and correlation lists become presence/count/total/truncated/nextCursorPresent.
  - The requested sign-in interval is normalised by the accepted `millisecondInstant`; the effective retrieval bounds are
    shown next to it.
- **Private resume file** (optional `output.private`, `wx` 0600). It holds alias→local ID and `nextCursor`, so the operator
  can resume the same sign-in request or page privately. It never appears in public output.
- **Exit codes.** 0 = command ok, projection ok and recording complete. 1 = command not ok, projection refused or recording
  incomplete. 2 = refused or accepted command error with complete recording. The summary carries the
  `evidence:"OPERATION_OUTCOME_ONLY"` marker. Tests assert no PASS/PASSED/ACCEPTED/LIVE token appears.

## Verification (synthetic only)

Mechanisms: in-memory scripted dispatch, loopback servers on 127.0.0.1 with native fetch, synthetic credentials and canaries,
and disposable PostgreSQL 17 (migrate + `roles.sql`, no seed; synthetic pilot namespace bound with the accepted
`bindConnection`). The PG test gives the pilot an explicit synthetic env. `.env` was used only through the established
test-tool route for the disposable-DB admin URL. No persistent DB, current credential, source row or external network was
used.

Focused tests: unit 23/23 and PG 6/6.
- **Recorder (7).** Classification table; refusal before dispatch and halting; pre-dispatch failure → zero dispatch;
  completion failure → Response untouched, incomplete, later zero dispatch; thrown/timeout → null status, fixed outcome,
  accepted mapping, one call; init/header/body/signal/Response identity through the real token provider, `graphGet`,
  `nextLinkOf` and Stage 1; receipt allowlist; `wx` sink with 0600 mode and no overwrite.
- **Redirect (4).** Native fetch for Stage 1 same-origin and cross-origin, Graph users/devices and token POST: exactly 1 source
  request and 0 target requests each, with null status. A control shows the accepted Stage 1 init without the restriction
  would follow the redirect. The guard refuses direct fetch, `fetchTransport` and `fetchGraphTransport` with zero requests and
  halts recorded transports.
- **Admission (6).** Clean process; every other operator command refused before parsing; config/scope/fixture refusals;
  authority extras; refusing callbacks; `runPilot` refusals with zero fetch, no output files and collision-safe outputs.
- **Privacy (4).** Canary DTOs, IDs, hashes and cursors never projected; labels and counts truthful; unexpected values refuse
  the projection.
- **Process (2).** Actual processes with `--import` preload (proved loaded), `NODE_OPTIONS`, the S2-C mock preload, a test
  variable, and worker/shadow/decisions/bind/requeue commands: exit 2 with a safe summary, no outputs and no canary in
  stdout/stderr.
- **PG (6).**
  - Owner URL → `RUNTIME_ROLE_BYPASSES_RLS`; invalid token, demo workspace and missing `m365:read` refused; out-of-scope client
    → accepted `SCOPE_DENIED` with its audit row; zero dispatches.
  - Probe: token + organization/users/devices/signIns receipts in sequence, `redirect:error` and same-token Authorization,
    ACTIVE; a second probe → `CONNECTION_ALREADY_ACTIVE` with 0 dispatches.
  - Two-page users sync: organization recheck plus 2 page dispatches, rowCount 3. Directory read gives counts only, and the
    cursor goes to the private file only.
  - Sign-in create with 429 → RETRY with requested/effective bounds; resume NOT_DUE with 0 dispatches; status via aliases.
  - Completion failure → `COMMAND_OK`/PUBLISHED but exit 1 incomplete. Pre-dispatch failure → 0 calls, visible FAILED.
  - Huntress live-read: all GET with exact init keys and `redirect:error`, classes counted, mapping empty, and confirm-link /
    correlation errors with 0 dispatches.

Mandatory checkpoint suite (exit codes; logs and SHA-256 in the checks JSON; raw logs kept privately outside the repository):

| Check | Run 1 | Rerun after test fix |
|---|---|---|
| `npm test` | 0 (168/168) | — |
| `schema:validate`, `db:generate` | 0, 0 | — |
| `typecheck` | 0 | 0 |
| `api:build`, `api:smoke` | 0, 0 | — |
| `test:pg` (disposable DBs) | **1** (313/314) | 0 (314/314, 0 skipped) |
| `db:check:pg17`, `db:check:drift` | 0, 0 | — |
| `git diff --check` | 0 | 0 |

The run-1 failure came from my own newly added assertion `/PASS|ACCEPT|LIVE/`, which matched inside the accepted code
`RUNTIME_ROLE_BYPASSES_RLS`. I changed it to whole-token matching; the requirement is unchanged and no implementation code
changed. Earlier, during focused runs, I corrected one PG expectation to include the accepted same-token `/organization`
recheck before directory pages. Both were test-only corrections. `git diff --check` does not cover untracked files; the 17 new
files were checked separately for trailing blanks, tabs and final newlines, and none were found.

## Residual risks and limits

- The guard covers global `fetch` only. Direct `node:http`/`https`/`net`/undici use is not intercepted. The admitted closure
  has no such path (injected transports only; Prisma talks to the DB). A stricter process-level egress control remains an
  operational option.
- Preload detection relies on `NODE_OPTIONS` and `execArgv`. It cannot detect a modified Node binary or modified repository
  files. Source identity verification before a run remains a procedural prerequisite.
- `runPilot` has synthetic test seams (`dispatch`, `wrapSink`, `now`). The entry point never passes them and the config cannot
  express them; reviewers should confirm this.
- Fixture provenance is checked only against the static seed IDs and the demo workspace. FIXTURE connections still rely on the
  accepted services' refusal. Genuine provenance and consent remain owner prerequisites; L3 stays BLOCKED_EXTERNAL.
- After a completion-receipt failure, data from that one already-made call may still be published locally; the run is then
  incomplete and cannot support L4.
- `durationMs` measures until response headers, not body consumption.
- Refusal receipts are best effort; their failure adds `REFUSAL_RECORD_FAILED`.
- The receipts and private file locations are operator-chosen absolute paths. Keeping the private file outside the repository
  is procedural.
- No live run occurred: L1–L4 are not exercised. Live acceptance needs owner inputs, a fresh Astra xhigh acceptance of this
  exact candidate and the separate live gate.

## Handback

The bounded code and required checks are complete. I hand checkout write ownership back to Codex, and this session makes no
further writes. Codex should recheck the accepted hashes and delta, including `docs/AI_CONTEXT_MAP.md`, then freeze the exact
recorder candidate for independent fresh Astra xhigh acceptance.
