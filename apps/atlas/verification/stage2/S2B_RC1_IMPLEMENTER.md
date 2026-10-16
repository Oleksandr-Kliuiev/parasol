# S2-B RC1 — implementer report (tasks 2.4–2.6)

Implementer: Claude Code 2.1.293, native Anthropic, requested `claude-opus-5-5`, effort high; one session (interrupted once by
Codex for findings F1–F4, resumed in the same task). This is an implementer report, not an acceptance; independent Astra
xhigh review is pending. Synthetic data, mock Graph/authority transport and disposable PostgreSQL only — **no live tenant,
no deployment**.

Baseline: HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, dirty S2-A-rc5
(`0a038288…f2d1`, 213 files). Architecture RC5 unchanged. No normative `docs/stage2/*` file, migration or `prisma/*.prisma`
file changed; no new migration was needed. `REVIEW_STATUS.md` and `IMPLEMENTATION_STATUS.md` were not edited.

## Changed files

Modified RC5 payload files (9): `connectors/http.ts` (export `boundedText` only), `connectors/microsoft365/README.md`,
`docs/AI_CONTEXT_MAP.md` (routing rows), `packages/audit/sanitize.ts` (+7 allowlisted keys: resourceType, attemptSeq,
requestId, rowCount, evidenceCount, leafCount, attemptsUsed), `packages/connections/connections.ts` (microsoft365 bindable to a
lower-case tenant GUID; `issueM365Connection`; `resolveCredential` refuses M365), `packages/connections/m365-disable.ts`
(local token-cache eviction after commit), `packages/sync/activation.ts` (generic activation refuses M365),
`tests/pg/AGENTS.md`, `tests/support/m365-fixtures.ts` (synthetic `syncer` actor).

New: `connectors/microsoft365/{contract,http,auth,connector}.ts`; `packages/m365/{AGENTS.md,authority,io,activation,directory,
windows,ingest,signin-rows,status}.ts`; tests `tests/m365-{auth,http,adapter}.test.ts`,
`tests/pg/m365-{activation,directory,order,windows,window-recovery,window-publication}.pg.test.ts`; support
`tests/support/m365-{graph-mock,pg,signin-mock,window-rows}.ts`. Largest file 265 lines.
Per-file SHA-256 list: `/tmp/atlas-s2b/checkpoint/s2b-files.sha256` (36 files; list hash `70370b60…dbef`).

## Behavior

- **Graph boundary.** Fixed authority POST (`client_credentials`, `.default`) and GET-only Graph, both `redirect:'error'`,
  15s timeout, 5 MB bound. `graphGet` and `session.get` refuse any URL that is not https Graph origin + `/v1.0` + exactly the
  endpoint path *before* a secret, token or bearer is used (`M365_URL_REFUSED`); nextLinks follow the same rule and are
  requested as returned; repeated link → `M365_PAGINATION_LOOP`. Errors carry codes only (no URL/body/header/token).
  429 keeps the exact Retry-After (> 24h → `M365_RETRY_AFTER_REJECTED`, permanent, never retried early).
- **Tokens/tenant.** Session rechecks authority before secret resolution, immediately before the token POST, before the
  organization check and before every GET. Each new token verifies `/organization` (exactly one, = bound tenant) with the same
  token before any collection request; only verified tokens are cached. Cache key: workspace/client/connection/tenant/app ID/
  secretRef(hash)/lifecycleVersion. One 401 recovery per session, shared by tenant verification and all pages.
- **Activation.** `issueM365ActivationCapability` (bound DISABLED, connections:manage, current authority, Connection
  locked) pins actor/scope/tenant/version; expiry is a private number (returned Date is a copy). `runM365Activation` is
  one-use, probes users/devices/sign-ins ($top=1, validated then discarded), then one transaction: lock, recheck, conditional
  `DISABLED@version → ACTIVE@version+1`, `m365_signin` capability (OK or UNAVAILABLE/`M365_SIGNINS_NOT_AVAILABLE`), audit.
- **Directory (2.5).** Claim before I/O (state upsert → STAGING generation, seq+claim+12m lease); pages staged per transaction
  (identical duplicates dedupe, contradictory → `M365_DUPLICATE_CONFLICT`); one publication transaction: Connection FOR SHARE
  → state → generation, clock after locks, typed mirrors (opaque ID + codes, existing reused, observedAt advanced only here),
  PUBLISHED, pointer/counts/lastSuccess, audit. Failure: own generation FAILED; state ERROR only for the newest unexpired claim.
- **Sign-ins (2.6).** Server request ID; ≤24h, ≤25 UTC-hour roots; root jobs with budget 5. Claim consumes budget before the
  attempt (expired crashed claims closed and counted), fixed bounds `[max(root, now−7d), min(rootTo, now−5m)]`, new seq,
  claim, 12m lease, 10m deadline; not-yet-collectable → RETRY gap without budget. Pages: ge/le query, local `[from,to)`,
  exact upper bound counted+discarded, out-of-window → `M365_SIGNIN_OUT_OF_WINDOW`; durable request/attempt/leaf counters;
  evidence versions upserted per page, memberships only with leaf COMPLETE; caps split into ≥1m halves (≤60/root,
  ≤1,500/request), unsplittable → `SYNC_LIMIT_EXCEEDED`. Publication: one transaction (fence, newest seq, own claim before
  deadline, no narrowing of unexpired coverage except at the retention floor, COMPLETE + pointer + predecessor SUPERSEDED +
  lastSeenAt + job COMPLETE + audit). Failure: RETRY with persisted retryAt or FAILED; window ERROR only for the newest
  unexpired claim. Audited requeue of an existing FAILED job resets the budget.
- `status.ts`: pure read semantics (directory OK/STALE/MISSING/ERROR; root coverage vs freshness) for tests and S2-C.

## Commands (2026-10-08, Node 25.8.1, Prisma 6.19.0, PostgreSQL 17.11)

| Command | Result |
|---|---|
| `npm run schema:validate` / `db:generate` / `typecheck` | exit 0 / 0 / 0 |
| `npm test` | exit 0 — **128 tests, 128 pass**, 0 fail, 0 skipped (S2-A baseline 108 + 20 new) |
| `npm run api:build` / `api:smoke` | exit 0 / 0 (PASS) |
| `npm run test:pg` | exit 0 — **219 tests, 219 pass**, 0 fail, 0 skipped (baseline 176 + 43 new); run once |
| `npm run db:check:pg17` / `db:check:drift` | exit 0 (all checks passed) / exit 0 (zero drift) |
| `git diff --check` | exit 0; new untracked files separately checked: 0 trailing-whitespace lines |

PG commands received `ATLAS_PG_ADMIN_URL` via `node --env-file=.env` (not printed). Raw logs: `/tmp/atlas-s2b/checkpoint/`.

## Acceptance B mapping

| ID | Evidence |
|---|---|
| B1 | m365-auth (wrong tenant: zero collection GETs, no cache; cross-scope cache; recheck before secret/POST/GET); m365-activation (tenant B on A; generic bypass refused); m365-directory/order (revoke during I/O, disable fence) |
| B1a | m365-activation: bind → capability-only activation, probes publish nothing, replay/FIXTURE/ACTIVE/foreign actor/copy refused, expiry tamper (zero I/O) |
| B1b | m365-activation (disable during probe, between probe and commit; new version → new token); m365-order + m365-window-publication (disable wins Connection lock, pointer unchanged) |
| B2 | m365-http (19 malicious links, transport/session URL refusal with zero requests, redirect, loop, authority POST tenant check, safe errors) |
| B3 | m365-directory (2nd-page 503, malformed, page cap, 403 vs empty, duplicates, disappearing object, crash before commit, 429) |
| B4 | m365-order (concurrent first claims, same-timestamp both orders, newer failure/older success mixes, expired claim) |
| B5 | m365-window-recovery (crash after staging / before / after commit, HELD lease, two workers, budget incl. crashed claim, requeue, immutable versions) |
| B5a | m365-window-publication (failed split half keeps exact members/time, STALE; old/new race both orders; independent roots) |
| B5b | m365-window-publication (root CHECKs; gapped/overlap/zero/short leaves refused, also after restart) |
| B6 | m365-adapter + m365-windows (429 7200s persisted, 403 vs empty, 401 bounded, split to 1m → gap, ge/le + exact upper bound, out-of-window) |

## Gaps and risks

- Mock/recorded transport only; real Graph paging/nextLink shapes, throttling and 7-digit timestamps are unverified (S2-LIVE).
  The nextLink rule requires the raw link to start with `https://graph.microsoft.com/v1.0/<path>?`; an unexpected live form
  fails safely (no publication) but would need review.
- Not implemented (S2-C): CLI commands (`m365-probe/sync/status/requeue/directory`), read API/tools, correlation, full
  coverage/cursor query, retention service. `M365SyncRequest.state` stays OPEN (per-root states are authoritative).
- Directory 429 is returned to the caller (no durable directory retry schedule exists in the schema).
- Expired-lease attempts are closed by the next claimer; no background sweeper (no scheduler in Stage 2).
- Activation capability is in-process memory; cross-process replay is prevented by the conditional version update.
- test:pg run once at this checkpoint (not twice).

## Write handoff

Implementation writing stopped at the S2-B checkpoint; this process makes no further edits. Write ownership returns to Codex
when this process exits. Not done: commit, REVIEW_STATUS/IMPLEMENTATION_STATUS updates, task 2.7, live checks.
