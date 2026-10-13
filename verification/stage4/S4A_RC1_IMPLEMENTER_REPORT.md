S4-A is implemented and the final checkpoint run (`checks.sh rc1`) passed every step. This is my implementation report, not acceptance; Astra still needs to review it.

## Final checks
Logs are in `/tmp/atlas-stage4/s4a-checks/rc1/`, and every step exited 0:
- `npm test`: 195 tests, 195 passed.
- `test:pg`: 446 tests, 446 passed.
- `schema:validate`, `db:generate`, `typecheck`, `api:build`, `api:smoke`, `db:check:pg17` and `db:check:drift` all passed.
- `git diff --check` and the untracked-whitespace scan were clean.

**Earlier failed run, kept.** Before the final run I ran the full PG17 suite once on its own (log `/tmp/atlas-stage4/s4a-work/test-pg-1.log`): 442 of 446 passed. The 4 failures were existing tests that assert an exact number of migrations or roles (in `action-upgrade-s3b`, `action-upgrade-s3c` and `m365-privileges`). I updated them to the new exact values: 20 frozen migrations plus the three named Stage 4 ones, and 6 or 12 roles. No assertion was loosened.

**Run time differs.** That earlier PG run took 541 s and the final one 57 s for the same 446 tests. I haven't looked into why.

**Bugs found and fixed during the work:**
- The SQL check that runs at commit time read a column that only exists on the attempt table. PostgreSQL doesn't skip that read when the check fires for the other tables, so I nested the condition.
- `TRUNCATE` on the snapshot table returned the "immutable" error code; it now returns the same "deletion refused" code as the other tables.

## What was implemented
- **DTOs and arithmetic (A1):** strict normalized page/header/invoice and aggregate checks in `packages/poweroffice/`. Inputs are read once into frozen copies. Money uses exact BigInt cents. Dates must be real Gregorian dates, and the business date is the Europe/Oslo date of the claim time, tested across both daylight-saving changes and midnight.
  - A shared set of 41 adversarial aggregates gets the same verdict from the TypeScript validator and the SQL trigger.
- **Shared token lookup:** `currentToken` and `setLocal` were moved unchanged into `packages/auth/transaction-token.ts`. The Stage 3 module imports and re-exports them, and the existing Stage 3 tests pass.
- **Bearer authority (A4):** a private credential, the workspace fence taken first (shared for reads, exclusive for writes), readiness checks, then all permissions required on one membership. A refusal writes exactly one workspace security audit row and never a client audit row. The scope is set only after that check, and the token, actor and permissions are re-checked with the DB clock after the last lock.
  - Tested against PG17: a token expiring during a real lock wait is refused, a real deadlock returns the fixed `POWEROFFICE_DB_CONFLICT`, and a failed denial audit returns `POWEROFFICE_AUDIT_FAILED`.
- **Schema (A2):** three new migrations (`202610091200`, `…1210`, `…1220`) and `prisma/poweroffice.prisma`. They add:
  - foreign keys that always include workspace, client and connection;
  - CHECKs where a NULL can never pass;
  - triggers that make identities and history immutable;
  - the exact 60 s / 80 s deadlines and 24 h snapshot expiry;
  - delete guards that apply to every role;
  - a one-ACTIVE-claim rule;
  - deferred checks that make a bad state fail at COMMIT.
- **Roles and readiness (A3):** `roles.sql` gives the runtime column-limited grants and creates two new maintenance roles. The new definer owns the routine and no tables; the new runner can only execute it. Each new table gets a restrictive three-ID policy on top of the normal scope policy. New readiness checks (`packages/graph/poweroffice-role.ts`) fail closed on 14 kinds of tampering.
  - The Stage 3 fence keeps exactly its two policies, its shared helper list is unchanged, and every new routine has PUBLIC EXECUTE revoked in its own migration.
- **Cleanup routine (item 5):** tested only by calling it directly as the real runner. It refuses any argument that doesn't match its scope settings, and it returns BUSY when any claim is ACTIVE. Otherwise it deletes expired snapshots first (clearing the pointer while keeping `lastSuccessAt`), then attempts older than 30 days, at most 1,000 rows per call combined, and reports whether more remain. It writes one audit row with only the six allowed keys, and a failed audit rolls everything back.
- **Generic paths (items 7 and 8):** the generic connection resolution and activation refuse PowerOffice before any secret resolver runs. The list of bindable systems is unchanged. The client context and Gateway tools expose no PowerOffice data or tool. Four audit keys were added, and a local factory keeps PowerOffice audit rows to exactly six keys.
- **Upgrade (R2):** a populated database on the accepted 20 migrations and S3-C roles (`tests/support/poweroffice-roles-s3c.sql`, a byte-exact copy) was upgraded. Before role provisioning, Stage 3 fence readiness and admissions still worked and PowerOffice refused. After provisioning, run twice, data, fences, memberships and Connection privileges were unchanged and no permission was granted automatically.
- **Non-superuser migration owner:** provisioning works, the owner is confined by row-level security on the new tables, and the runner's purge completes without permission errors.

## Changed paths
- **New:**
  - `packages/poweroffice/*` (10 modules and an AGENTS file);
  - `packages/auth/transaction-token.ts` and `packages/graph/poweroffice-role.ts`;
  - the three migrations and `prisma/poweroffice.prisma`;
  - 3 unit test files, 11 `tests/pg/poweroffice-*` files and 4 `tests/support/poweroffice-*` files.
- **Existing files:** 29 baseline files changed, all inside the allowlist:
  - the actions authority extraction;
  - `sanitize.ts`, `connections.ts`, `runtime-role.ts`, `roles.sql`, and relation fields in `schema.prisma`;
  - test support: role renderer, PG harness, PGlite;
  - the role-name and count updates in existing tests;
  - routing lines in `AI_CONTEXT_MAP`, `prisma/AGENTS`, `tests/pg/AGENTS` and `packages/actions/AGENTS`.

  The other 643 baseline files have the same hashes as before, including all 20 installed migrations, the lock file and the normative and status documents. Nothing was committed.

## Deferred, by design
- **S4-B:** the synthetic port and session, claim/publication/recovery services, and same-fact publication retries.
- **S4-C:** fresh maintain admission, pairing the runner with the database, the 10 s transaction / 1 s lock-timeout wrapper, the API and CLI.
- **Not done in S4-A:** deadlock tests where a concurrent Connection UPDATE races admission or publication (those tests are scheduled for S4-B/S4-C).

## Things to know
- **The 512 KiB page and 8 MiB export limits can't be hit by valid data.** A full 100-item page is about 17 KB. They're enforced but not testable with valid input.
- **Fixed timing checks.** Claim, completion and publication times must be within 10 s of the database clock. Test fixtures that need old rows shift them back as a superuser in replica mode, which is test-only.
- **Rule for later checkpoints.** The commit-time checks run under the committing role's row-level security, so S4-B/S4-C services must keep the client scope set until COMMIT after any PowerOffice write. This is noted in `packages/poweroffice/AGENTS.md`.