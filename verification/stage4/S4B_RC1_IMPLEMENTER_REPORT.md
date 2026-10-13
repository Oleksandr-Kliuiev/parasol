S4-B (B1–B5) is implemented on the final checkpoint source and is ready for independent Astra/xhigh review. The one-time `/tmp/atlas-stage4/s4b-tools/checks.sh rc1` run passed all 11 commands. The checks didn't change the source: the inventory hash is the same before and after (800 files, `0106c315…b9850`). I made no commits, branches, worktrees or PRs, and wrote nothing to status/review/verification files. S4-C and LIVE were not started.

## Final checkpoint run (`/tmp/atlas-stage4/s4b-checks/rc1/`)
12:56:31–12:59:23 UTC, every command exit 0:

| Command | Result |
|---|---|
| `npm test` | 208/208 |
| `schema:validate`, `db:generate`, `typecheck`, `api:build` | pass |
| `api:smoke` | PASS |
| `test:pg` | 507/507, 149 s |
| `db:check:pg17` | pass |
| `db:check:drift` | no drift |
| `git diff --check`, untracked whitespace | 0 bytes |

Final source inventory: `/tmp/atlas-stage4/s4b-work/final-source-inventory.sha256`.

## What was built
- **B1 – mode and built-in port:** PowerOffice is DISABLED unless `ATLAS_POWEROFFICE_MODE` is exactly `MOCK`. Any variable that would set a URL, origin, script, callback, file, tenant, credential or clock refuses the setup. A forged or copied composition object is refused before any database access. The built-in synthetic export has no network, secret, file or environment access, and stops when aborted or past its deadline (before, during and after its work).
- **B2 – claim:** sync admission refuses a bad binding before creating any State row. It allows one ACTIVE claim per connection: a second sync is `POWEROFFICE_SYNC_BUSY`, even after the claim expires. 1000 retained attempts give `POWEROFFICE_SYNC_LIMIT`, before any source call. The local deadlines are anchored before the final admission DB-clock read. Every page, including the first, needs a fresh committed authorization, with no transaction held during the source call. Per-page deadline is min(now+10 s, the original 60 s read deadline).
- **B3 – complete export only:** pages go through the accepted `ExportAccumulator`. Any defect ends the whole pass with no retry and no staged or logged data, and the previous snapshot stays published.
- **B4 – publication:** one transaction publishes the snapshot, pointer, SUCCEEDED state, lastCompleted, lastSuccessAt and audit row, using the same fact and the IDs allocated at admission.
  - Replaying an identical fact returns a no-op receipt, also after the deadline, and still needs fresh authority and an unchanged binding.
  - The same identity with a different fact is `POWEROFFICE_PUBLICATION_CONFLICT`.
  - Only a real 40P01/40001 is re-run, at most 3 transactions in total, with zero extra port calls.
  - Any other failure (audit, timeout, unknown commit) returns its fixed code and leaves the claim ACTIVE for recovery.
- **B5 – failure and recovery:**
  - The private failure capability carries no credential. It closes only its own ACTIVE claim before 80 s, a repeat call is a no-op, and at or after 80 s it changes nothing.
  - Recovery never calls the port and never creates State. Before 80 s it returns `POWEROFFICE_RECOVERY_NOT_DUE`. At or after 80 s it marks the claim ABANDONED, including when the connection was since DISABLED or its lifecycle version moved on. With no ACTIVE claim it returns `POWEROFFICE_NO_ACTIVE_ATTEMPT` and writes nothing.

**The one change to an S4-A file** is in `packages/poweroffice/authority.ts`. It adds a module-private WeakSet that marks a fixed `POWEROFFICE_DB_CONFLICT` only when the database actually reported 40P01/40001; P2034, P2028 and other conflicts stay unmarked. The public error (code, kind, details, message, keys) is identical either way. The S4-A PG group passed against this change (57/57 in a focused run, plus the full `test:pg`).

**FK deadlocks (mandatory cases):** all six orderings are real PG tests: the Stage 4 transaction as victim and the Connection UPDATE as victim, at both admission and publication, plus an Actor case. Two things worth knowing:
- A plain non-key `UPDATE "Connection"` does not deadlock with these inserts; only a mutator that first locks the row (`SELECT … FOR UPDATE`, then `UPDATE`) does. The handoff text implied a plain UPDATE takes an exclusive lock. A dedicated test records the plain-UPDATE behaviour.
- To make the victim deterministic, the test's own superuser session sets `deadlock_timeout` (5 s or 400 ms) for that session only. This is not a catalog or privilege change, and each deadlock is still a real one. Stage 4 code never locks the Connection row.

**Real-wait and privacy evidence:**
- One batched ~82 s timeline against stored DB-clock deadlines, with no clock override, covers:
  - the original 60 s read cap
  - publication still allowed between 60 and 80 s
  - an expired claim still BUSY
  - late results that can't publish
  - recovery after disable or lifecycle drift
- A child process with its real stdout/stderr captured shows no output and zero socket/fetch calls; the network trap's positive self-control against a local endpoint is seen.
- A scan of every database table finds no invoice ID, export ID or company key outside the Connection binding.

## Changed paths
- **Modified (5):** `packages/poweroffice/authority.ts`, `packages/poweroffice/AGENTS.md`, `docs/AI_CONTEXT_MAP.md` (one routing row), `connectors/poweroffice/README.md`, `.env.example` (`ATLAS_POWEROFFICE_MODE=`, default DISABLED).
- **Added source (12):** `packages/poweroffice/{composition,capabilities,rows,admission,page,pass,publication,failure,recovery,sync}.ts`, `connectors/poweroffice/{contract,builtin}.ts`.
- **Added tests (10):** `tests/poweroffice-{builtin,composition}.test.ts`, `tests/pg/poweroffice-{sync,pages,publication,fk-victims,recovery,privacy}.pg.test.ts`, `tests/support/poweroffice-{sync,privacy-child}.ts`.
- No migration, schema, `prisma/roles.sql`, readiness check, or Stage 1/2/3 change. The largest file is 207 lines.

## Focused test counts
12 new unit tests and 34 new PG tests (sync 8, pages 5, publication 7, fk-victims 6, recovery 4, privacy 2), plus 15 S4-A unit regressions. The two deadlock suites passed 3/3 stability reruns each.

## Failed runs, all kept in `/tmp/atlas-stage4/s4b-work/`
- **My own test errors** (each fixed by correcting the test, never by loosening the code):
  - a timing-dependent 0.5 ms built-in case and a static scan that matched the word "OAuth" in a comment (`unit-builtin-1`)
  - a brittle `env[` count (`unit-composition-1`)
  - a wrong expectation for the `outsider` actor (`pg-sync-1`)
- **Privacy hang:** replacing `process.stdout.write` inside a `node --test` child broke the test runner's stdout protocol and the run hung. I killed it. The early attempt also started its cases concurrently, which was a test bug. I replaced it with the child-process capture above. Logs: `pg-privacy-1`, `privacy-instrumented`, `privacy-steps`, `probe-*`.
- **Killed runs leave their database behind:** a killed test skips its cleanup, so I dropped only my own two databases and their roles and confirmed none remain (`leftovers-*`, `leftover-roles-1`).
- **Deadlock victim flake:** one run picked the holder session as the victim instead of the publication (`pg-publication-2`); fixed with the per-session `deadlock_timeout` described above.

## Residual scope and notes
- **Not done here (S4-C/LIVE):** API, CLI, status/summary reads, maintenance admission and the cleanup runner wrapper, the HTTP/CLI privacy journey. No vendor mapping, completeness or production readiness is claimed.
- **Internal step functions:** `publishFact` and `closeFailed` are exported for tests and orchestration. They are not public services and need the private capability. `testFaultComposition` is a private test seam; a test confirms no production module imports it.
- **Old leftover databases:** two `atlas_it_*` databases from before this session (09:33 and 11:06 UTC) still exist. They are not mine and I left them untouched.
- **Session:** native claude-opus-5-5/high in a fresh session (preflight: claude.ai Max, first party, extra usage off, no provider overrides). Elapsed about 1 h. Usage quota attribution is unknown.

**I return sole checkout write ownership to Codex now; I will make no further edits.**