All four RC1 findings (F1–F4) are repaired and the final `checks.sh rc2` run passed every step. This report is not acceptance; RC2 still needs a fresh Astra review. I stopped at S4-A and return checkout write ownership to Codex now.

## Final check (`/tmp/atlas-stage4/s4a-checks/rc2/`)
- `npm test`: 196/196 passed.
- `test:pg`: 456/456 passed.
- schema validate, db generate, typecheck, API build and smoke, PG17 check, drift check, `git diff --check` and the untracked-whitespace scan: all exit 0.

Focused logs are in `/tmp/atlas-stage4/s4a-repair1-work/`. No focused or final check failed during this repair. Some first drafts of the new tests had test-side mistakes (an argument helper, a non-meaningful assertion, a wrong expected error code), which I corrected before the logged runs. The RC1 evidence and `/tmp/atlas-stage4/s4a-work` are untouched.

## How each finding was closed
- **F4: disposing an unfinished export is now final.** `dispose()` on an incomplete accumulator permanently fails it. Later pages (including a reused ID or an otherwise valid final page) and `summary()` are refused, and repeated disposal is harmless. A completed export computes its frozen summary once, so internal cleanup or later disposal keeps it retrievable. Test: added to `tests/poweroffice-dto.test.ts`, including the reviewer's scenario.
- **F2: the claim deadline uses the real DB clock.** The guard triggers compare the unrounded DB clock with the original `deadlineAt` (never renewed), whatever timestamp the writer supplies.
  - A new snapshot, ACTIVE→SUCCEEDED or ACTIVE→FAILED at or after the deadline is refused with new error `PO007`, mapped to `POWEROFFICE_DEADLINE`.
  - The deferred commit check repeats the test, so statements run before the deadline but committed after it roll back.
  - ABANDONED is refused before the deadline. A no-op update of an already SUCCEEDED row ("receipt") is still allowed.
  - New `tests/pg/poweroffice-deadline.pg.test.ts` covers the reviewer's backdated case as runtime and as owner, waiting until the DB clock reaches the deadline, the commit-time boundary for both publication and FAILED, and the receipt no-op. Each refusal is checked for zero snapshot, pointer or terminal changes.
  - Three expectations in `poweroffice-history` changed from the old error codes (PO002 and the CHECK error 23514) to `PO007`, because the clock check now fires first. They remain exact.
- **F3: the full fixture pair is now a database rule.** I added a CHECK named `Connection_poweroffice_binding_check` as the first statement of the pending `202610091200` migration.
  - Any PowerOffice Connection whose tenant has the `synthetic-po-<uuid>` shape must have exactly `fixture://poweroffice/<same uuid>`, for every role and every update.
  - Other systems and non-synthetic PowerOffice rows are not constrained; those rows stay unusable and cleanup refuses them.
  - The definer's Connection columns are unchanged (still no `secretRef`), and no new privilege or credential lookup was added.
  - Cleanup, readiness and `roles.sql` refuse if the constraint is missing or not validated; readiness also requires its exact definition.
  - New `tests/pg/poweroffice-binding.pg.test.ts` covers malformed, non-fixture, mismatched, upper-case and NULL references, and edits between admission and cleanup refused for both owner and runtime with no fence move. It also covers a missing, unvalidated and altered constraint.
  - In the upgrade case, a database already holding a bad pair fails `migrate deploy` with nothing applied or rewritten; after the operator fixes the reference and marks the migration rolled back, it deploys.
  - Root may want to look at this choice: enforcing the documented pair in the database seemed to me consistent with the approved contract, not a change to it.
- **F1: the maintenance roles' routine access is checked completely.** Readiness now checks every routine the PowerOffice definer and runner can execute, in any schema. Only their own cleanup capability plus the existing shared Stage 3 helper list (reused, not widened) is allowed; any other routine, any SECURITY DEFINER routine and any explicit grant fail.
  - These checks are folded into the existing fact keys, so no interface changed.
  - `roles.sql` revokes such grants and refuses what it cannot revoke (PUBLIC access, inherited membership).
  - Tests in `poweroffice-roles` cover: the reviewer's reproduction (works before, revoked after reprovision); each role separately; an invoker helper; a foreign schema; grant options; explicit grants on shared helpers; PUBLIC and inherited paths refused. The authority test shows an admission refused as not ready before any work.

## Changed paths versus the repair baseline
- **Changed (15):**
  - `docs/AI_CONTEXT_MAP.md`
  - `packages/graph/poweroffice-role.ts`
  - `packages/poweroffice/{AGENTS.md,authority.ts,export.ts}`
  - the three pending migrations `202610091200`, `202610091210`, `202610091220`
  - `prisma/roles.sql`
  - `tests/pg/AGENTS.md`
  - `tests/pg/poweroffice-{authority,history,roles}.pg.test.ts`
  - `tests/poweroffice-{dto,policy}.test.ts`
- **Added (2):** `tests/pg/poweroffice-{deadline,binding}.pg.test.ts`.
- There is no new migration (still 23), and the original 20 migrations plus lock, all reports, status files, the brief, norms, seals, evidence and old fixtures are unchanged. Every file is under 400 lines.

## Still deferred
- **S4-B:** source sessions, claim/publication/failure/recovery services, same-fact retries, and the Connection-update deadlock orderings.
- **S4-C:** maintain admission, runner pairing, the 10 s / 1 s cleanup wrapper, API/CLI and their journeys.
- **LIVE:** remains deferred.