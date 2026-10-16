Implementation handoff — NOT independent acceptance.

The remaining F2 gap is closed in SQL. A generation or sign-in attempt can no longer be published without its pointer in the same transaction, and the pointer change itself re-checks the Connection and the newest-started attempt. The full PostgreSQL suite passed twice (172/172), and the review's probe scenario now fails at both steps.

**1. Pointer fence.**
- **Where:** the resource-state trigger in `202610081000` and the window trigger in `202610081150`.
- **Newest started only:** a non-null pointer change must target the newest started attempt. The root row is locked by the UPDATE and its start sequence never decreases, so this is checked against the current value.
- **Connection fence:** the pointer change also requires an ACTIVE Connection at the target's lifecycle version. The Connection lock is taken with NOWAIT, because the root row is already locked, so out-of-order SQL fails fast (55P03) instead of deadlocking.
- **What stays valid:** a pointer that doesn't change is never rechecked. A retained pointer stays valid after a newer start, a failure record or a disable, and the expired-pointer cleanup path is untouched.

**2. Commit atomicity.** A deferred constraint trigger fires on the first STAGING→PUBLISHED and the first RUNNING→COMPLETE transition. At commit it verifies that the root pointer names that row.
- **Plain COMMIT** without the pointer is refused.
- **Savepoints:** rolling back to a savepoint that undid the pointer leaves the publish event queued, so the commit is still refused.
- **`SET CONSTRAINTS IMMEDIATE`** only makes the check fire earlier, and fail while no pointer exists.
- **History stays valid:** rows published earlier remain valid after a newer pointer replaces them or after cleanup, because only the publishing transaction is checked. Superseding the previous attempt in the same transaction works.

**Tests.** New `tests/pg/m365-publication-atomic.pg.test.ts` (6/6), covering both resource types with real runtime sessions:
- publication or completion alone is refused at COMMIT, after the savepoint rollback, and under IMMEDIATE;
- an atomic publication succeeds, and for sign-ins it can also supersede the previous attempt;
- a disable or a newer start between completion and pointer, inside one transaction, is refused at the pointer and the retained pointer is unchanged;
- a failure record committed after a newer start and a disable keeps the last good pointer;
- when publication goes first, a concurrent disable is observed waiting, then ends DISABLED with that pointer. The opposite order (disable first) stays covered by the existing race tests.

The shared PGlite/PG17 checks gained terminal-only refusal, atomic success and both in-transaction pointer refusals.

**Fixtures.** Every successful publication in the fixtures now happens in one transaction with its pointer. No constraint was weakened and no grant was widened.

**Checks run.**
- typecheck: 0 errors
- `npm test`: 106/106
- `db:check:pg17` and `db:check:drift`: pass
- full `test:pg`: 172/172, run twice on the same cluster
- `git diff --check`: clean
- Stage 1 `REVIEW_REPORT.md` and RC5 hashes unchanged; no historical migration modified
- 0 leftover test roles or databases

**Changed files**
- Migrations: `prisma/migrations/202610081000_stage2_m365_directory/migration.sql`, `prisma/migrations/202610081150_stage2_m365_signin_triggers/migration.sql`
- Tests: `tests/m365-sql-invariants.ts`, `tests/support/m365-fixtures.ts`, new `tests/pg/m365-publication-atomic.pg.test.ts`
- Docs: `docs/AI_CONTEXT_MAP.md`

**Remaining issues**
- **One root per transaction:** the commit check assumes each publishing transaction moves one root to the row it publishes. Publishing two generations of the same resource in one transaction is refused, which matches the newest-started rule.
- **Ordering contract for S2-B:** publishers must still take Connection → root → attempt or generation in that order; out-of-order SQL fails with 55P03.
- **Superusers** can still disable triggers or bypass these checks.
- This needs a fresh independent acceptance; I haven't claimed one.
