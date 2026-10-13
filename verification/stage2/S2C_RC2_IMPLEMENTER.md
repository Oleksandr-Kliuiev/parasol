# S2-C RC2 — implementer report (NOT an acceptance)

Date 2026-10-08. Same cohesive native Claude Code session, `claude-opus-5-5` / high, sole writer for the bounded repair of
[Astra S2-C-rc1 review](../../docs/stage2/reviews/ASTRA_S2C_RC1.md) findings R1/R2. Status **REVIEW_PENDING**; renewed fresh Astra
xhigh assessment required. No architecture or public-contract change; LIVE not run.

## Identity

| Item | Value |
|---|---|
| Verified before editing | RC1 manifest `verification/stage2/S2C_RC1_MANIFEST.json` 306/306, `493059a8d40ce832772511477b8647d7033179599bfbc62324033f0903a7521b`; brief RC3 `de3eea93…3f629f4ff2ea006bf7fe4293073ad7f57`; HEAD `916a4d6`; 11 normative (`1d3b1064…`); 19 frozen migrations; `REVIEW_REPORT.md` `7e186cf1…`; log `/tmp/atlas-s2c/checkpoint-rc2/00_baseline_verify.log` |
| Candidate RC2 payload | 307 files, package hash `e43cc1858e7271577714e2b46e5c8d10956dd4e625cad779964a3a3ac6cbe3c0` (same LF algorithm) |
| Manifest | `verification/stage2/S2C_RC2_IMPLEMENTER_MANIFEST.json` (= `/tmp/atlas-s2c/checkpoint-rc2/post-check-payload.json`, sha256 `db23ca89…98da`) |
| Ordering | last source edit 18:04:23.559Z (`tests/pg/m365-api.pg.test.ts`) < first final check 18:04:30Z; pre = post = handoff hash |
| vs RC1 | modified 10: `packages/correlation/{coverage,cursor,query,read,resolve}.ts`, `packages/m365/reads.ts`, `tests/correlation-units.test.ts`, `tests/pg/m365-api.pg.test.ts`, `docs/AI_CONTEXT_MAP.md`, `tests/pg/AGENTS.md`; new 1: `tests/pg/correlation-cursor-bounds.pg.test.ts`; removed 0 |
| vs S2-B | 17 modified, 38 new, 0 removed |

Outside payload: `docs/stage2/IMPLEMENTATION_STATUS.md` (S2-C row → REVIEW_PENDING rc2), this report. RC1 evidence untouched.

## Finding closure

**R1 — precision of the next cursor-expiry transition (closed).** `cursorExpiry(clock, transitions)` now receives seven-digit
keys with boundary semantics (`inclusive`: state holds AT the instant — expiry, freshness; `strict`: only AFTER it — input
eligibility `from + 7d`, retention clip) and decides future-ness against the snapshot clock KEY before flooring to epoch ms.
A transition later inside the current millisecond therefore bounds the cursor (floored: it may expire at issue — conservative),
never extends it; already-happened transitions are ignored, so already stale data still pages. Both surfaces use the same
`signInTransitions(...)`. Tests: `tests/correlation-units.test.ts` "R1: …" (Astra's exact keys: issued expiry `…12:00:00.123Z`
instead of `…12:15:00.123Z`; next page `CORRELATION_CURSOR_EXPIRED` before `CORRELATION_INTERVAL_NOT_RETAINED`; strict vs
inclusive at now; already-stale keys; never later than any future key); `tests/pg/correlation-cursor-bounds.pg.test.ts` "R1: …"
(both `correlationPage` and `signInsPage` with a deterministic snapshot clock — the page bodies are exported for this; the
public services still always use the database clock).

**R2 — historical published-attempt validity in conflict bounds (closed).** `conflictContributors` returns each contributor's
effective validity `min(evidence expiresAt, max expiresAt of its still-valid published memberships)`; this instant is both a
cursor transition (inclusive) and part of the fingerprint, on correlation and sign-in list. Membership attempt identities are
deliberately NOT fingerprinted: losing one of several valid memberships changes no output and must not yield a time-only
`CORRELATION_CHANGED`. Selection, count, coverage and canonical-person suppression are unchanged. Test:
`correlation-cursor-bounds` "R2: …" — schema-permitted shorter `SUPERSEDED` expiry (Astra's mechanism, all triggers on):
single membership → both cursors expire exactly at the attempt expiry (before evidence expiry), next page EXPIRED (not
CHANGED), fresh read CURRENT with `canonicalPersonId` restored; two memberships → cursor = the later one, still pages after
the earlier one expires, EXPIRED after the later one; total/coverage unchanged.

Demonstrated against the unmodified RC1 sources in a scratch copy (not the checkout): `rc1-r1-demo.log` (issued
`12:15:00.123Z`), `rc1-r2-demo.log` (R2 test fails: cursor ≈ +15 min instead of the attempt expiry).

Also fixed: a latent 1/64 flake in `m365-api` (the "tampered" cursor replaced the last MAC character by `'A'`, a no-op when it
already was `'A'`); it occurred in the first RC2 full run (`attempt1-flaky/`, 307/308, that test only). The flip is now deterministic.

## Checks — after the last source fix, each once

| Command | Exit | Result |
|---|---|---|
| `npm test` | 0 | 145 tests, 145 pass, 0 fail/skip/cancelled |
| `npm run schema:validate` / `db:generate` / `typecheck` / `api:build` / `api:smoke` | 0 each | smoke PASS |
| `node --env-file=.env <npm-cli> run test:pg` (+`ATLAS_S2C_EVIDENCE_DIR`) | 0 | 308 tests, 308 pass, 0 fail/skip/cancelled |
| `node --env-file=.env <npm-cli> run db:check:pg17` / `db:check:drift` | 0 each | passed; zero drift |
| `git diff --check` | 0 | empty |

Evidence `/tmp/atlas-s2c/checkpoint-rc2/`: `NN_*.log`, `receipts.tsv`, `checks.json` (`bc831715…7270`; per-log sha256, times,
counts), `pre/post-check-payload.json`, `delta.json` (`bbde0917…2488`), focused runs `focused-pg.log` (50/50) and
`focused-unit.log` (145/145), RC1 demonstrations, `attempt1-flaky/`, `evidence/s2c-journey.json`. Secret scan: no URL,
password, token or credential. Disposable local PostgreSQL 17.11 (UTC), Node 25.8.1, Prisma 6.19.0.

## C-case map delta

C4/C4a gain `tests/pg/correlation-cursor-bounds.pg.test.ts` (R1, R2) and the R1 unit test; the RC1 mapping in
`S2C_RC1_IMPLEMENTER.md` is otherwise unchanged.

## Remaining risks (unchanged scope)

Cleanup revocation gap and time-bounded whole-pass cleanup (documented); per-page O(selection) recount (~480 ms at 19k rows,
not re-measured — the contributor query only gained a per-version aggregate); S2-B ~9.5k-membership leaf timeout; reads use the
DB clock while S2-B uses the process clock; a cursor whose earliest transition lies in the issue millisecond is expired at issue
(conservative by design). No blocker. All source writes and processes stopped.
