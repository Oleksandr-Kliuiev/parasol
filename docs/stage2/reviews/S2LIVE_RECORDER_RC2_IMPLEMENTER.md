# S2-LIVE recorder RC2 — implementer report

Implementer: native Claude Code `claude-opus-5-5` / `high` (requested; effective effort as launched by Codex). This is the
same cohesive recorder session as RC1, and it was the sole owner of checkout writes from transfer until this report.
Date 2026-10-08. RC2 is a candidate for fresh Astra recorder-preparation acceptance. It is not live evidence and no live
dispatch was made. The original handoff remains `S2LIVE_RECORDER_IMPLEMENTATION_BRIEF.md`.

## Identity verified before editing

Frozen RC1 `verification/stage2/S2LIVE_RECORDER_RC1_MANIFEST.json`: 324 files, package recomputed to
`d3a461e5cd37e88fa0a3aafa05534ab0a9331fb258dbfad60cbecd8fabc00663`, all files matched. Normative 11 (`1d3b1064…a1efb`) and
the RC5 brief (`494c614b…a2f5`) are unchanged. Against the writer baseline, only `docs/AI_CONTEXT_MAP.md` differs, as in RC1.
The RC1 report, checks, execution, manifest and package archive are untouched.

## Required fix

**Codex finding.** `admitPilotAuthority` refused mapping/confirm-link without `m365:read` on the same membership
(`PILOT_AUTHORITY_REFUSED`) after authentication, but appended no workspace security audit. `02_CONTRACTS.md` lines 36–37
require a safe audited denial when the client is authorized but a permission is missing.

**Fix.** `admitPilotAuthority` stays pure. In `driver.ts`, the new `admitAudited` catches only the pilot's own
`PILOT_AUTHORITY_REFUSED`. It then appends exactly one row through the accepted `PrismaSecurityAudit`, using the freshly
authenticated actor on the confined runtime connection, and rethrows.
- The row has the shape of the accepted `requireClient` permission denial: `ops.scope_denied`, outcome DENIED, the requested
  client ID as text, `PERMISSION_DENIED`, a random correlation ID and metadata `{ command }`.
- It carries no M365, connection, link, object or tenant identifier and no secret.
- If the append fails, the driver throws `SECURITY_AUDIT_FAILED`: exit 2, `REFUSED`, no dispatch (fail closed).
- Preserved: accepted command-boundary denials are audited only by the accepted boundary (no second pilot row). Refusals
  before authentication, and the fixture-namespace refusal, still write no audit. Grants, isolation, statuses and exit codes
  are otherwise unchanged.

## Delta from RC1 (3 files)

| Path | RC1 SHA-256 | RC2 SHA-256 | Change |
|---|---|---|---|
| `packages/ops/pilot/driver.ts` | in RC1 manifest | `101b6d87…07b6` | `admitAudited`; imports `PrismaSecurityAudit`, `randomUUID` (166 lines) |
| `packages/ops/pilot/config.ts` | in RC1 manifest | `e3956500…0fdf` | doc comment only (108 lines) |
| `tests/pg/pilot-driver.pg.test.ts` | in RC1 manifest | `5b88a0d8…f0bf` | audit regressions; first test strengthened (216 lines) |

New files: this report and `verification/stage2/S2LIVE_RECORDER_RC2_CHECKS.json`, which holds the full hashes and logs. No
core, accepted service, schema/migration, dependency, `.env`, normative, context-map or prior evidence file changed.

## Tests (synthetic, disposable PostgreSQL)

New and strengthened tests in `tests/pg/pilot-driver.pg.test.ts`:
- **Refusals before authentication and fixture refusal append nothing.** Owner URL (`RUNTIME_ROLE_BYPASSES_RLS`), invalid
  token and demo workspace leave all of the following unchanged: workspace audit, client audit, links, mirrors, raw events,
  M365 state and connection state/version.
- **An accepted scope refusal is audited exactly once.** An outsider running m365-status produces one `SCOPE_DENIED` row.
- **The pilot's own refusal is audited once per invocation.** The mapper (`mapping:review` + `context:read`, no `m365:read`)
  runs mapping, confirm-link and mapping again. Each run gives exit 2, `PILOT_AUTHORITY_REFUSED`, zero dispatches and zero
  emulator calls, and adds exactly one row (`ops.scope_denied`, `pilot-client`, `PERMISSION_DENIED`, `{command}`). The rows
  contain no connection, link, tenant or token value. The only change to the counts is +3 workspace audit rows: no client
  audit, no `pilot-other` audit and no other write.
- **Accepted permission refusals are not double-audited.** A reader (`context:read` only) running mapping, and the mapper
  running m365-status, each get one accepted `PERMISSION_DENIED` row and no pilot row.
- **Audit outage is fail closed.** A temporary trigger on `SecurityAuditEvent` in the disposable DB (dropped in `finally`)
  makes the append fail: `SECURITY_AUDIT_FAILED`, exit 2, no result, no row, no other effect, zero dispatches.
- **Mutation check.** I temporarily put back RC1's unaudited call: 3 of the new tests fail. I restored `driver.ts` and
  verified its hash matched again.

Focused: unit 23/23, PG pilot 9/9. Mandatory checkpoint suite, all exit 0 (logs and SHA-256 with start/end in the checks
JSON; raw logs under `/tmp/atlas-s2live/recorder-rc2-checks`):

| Check | Exit | Result |
|---|---|---|
| `npm test` | 0 | 168/168, 0 skipped |
| `schema:validate`, `db:generate`, `typecheck` | 0, 0, 0 | — |
| `api:build`, `api:smoke` | 0, 0 | — |
| `test:pg` (disposable DBs) | 0 | 317/317, 0 skipped (RC1 314 + 3 new) |
| `db:check:pg17`, `db:check:drift` | 0, 0 | drift empty |
| `git diff --check` | 0 | changed files also checked for blanks/tabs: none |

The disposable-DB admin URL reached the tests only through the existing `--env-file=.env` test route. The pilot always got an
explicit synthetic env. No persistent DB, credential, source row, provisioning, seed or external network was used.

## Residual limitations

- The audit row uses the accepted vocabulary (`PERMISSION_DENIED`). The pilot-specific code `PILOT_AUTHORITY_REFUSED`
  appears in the pilot summary, not in the audit. The audit therefore records the denial and the command, but does not name
  which extra permission was missing; this follows the "no M365 detail in denial metadata" rule.
- The audit append and the refusal are not one transaction with anything else; there is nothing else to write. A process
  crash between the append and the rethrow would leave a correct denial row.
- RC1's residual risks still apply: the guard covers global fetch only; preload detection relies on `execArgv` and
  `NODE_OPTIONS`; test seams exist only in the library function; fixture-provenance checks are static; data from a call whose
  completion receipt failed can still be published locally; no live run; L1–L4 not exercised; L3 BLOCKED_EXTERNAL.

## Handback

The fix and the required checks are complete. I return checkout write ownership to Codex, and this session makes no further
writes. Next steps belong to Codex and fresh Astra: freeze and review the exact RC2 candidate. Do not proceed to LIVE.
