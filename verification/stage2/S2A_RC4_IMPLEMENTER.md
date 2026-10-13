Implementation handoff — NOT independent acceptance.

The reported defect is fixed at all six early-return sites, plus two related skip-on-missing checks, and the full PostgreSQL suite passes (174/174). This still needs independent acceptance.

**Cause.** Each lifecycle INSERT trigger returned early when it couldn't find the parent row, trusting the foreign key to reject the row later. When the parent is inserted by the same statement (a data-modifying CTE), the trigger can't see it yet, but the foreign key checked at the end of the statement can. So the child skipped its initial-state and parent-state checks. For a directory generation this meant a committed PUBLISHED generation with no pointer, because the deferred atomicity check only covers the STAGING→PUBLISHED update.

**Fix.** At each INSERT, the trigger now checks the permitted initial state first, independently of the parent lookup. A missing or invisible prerequisite raises an explicit error instead of returning early. If the parent is found, the existing locked parent validation runs unchanged. Parent-first creation in one transaction, with separate statements, still works.

| Site | Initial state checked first | Prerequisite that must already exist |
|---|---|---|
| generation | STAGING | resource state |
| directory object | — | its generation, STAGING |
| attempt | RUNNING | window |
| leaf | PENDING | its attempt, RUNNING |
| membership | — | attempt, leaf, and evidence version |

Two related checks had the same skip-on-missing pattern:
- **Membership evidence lookup:** it skipped the bounds check when the evidence row wasn't visible. It now refuses instead.
- **ExternalEntity system check:** it is now an AFTER ROW trigger. It runs after row-level security, sees a connection inserted by the same statement, and refuses a connection that is missing.

The pointer fence, the deferred commit-atomicity checks, the lock order and the production grants are unchanged.

**New tests.**
- **Shared PGlite + PostgreSQL** (`tests/m365-prerequisite-invariants.ts`, run by `tests/m365-database.test.ts` and `tests/pg/m365-prerequisites.pg.test.ts`):
  - terminal initial states are refused with and without the parent present;
  - missing parents are refused for every site;
  - the same-statement CTE cases are refused, including a PUBLISHED generation and evidence plus membership in one statement;
  - a refused child rolls back its whole transaction, parent included;
  - ordered creation in one transaction succeeds for both resource types;
  - an ExternalEntity CTE with a mismatched connection system is refused.
- **Production runtime role:** the same CTE, missing-parent and ordered-creation cases, with rollback confirmed.

**Existing assertions updated.** Three now expect the specific "needs … to exist first" message instead of the foreign-key or row-level-security error: one in `tests/m365-sql-invariants.ts` and two in `tests/pg/m365-schema.pg.test.ts`. Each still requires the insert to be rejected.

**Checks.** Typecheck: 0 errors. `npm test`: 107/107. Full `test:pg`: 174/174. `db:check:pg17` and `db:check:drift` pass, and `git diff --check` is clean. The Stage 1 review hash and RC5 hash are unchanged, no historical migration was touched, and no test roles or databases were left behind.

**Files changed.**
- `prisma/migrations/202610081000_stage2_m365_directory/migration.sql` (generation and object INSERT, ExternalEntity trigger)
- `prisma/migrations/202610081150_stage2_m365_signin_triggers/migration.sql` (attempt, leaf, membership)
- New: `tests/m365-prerequisite-invariants.ts`, `tests/pg/m365-prerequisites.pg.test.ts`
- Updated: `tests/m365-database.test.ts`, `tests/m365-sql-invariants.ts`, `tests/pg/m365-schema.pg.test.ts`, `docs/AI_CONTEXT_MAP.md`

**Limits.**
- Inserting an inaccessible parent and child together now fails with the trigger's prerequisite message rather than a row-level-security or foreign-key error; the row is refused either way.
- Creating a lifecycle child and its parent in one statement is no longer possible by design; the S2-B workers must create them in separate statements.
- I searched for this pattern only in the M365 migrations. I didn't continue the reviewer's interrupted exploratory probes, as instructed.
