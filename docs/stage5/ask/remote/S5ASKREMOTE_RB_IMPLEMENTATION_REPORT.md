# ASK-REMOTE R-B implementation report (RC1)

**Acceptance: PENDING** fresh independent Astra/xhigh actual-code review. This report claims no acceptance. R-C (browser),
R-EVAL, data/budget admission, keys/accounts, LIVE and deployment are NOT started/admitted; paid product/provider calls: 0.

| Item | Value |
|---|---|
| Implementer | fresh native Claude Code session `d7982c45-9ae5-4da2-9568-3c31a1d6c269` (equals preflight/baseline `freshOpusSession`), requested `claude-opus-5-5`, effort high; actual response stream so far reports only `claude-opus-5-5` (`/tmp/atlas-stage5/askremote/rb/opus-rb-rc1.jsonl`); billing per `S5ASKREMOTE_RB_PREFLIGHT.json` (included subscription, no API/credits/fallback); quota unknown |
| Elapsed | ≈ 1 h (handoff 2026-10-10T23:57:56Z → report 2026-10-11T00:57Z) |
| Baseline | before any write: `S5ASKREMOTE_RB_IMPLEMENTATION_BASELINE.json` sha256 4cd65f90…; exact pathset 1246/1246 files and 228/228 compiled outputs matched, none missing/extra; 10 dependency seals, preflight, brief, design seal/closure, R-A seal/closure, ten remote norms (design manifest) and scratch preparation receipts all matched (`impl/baseline/PREWRITE_VERIFICATION.json`, `DESIGN_NORMS_CHECK.txt`) |
| Evidence | `/tmp/atlas-stage5/askremote/rb/impl/EVIDENCE_INDEX.json` |

## Implemented (server/adapter only; offline seams)

- **Mode.** `ATLAS_ASK_MODE=off|mock|remote`; remote is DB-only (fixture refuses at startup), composes `AskRemoteDbModule`,
  activates nothing, reads no secret, makes no startup call. OFF/MOCK wire/parser/authority/claims/errors/Host unchanged.
- **V2 HTTP.** Same two routes and raw ingress; `AskCapabilityV2` from a bounded workspace-policy read; exact `AskRequestV2`
  (V1 → 400; MOCK still refuses V2); `AskAnswerV2` = exact 15 V1 keys + fixed provenance, `sourceMode` db; fixed remote codes
  in the unchanged `AskErrorV1` envelope (the accepted V1 code/status lists stay byte-identical for the browser parity test).
- **Authority.** The accepted bounded phase/fenced authority was extracted UNCHANGED into `packages/ask/db-phase.ts` (MOCK
  passes `context:read` only). Remote phase1/egress/phase2 require ONE membership with `context:read`+`ask:remote`; consent
  tuple first (409), then active/unexpired (DB clock)/exact profile, prompt/schema/package hashes, EU, SYNTHETIC, reserve and
  client admission (503); local circuit; rolling charge; source read. Phase2 rechecks token/permission/epoch/policy before
  and after the final audit INSERT.
- **Egress.** Payload `{question,hasFocus}` serialized once before admission (≤16 KiB). Egress transaction: fence FIRST FOR
  SHARE → current bearer/actor/all-of → epoch equality → captured policy → DB-clock sample → remaining ≥4500 ms →
  `atlas_ask_remote_reserve_floor` with the operator's acknowledged tuple → post-INSERT token/policy/floor → COMMIT.
- **Dispatch proof (`dispatch.ts`).** Capability minted only when the egress transaction promise fulfils; bound to the task
  signal, prepared bytes and committed attempt; one use; NO_DISPATCH only while still MINTED in this process (revoking it);
  settlement inputs taken once from private state; usage only if validated inside the provider phase. Unknown commit,
  rollback, forged/cast object, another task, restart: no dispatch, no refund.
- **Provider.** Fixed direct HTTPS transport (EU 443, dedicated agent without proxyEnv, exact headers, no redirect/retry,
  64 KiB incremental cap); dedicated `env://ATLAS_ASK_REMOTE_*` resolver (never `OPENAI_API_KEY`/Decisions; vault/fixture do
  not resolve in production). One provider phase min(2 s, remaining) started before key resolution/consumption, ended by
  its absolute end or terminal abort. Strict duplicate-rejecting JSON; exact envelope/usage/intent validation.
- **Settlement/circuit.** Own 2 s clock independent of terminal; pre-publication wait ≤ remaining − 500 ms; failure keeps
  the reservation and does not suppress a valid answer. Model/tier/usage mismatch and upstream 401/403 close the per-process
  circuit at detection and pause the policy durably (fence-first, separate transaction after phase2, owner-held).
- **Selection/compiler.** `mockPlan` selection extracted into `packages/ask/selector.ts` (no behavior change; parity test
  on 400 generated banks); remote uses the unchanged whole-plan validator and compiler.

### Additive SQL delta (why a migration)

A floor checked before calling the R-A reserve routine, or only after it returns, cannot prove ≥4500 ms remained when its
INSERT ran (counter lock waits happen inside it). New migration `202610121000_stage5_ask_remote_egress_floor` adds ONE
routine, `atlas_ask_remote_reserve_floor(…, p_floor timestamptz)`: same scope checks, takes the reservation locks in the
SAME order (fence SHARE → policy SHARE → counters → MONTH → DAY), requires `clock_timestamp() ≤ p_floor` after every wait,
calls the UNCHANGED `atlas_ask_remote_reserve`, and checks the floor again before RETURN (AR011 → 504, whole statement
undone). The application maps its floor to the DB clock conservatively (same-transaction sample read back before measuring
the remaining budget). `prisma/roles.sql`: the routine joins the runtime-EXECUTE list (count check now `cardinality`);
`ask-remote-role.ts`: one additive spec row. R-A routines/tables/guards/policies/grants/claims unchanged; the old reserve
stays runtime-executable (the R-B path never uses it; a floor is a timing property, not authority).

## Changed paths (vs the verified baseline; exact list and hashes in `scope-final.json`)

Existing: `apps/api/src/{ask-http,atlas.module,main}.ts`, `apps/api/src/db/app.module.ts`, `packages/ask/{authority,config,
planner}.ts`, `packages/ask/remote/ledger-sql.ts` (floor statement/params, `FLOOR_SQLSTATE`; accepted map unchanged),
`packages/graph/ask-remote-role.ts`, `prisma/roles.sql`, `packages/ask/AGENTS.md`, `packages/ask/remote/AGENTS.md`,
`tests/pg/AGENTS.md`, `docs/AI_CONTEXT_MAP.md`, `docs/RUNBOOK.md` (§15), and accepted tests changed ONLY as the amendment
requires: `tests/ask-input.test.ts`, `tests/pg/ask-http.pg.test.ts` (`remote` now valid; message names it),
`tests/pg/action-upgrade-s3{b,c}.pg.test.ts` (exact migration list + the new migration).
Added: `packages/ask/{db-phase,selector}.ts`; `packages/ask/remote/{answer,circuit,contracts,db,dispatch,envelope,input,json,
payload,profile,secret,service,transport}.ts`; `apps/api/src/db/ask-remote.ts`; the migration; tests
`tests/ask-remote-{wire,dispatch,local,flow}.test.ts`, `tests/pg/ask-remote-{journey,upstream,egress,floor,settle,
process}.pg.test.ts`, `tests/support/ask-remote-api.ts`; this report. Built: 9 changed + 16 added `dist` files (244);
`dist/operator/*` unchanged (manifest 72098306… as baseline). Ten norms, old migrations, reports/reviews/seals, root
status/brief/baseline/preflight untouched.

## Verification

Focused (all pass after fixes): unit wire 6, dispatch 7, local 6, flow 6; PG journey 6, upstream 4, egress 10, floor 5,
settle 5, process 3; accepted R-A remote PG 25/25 unchanged. **ALL14 run2** (2026-10-11T00:48–00:53Z, all exit 0):
npm test 393/393 (368 + 25), schema:validate, db:generate, typecheck, ui:typecheck, ui:build, api:build, api:smoke, test:pg
684/684 (651 + 33), db:check:pg17, db:check:drift, test:ui 73/73, git diff --check, untracked whitespace.
**Production**: fresh copy, `npm ci` of the unchanged lockfile, generate, build, dev prune: 0 of 244 staged outputs differ;
foreign-cwd fixture MOCK/OFF browser and asset checks pass; staged DB OFF/MOCK/REMOTE startup under the network trap:
readiness passes, remote 503 `ASK_REMOTE_NOT_ADMITTED`, 0 policies, 0 network attempts; token/question absent from logs.
**Mutations** (isolated copies, root identity unchanged): 16/17 killed — dispatch without commit, post-INSERT stale
credential, combined stale consent (M03b), foreign-scope settlement, SQL and application floor bypass, duplicate settlement
input, no-consent default, duplicate JSON keys, model mismatch, ownership release, phase2 permission downgrade, combined
terminal dispatch (M12b), post-commit floor bypass, circuit not tripped. M12a (orchestration terminal gate only) SURVIVED as
predicted: `dispatchIntent` independently refuses an aborted task; the combined M12b is killed. M03a (application tuple
check only) was predicted to survive via the SQL AR002 layer but was KILLED by a secondary effect: stale consent then
consumed the rolling admission (429); the SQL layer still refused each reservation.

### Original failures (preserved under `impl/logs`, `impl/checks/run1`)

Test-side mistakes fixed during development (journey audit column, fence +1 guard, BigInt label, default-param, strip-types
parameter property, test timing). Real findings fixed: roles.sql hard-coded routine count 8 (now derived); terminal abort
did not end the provider phase when the transport ignored the abort (now ends it at once; physical call stays held). Two
design observations turned into tests: token revocation is an owner write that bumps the fence and therefore serializes
behind egress (linearization test), and drain after terminal completes after the reply (tests wait for owner release).
ALL14 run1: test:pg 682/684 — the two Stage 3 exact migration lists (additively updated); everything else passed.

## Qualifications and residual risks

- Offline only: the real TLS socket, DNS, EU endpoint, account/key, retention and response shape are NOT exercised; tests
  inject an in-process `https.request` stand-in and a scripted transport by direct construction (no config/HTTP switch).
  Proxy-env exclusion is shown on the agent object under `NODE_USE_ENV_PROXY`, not by a network attempt.
- Floor mapping assumes equal clock rates over seconds; FK key-share waits after the pre-INSERT check are caught by the
  routine's pre-RETURN check (tested), not prevented.
- Revocation/pause are process-local for the circuit; other processes rely on the durable pause and phase2. A failed pause
  keeps this process refusing the workspace until restart. Unknown commits/settlements retain reservations with no
  reconciliation. No request/response body instrumentation exists in this codebase to disable.
- Inherited: model ID ≠ fixed weights, semantic intent errors (R-EVAL), unsanitized question, irrevocable admitted egress,
  abort ≠ no charge, ledger ≠ invoice. Browser remains V1/MOCK until R-C.
