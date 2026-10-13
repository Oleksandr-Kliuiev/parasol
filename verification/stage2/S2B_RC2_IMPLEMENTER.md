# S2-B RC2 — implementer repair report (findings F5–F7, request-state assessment)

Implementer: Claude Code 2.1.293, native Anthropic, `claude-opus-5-5`, effort high; same S2-B task session. Implementer
evidence only, not acceptance; fresh Astra xhigh review pending. Mock transport and disposable PostgreSQL only — no live
tenant, no deployment. S2-C and S2-LIVE not started. `S2B_RC1_IMPLEMENTER.md`, the RC1 manifest/package, normative
`docs/stage2/*`, accepted migrations, REVIEW_STATUS and IMPLEMENTATION_STATUS are unchanged.

Baseline: frozen `S2B_RC1_MANIFEST.json` (256 files, package `f20d17d4…8c34`); the checkout matched it exactly before
editing. Delta: 13 modified + 4 new files (list hash `abd94a8e…e115`, per-file SHA-256 in
`/tmp/atlas-s2b/rc2-checkpoint/rc2-delta.sha256`).

## Fixes

**F5 — cap-crossing page validation and accounting** (`packages/m365/ingest.ts`). `readLeaf` validates every returned row
against the current leaf's `[from, to]` before deciding to split; an out-of-window row on the cap-crossing page fails the
attempt permanently (`M365_SIGNIN_OUT_OF_WINDOW`). A valid cap-crossing page is not staged and does not enter the capped
leaf, but its rows (including exact-upper-bound rows) consume the request/root retrieval budget. If that budget would be
exceeded, the attempt fails with `SYNC_LIMIT_EXCEEDED`.
- **Retrieval counters.** `M365SyncRequest.totalStagedRows` (≤250,000) and `M365WindowAttempt.stagedRows` (≤100,000) count
  every row Graph returned: staged versions, duplicates, exact-upper-bound rows and cap-crossing pages.
- **Leaf counters.** `M365WindowLeaf.pagesRead` (≤20) and `rowCount` (≤10,000) count accepted pages only.
- **Malformed pages.** A malformed page fails the attempt before anything of it is counted or staged.
- No SQL cap was widened.

Note on the brief: the parser maximum is **500** rows/page (`M365_MAX_PAGE_ROWS`), not 1000. With 500 rows and 20 pages, a
leaf reaches exactly 10,000 rows and page 21 is never requested, so the row-cap branch cannot be reached through hard
bounds. The regression therefore uses 500-row pages with a lower configured leaf cap (`maxRowsPerLeaf: 1000`). That option
(`leafLimits`) accepts lower values only within the hard bounds (03 §4 "configurable within hard bounds"); higher values are
refused as `M365_LIMIT_INVALID`. A mutation check (old ordering restored temporarily) makes the regression fail.

**F6 — durable directory 429 timing.**
- **Schema:** new migration `202610081300_stage2_m365_directory_retry` adds `M365ResourceState.retryAt` (TIMESTAMP(3), NULL)
  and `M365ResourceState_retry_check` (directory resources only).
- **Trigger:** `M365ResourceState_retry`. A new row carries no `retryAt`, and `retryAt` changes only when the newest started
  attempt records its outcome (`latestRecordedSeq` advances to `latestStartedSeq`).
- **Grants:** `prisma/roles.sql` grants runtime `UPDATE("retryAt")` (runtime only; the definer gains nothing).
- **Self-check:** `runtime-role.ts` adds the column to the allowlist and a fail-closed fact, `missingUpdateColumns`. A runtime
  missing an allowlisted M365 column grant (or column) refuses to start until `roles.sql` runs again.
- **Service** (`directory.ts`):
  - The claim reads `retryAt` under Connection → state locks, with the clock read after them. Before `retryAt` it refuses with
    `M365_RETRY_NOT_DUE` (TRANSIENT, details `retryAt`/`retryAfterSeconds`), before any sequence, secret or request.
  - A recorded 429 of the newest unexpired claim persists `now + Retry-After` exactly (numeric or HTTP date; no 15m/1h cap;
    above 24h `M365_RETRY_AFTER_REJECTED`, permanent), or 60s + ≤10s jitter without a header.
  - Any other recorded outcome and publication clear it. Older, superseded and expired claims write nothing.
  - Scope: only 429 timing is durable for directories. 5xx/timeouts stay caller-retried (no directory attempt counter exists
    for exponential backoff; see risks).

**F7 — persisted deadlines.**
- `assertRootClaim` checks lease and hard deadline from the persisted attempt row.
- `publishRootAttempt` uses the persisted `coveredFrom`/`coveredTo` (narrowing rule and `expiresAt`).
- `assertDirectoryClaim` checks the hard job deadline from the persisted generation `startedAt`.
- The descriptor-based checks in `readLeaf`/`traverseAndStage` are removed (the per-request claim check covers every request).
- Tests mutate descriptor `deadlineAt`/`leaseExpiresAt`/`coveredTo`/`startedAt` and show that nothing is extended.

**M365SyncRequest.state — deferred to S2-C with a contract reason.** Migration 202610081100 makes a finished request's
outcome immutable (`a finished sync request keeps its outcome`). The accepted requeue contract (03 §5; root-job trigger)
lets an existing FAILED root job return to PENDING with a fresh budget, regardless of request state. Recording
COMPLETE/PARTIAL/FAILED when all jobs are terminal would therefore freeze an outcome that a permitted requeue can later
contradict. Avoiding that needs either a requeue restriction or new states; both are contract changes. So `state` stays
`OPEN`, per-root job states are authoritative, and no budget decision reads request state. A derived request status
belongs to the S2-C `m365-status` read.

## Commands (2026-10-08, Node 25.8.1, Prisma 6.19.0, PostgreSQL 17.11) — logs `/tmp/atlas-s2b/rc2-checkpoint/`

| Command | Result |
|---|---|
| `npm run schema:validate` / `db:generate` / `typecheck` | exit 0 / 0 / 0 |
| `npm test` | exit 0 — **128 tests, 128 pass**, 0 fail, 0 skipped (runtime-facts unit test extended in place) |
| `npm run api:build` / `api:smoke` | exit 0 / 0 |
| `npm run test:pg` | exit 0 — **227 tests, 227 pass**, 0 fail, 0 skipped (RC1 219 + 8 new); run once |
| `npm run db:check:pg17` / `db:check:drift` | exit 0 (all checks passed) / exit 0 (zero drift, new migration included) |
| `git diff --check` | exit 0; changed/new untracked files: no trailing whitespace; largest file 271 lines |

Focused runs during repair: `m365-directory`, `m365-order` (updated to the new return shape `{ recorded, retryAt }`),
`m365-windows`, `m365-window-recovery`, `m365-window-publication`, and the new tests; all pass in the full run above.

## New/updated tests

- `tests/pg/m365-window-limits.pg.test.ts` (3):
  - F5 out-of-window row on a 500-row cap-crossing page: permanent FAILED, no child request, no split, no publication.
  - Cap-crossing accounting incl. an exact-upper-bound row: request/root 12 rows, capped leaf 1 page/3 rows; invalid
    (higher) limits refused.
  - F7 sign-in deadline/bounds tamper: zero requests past the persisted deadline; retention from persisted bounds.
- `tests/pg/m365-directory-retry.pg.test.ts` (4):
  - 5400s persisted and respected by a fresh Prisma client, empty token cache and new transports: zero requests, no
    sequence, then publishes and clears.
  - HTTP-date 7200s; fallback 60–70s.
  - Superseded/expired claims cannot overwrite or clear the throttle; SQL trigger and CHECK refusals.
  - F7 directory deadline tamper.
- `tests/pg/m365-retry-upgrade.pg.test.ts` (1): S2-A schema + S2-A roles.sql → this code refuses
  (`missingUpdateColumns` 1) → `migrate deploy` → still refused → current roles.sql → passes with the existing credential;
  idempotent; definer has no `retryAt` grant.
- Updated: `m365-directory` (continues after the persisted throttle), `m365-order` (return shape), `context-mapper` unit
  (new fact).

## Remaining concerns

- Directory 5xx/network failures have no durable backoff (§6 asks for exponential backoff with bounded attempts). The
  schema has no directory attempt counter, and adding one plus a retry policy would go beyond the F6 scope. I flag it
  rather than invent one.
- The F5 row-cap regression needs a lower configured cap because hard bounds make it unreachable; the code path is shared.
- `test:pg` was run once in RC2. Mock transport only; live Graph behavior is unverified (S2-LIVE).

## Write handoff

Repair writing stopped; this process makes no further edits after this report. Write ownership returns to Codex when it
exits. Not done: commit, manifest/package for RC2, status updates, S2-C, live checks.
