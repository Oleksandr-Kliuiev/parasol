R1 is fixed and the S4-B repair is ready for fresh independent Astra/xhigh review. The one-time `checks.sh rc2` passed all 11 commands, each parsed individually from the summary. The source was identical before and after the check run. I made no commits, branches, worktrees or PRs, wrote nothing to status/review/verification files, and did not start S4-C or LIVE.

## Repair
Publication is now bound to the exact fact the claim's own export pass completed.

- **`packages/poweroffice/capabilities.ts`** (now 110 lines):
  - A new module-private WeakMap holds each claim's completed fact: a detached, frozen, re-validated copy and its canonical JSON form.
  - `bindCompletedFact` stores it exactly once, only while the claim is READING, and is the only way a claim becomes COMPLETE.
  - `completedFact` returns it only for a COMPLETE claim; otherwise `POWEROFFICE_CLAIM_STALE`.
  - `endClaim` now also drops the stored fact.
- **`packages/poweroffice/pass.ts`** (86 lines): when the pass completes it calls `bindCompletedFact(claim, summary)` instead of `record.phase = 'COMPLETE'`. Buffer disposal and session closing on every exit are unchanged.
- **`packages/poweroffice/publication.ts`** (91 lines):
  - `publishFact` reads the bound fact first. The fact the caller passes must have the same canonical form as the bound one, or the call returns `POWEROFFICE_PUBLICATION_CONFLICT` before any authority transaction, database write or audit.
  - What is persisted, and what a SUCCEEDED replay is compared against, is always the bound fact, never the caller's object.
  - Authority/binding checks, the deadline, the after-deadline identical receipt, the at-most-3 same-fact known-rollback retry, and the stored-snapshot conflict check are unchanged.

No other module needed to change. `sync.ts` already passes the pass's own summary, which now matches by construction. Nothing in S4-A authority, schema, roles, readiness, migrations, contracts or Stage 1/2/3 changed.

Relative to `S4B_RC2_REPAIR_BASELINE.json`, the delta is those 3 modified files plus the new test `tests/pg/poweroffice-provenance.pg.test.ts` (99 lines). Inventory: 810 files, `34ee267dc702ad7f34ffc4ab9434984b7e88ca516c3453f9bfa6f364a937b5d7`, the same before and after the checks.

## Regression and negative control
The new file uses the production MOCK composition and the real built-in export, with no fault seam, and has three tests:
1. A genuine completed claim refuses two different valid first facts: the known-empty fact, and one with the same count but different amounts. Each refusal leaves no snapshot, pointer, terminal state or success audit. The authentic fact, passed as a detached clone, then publishes exactly once with the claim's original IDs and content. An identical replay is a no-op, and once the claim has ended publication returns `POWEROFFICE_CLAIM_STALE`.
2. Another genuine claim's completed fact is refused, in both directions; each claim then publishes only its own.
3. After a first publication that rolled back (audit fault), a changed fact is refused with nothing else in the way (fault removed, claim ACTIVE, before the deadline). The authentic fact then commits once.

| Run | Result | Log |
|---|---|---|
| New regression on unmodified RC1 | **0/3 pass** (the substitute returned `ok`) | `/tmp/atlas-stage4/s4b-repair1-work/negative-control-rc1-provenance.log` |
| New regression on repaired source | **3/3 pass** | `provenance-repaired-1.log` |
| Astra's `fact-provenance.ts`, unmodified, on repaired source | stops with `POWEROFFICE_PUBLICATION_CONFLICT` (defect gone) | `astra-repro-on-repaired.log` |
| Focused unit (all PowerOffice) | **27/27** | `focused-unit.log` |
| Focused PG: provenance, publication, sync, pages, fk-victims, recovery, privacy, authority | **42/42**, existing tests unmodified | `focused-pg.log` |

## Final checks (`/tmp/atlas-stage4/s4b-checks/rc2/`, 08:25:15–08:27:58 UTC)
Every command exited 0:

| Command | Result |
|---|---|
| `npm test` | 208/208 |
| `schema:validate`, `db:generate`, `typecheck`, `api:build` | pass |
| `api:smoke` | PASS |
| `test:pg` | 510/510 (RC1's 507 plus the 3 new) |
| `db:check:pg17` | pass |
| `db:check:drift` | PASS, no drift |
| `git diff --check`, untracked whitespace | 0 bytes |

## Residual notes
- There were no failed repair attempts. The only failing run was the intended negative control, which is kept. All RC1 failure logs remain in `/tmp/atlas-stage4/s4b-work/`.
- A changed fact on a SUCCEEDED replay now refuses before fresh authorization, not after. It is the same `PUBLICATION_CONFLICT` with no effects and no data returned. The identical-fact receipt still requires fresh authority and an unchanged binding.
- Astra noted that the privacy test's title promises an export-ID scan the test doesn't actually perform. That file was outside this repair's scope, so it is unchanged.
- I added no automated copies of Astra's direct-UPDATE probes; they were optional and not requested.
- The two `atlas_it_*` databases from before my session (2026-10-09 09:33 and 11:06 UTC) are untouched. No databases or roles from this repair remain.
- Model and routing: claude-opus-5-5/high, resumed in the same native session (`31d86f05…`) per the preflight (claude.ai Max, first party, extra usage off, no provider override). Subscription quota attribution is unknown, and per-segment usage counters don't cover the whole session.

**I return sole checkout source-write ownership to Codex now and will make no further edits.**