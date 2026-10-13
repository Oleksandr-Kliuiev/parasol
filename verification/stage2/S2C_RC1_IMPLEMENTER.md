# S2-C RC1 — implementer report (NOT an acceptance)

Date 2026-10-08. Native Claude Code `claude-opus-5-5` / high, sole writer for tasks 2.7–2.10. Status: **REVIEW_PENDING**;
independent fresh Astra (gpt-6-astra / xhigh) acceptance of the actual frozen code and evidence is required. LIVE not run.

## Identity

| Item | Value |
|---|---|
| Approved brief | `docs/stage2/reviews/S2C_IMPLEMENTATION_BRIEF_RC3.md` `de3eea93865ef907872a4cf170a87993f629f4ff2ea006bf7fe4293073ad7f57` (verified before the first edit) |
| Baseline | S2-B-rc4 `d122f0ea4031ce3421c114c286d409b974d83449d8db6f3930b53884486eb841`; all 269 payload hashes and 11 normative hashes matched; HEAD `916a4d6` |
| Candidate payload | 306 files (269 S2-B paths + 37 new), package hash `493059a8d40ce832772511477b8647d7033179599bfbc62324033f0903a7521b` |
| Manifest | `verification/stage2/S2C_RC1_IMPLEMENTER_MANIFEST.json` (sha256 `3445fc22…d644`; same algorithm as S2-B manifests) |
| Ordering | last source change 2026-10-08T17:34:44Z (`tests/pg/m365-e2e.pg.test.ts`) < first final check 17:36:16Z; payload hash identical before and after the checks |

Excluded from payload as instructed: `docs/stage2/IMPLEMENTATION_STATUS.md` (S2-C row set to REVIEW_PENDING), `REVIEW_STATUS.md`,
`verification/*`. Unchanged: all migrations, `REVIEW_REPORT.md`, normative RC5 files, `packages/graph/runtime-role.ts` (its exported
definer/ACL facts are reused), schema (no migration needed).

**Changed vs S2-B (17):** `.env.example`, `apps/api/src/{atlas.module.ts,db/app.module.ts,db/tools.ts}`, `docs/{AI_CONTEXT_MAP.md,RUNBOOK.md}`,
`packages/audit/sanitize.ts`, `packages/correlation/contracts.ts`, `packages/m365/AGENTS.md`, `packages/ops/{commands.ts,m365.ts}`,
`packages/tools/{prisma-ledger.ts,registry.ts}`, `scripts/ops.ts`, `tests/ops-commands.test.ts`, `tests/pg/{AGENTS.md,ops-cli.pg.test.ts}`.
**New (37):** `packages/correlation/{time,parameters,cursor,snapshot,coverage,query,resolve,items,read}.ts`,
`packages/m365/{read-contracts,reads,status-read,maintenance,maintenance-role}.ts`, `packages/tools/{m365,composed-registry}.ts`,
`packages/ops/m365-flags.ts`, `apps/api/src/db/correlations.ts`, 3 unit tests, 13 PG tests, `tests/support/{correlation-fixtures,m365-cli,m365-fetch-preload}.ts`.

## Final required checks (each once, after the last source change)

| Command | Exit | Result |
|---|---|---|
| `npm test` | 0 | 144 tests, 144 pass, 0 fail/skip/cancelled |
| `npm run schema:validate` / `db:generate` / `typecheck` / `api:build` / `api:smoke` | 0 each | smoke PASS |
| `node --env-file=.env <npm-cli> run test:pg` (+`ATLAS_S2C_EVIDENCE_DIR`) | 0 | 306 tests (240 baseline + 66 new), 306 pass, 0 fail/skip/cancelled |
| `node --env-file=.env <npm-cli> run db:check:pg17` / `db:check:drift` | 0 each | all PG17 checks passed; zero drift |
| `git diff --check` | 0 | empty |

Logs and receipts: `/tmp/atlas-s2c/checkpoint/` — `NN_*.log`, `receipts.tsv`, `checks.json` (sha256 `5cf09950…622b`, per-log sha256,
times, counts), `pre/post-check-payload.json`, `evidence/s2c-journey.json` (synthetic C6 receipt, `681f5952…559a`), `perf-measure.json`,
`00_baseline_verify.log`. Scanned: no URL, password, token or vendor secret in any artifact. Local disposable PostgreSQL 17.11 (UTC),
Node 25.8.1, Prisma 6.19.0. Focused runs during development are not counted here.

## Implemented behavior

- **Snapshot/authority:** every read = all-of check on the authenticated actor → one RepeatableRead transaction, SET LOCAL scope first,
  CURRENT actor/membership all-of check in the same snapshot, one DB clock (`date_trunc` ms + µs key). Exactly one workspace denial
  (`correlation.read_denied`, `m365.signins_read_denied`, `m365.directory_read_denied`, `m365.status_denied`, `m365.cleanup_denied`), empty metadata.
- **Resolution:** RawEvent `normalized.externalDevice` → current confirmed Huntress DEVICE link (no `Observation.entityId` fallback);
  route (a) device `deviceId` (never `device.id`), route (b) `Device.personId` user link; selection exactly (a)∪(b); SIGNIN_USER_REFERENCE
  annotation only; per-relation proof; additive 10 reason codes in `packages/correlation/contracts.ts` (six existing codes/fields unchanged).
- **Conflicts:** another unexpired version with membership in a published attempt (COMPLETE/SUPERSEDED, publishedAt set) → CONFLICTED;
  canonicalPersonId/SIGNIN_USER_REFERENCE suppressed; historical versions only flag, never count.
- **Coverage/time:** per-root current published attempt clipped to query + retention; COMPLETE/PARTIAL/UNAVAILABLE independent of
  freshness; capability UNAVAILABLE → MISSING + `M365_SIGNINS_NOT_AVAILABLE`. One 28-char seven-digit key for filtering, count, order
  and keyset; SQL `rpad` key + strict guard; ms prefilter widened; `COLLATE "C"` order/keyset (non-ASCII tested).
- **Cursor:** `{v,b,f,p,e}` + HMAC-SHA256 (timing-safe), shared key `ATLAS_CORRELATION_CURSOR_SECRET_REF` (≥32 bytes, fail closed at service
  entry, first page included), ≤512 chars; fingerprint covers connection lifecycle, Huntress source state, links, Device id/personId,
  directory pointers/latest attempts/membership, user-link digest, roots + latest attempt states, capability and conflict contributors
  (also outside the interval); no clock value. Expiry = earliest future freshness/retention/evidence/contributor/eligibility(from+7d), ≤15m.
- **Surfaces:** `GET /clients/:clientId/observations/:observationId/correlation` (cursor codes in 400/409 bodies); tools
  `atlas.observation.get_correlation`, `microsoft365.signin.list`; ONE composed registry in discovery/policy/execution for DB and fixture
  (fixture readers: honest UNAVAILABLE, injected key). CLI per the frozen table incl. `m365-probe/sync/requeue/directory-reset/status/directory/
  correlation/cleanup`, parse-time flag rules, 512-ASCII cursor exception; S2-B services reused unchanged.
- **Maintenance:** lazy runner URL from `ATLAS_M365_CLEANUP_RUNNER_SECRET_REF`, complete target equality, runtime URL + runner credentials
  (factory-owned pairing `openRuntimeDatabase`), runner-perspective confinement, current authority right before the runner transaction,
  `SET LOCAL statement_timeout`/`lock_timeout 5000ms`/scope/actor, existing `atlas_m365_cleanup`, guard +5s, rollback → `M365_CLEANUP_TIMEOUT`.
- Docs: RUNBOOK §8 (migrate → roles → confinement, secrets, timeout recourse, read expiry, stale states, operator-only refresh), context map/routing.

## C-case → tests

| Case | Tests |
|---|---|
| C1 | `tests/pg/correlation.pg.test.ts` |
| C2, C2a, C2b | `tests/pg/correlation-negative.pg.test.ts` (ID vs deviceId, other tenant, name, guest, rejected/quarantined/two mappings, null/duplicate deviceId, disappear/reappear, absent/invalid ref, re-confirmed agent, 61m STALE, expiresAt EXPIRED without cleanup, newer attempt, no new confirmation); `tests/correlation-units.test.ts` (ambiguous source mapping, unreachable in PG) |
| C3 | `tests/pg/correlation-provenance.pg.test.ts`; person-route test in correlation-negative |
| C4 | `tests/pg/correlation-pages.pg.test.ts` (paging/total, sub-ms cuts, 1/7-digit, non-ASCII, tamper/foreign key, CHANGED for input/actor/mapping/personId reassignment+removal/Huntress state/M365 lifecycle/publication/historical appearance/latest attempt, revoke between pages, input rejection, capability) ; `m365-reads`, `m365-api` |
| C4a | `tests/pg/correlation-expiry.pg.test.ts` (sign-in freshness, directory freshness+expiry, eligibility from+7d, contributor expiry outside interval, narrowed refresh) |
| C4b | first two tests of correlation-pages; coverage unit test |
| C5 | `tests/pg/m365-privacy-retention.pg.test.ts`, `m365-reads`, `m365-e2e` (outputs/audit canaries) |
| C5a | `m365-privacy-retention` (runtime cannot purge; runner no SELECT/UPDATE/SET ROLE; gate + current authority; lock-timeout rollback; contention wait; atomic pointer/payload/audit; fresh publication race; other client protected; Connection/Stage 1 unchanged); `tests/pg/m365-cleanup-target.pg.test.ts` (DB-B runner refused before I/O, same-target substitution, confinement) |
| C5b | `m365-privacy-retention` (DISABLED cleanup); correlation-negative (disabled source, disabled M365); `m365-reads`/`m365-cli-read` (status reads DISABLED) |
| C6 | `tests/pg/m365-e2e.pg.test.ts` (actual CLI + compiled API + tools, preload Graph, review/revoke/reread, ledger/audit, no vendor write) |
| Permissions both/single/split, ledger | `m365-reads`, `tests/pg/m365-tools.pg.test.ts` (FAILED + tool.failed + one denial after membership change/removal), `tests/m365-tools.test.ts`, `m365-api`, `m365-cli-read` |
| CLI recovery | `tests/pg/m365-cli-sync.pg.test.ts` (probe DISABLED→ACTIVE, ACTIVE refusal without I/O, revoke during held probe, degraded 403, create/resume/NOT_DUE zero calls/FAILED/requeue/resume, directory Retry-After/reset) |
| Maximal input / flags | `m365-api`, `m365-tools.pg`, `m365-cli-read`, `tests/m365-ops-maintenance.test.ts` |
| R1/R2 | existing lifecycle-race, operator-passes, decision-config, public-compat, tool-gateway suites in the full runs |

## Risks, limits, items for the reviewer

1. Documented residual gap: a revoke committing after the cleanup's current-authority check but before the runner transaction ends does not stop that pass.
2. Cleanup is time-bounded, not batched; at 600000 ms a backlog requires a reviewed batching amendment (RUNBOOK).
3. Performance (synthetic, local): 19,000 selected sign-ins in 2 roots → ~480 ms per correlation/list page; every page recounts and recomputes
   conflicts/fingerprint over the whole selection (no expression index). Worst case (24 h × 100k rows/root) would be correspondingly slower.
   The first conflict query was super-linear (12 s/page) and was rewritten before the final run.
4. S2-B observation (not changed): `completeLeaf` inserts a leaf's memberships in one interactive transaction with Prisma's default 5 s
   timeout; ~9,500 rows in one leaf exceeded it locally (UNEXPECTED_ERROR → FAILED root). Splitting leaves avoids it; flag for S2-B owners.
5. Additions to review: client audits `m365.signins_read` and `m365.directory_read` (allowlisted counts/local IDs) besides `correlation.read`;
   allowlist keys `ruleVersion,itemCount,total,coverageStatus`; fixture-mode correlation route (all-of denial for the demo actor);
   `CORRELATION_SOURCE_UNSUPPORTED` (validation) for non-Huntress observations; directory/sign-in-list response types in `packages/m365/read-contracts.ts`.
6. Reads use the database clock; S2-B services use the process clock. Host/DB clock skew shifts freshness/expiry decisions by the skew.
7. Nothing live: no tenant, account, credential, deployment, commit, push or outbound message. Mock/preload is not live verification.

No blocker. Write ownership ends with this report.
