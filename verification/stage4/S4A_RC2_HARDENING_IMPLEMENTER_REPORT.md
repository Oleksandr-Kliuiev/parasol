The F3 gap is closed: the cleanup routine now refuses unless the paired-binding constraint has exactly its expected definition. The single final run `checks.sh rc2-final` passed every step. This is not acceptance; RC2 still goes to a fresh Astra review.

**One correction to your brief:** `prisma/roles.sql` only checked that the constraint existed and was validated, not its exact definition. So provisioning would also have accepted a same-name `CHECK (true)`. I added the exact-definition check there too. The routine, provisioning and readiness now all require the same rendered definition, and the provisioning refusal message now says "missing, not validated or altered".

**Changed paths (3 files, all under 400 lines):**
- `prisma/migrations/202610091220_stage4_poweroffice_cleanup/migration.sql`: before taking any lock, the routine requires the binding constraint to exist, be validated and have exactly its definition. It reads only catalog metadata: no new Connection column, privilege, `secretRef` read or secret lookup.
- `prisma/roles.sql`: the exact-definition check described above.
- `tests/pg/poweroffice-binding.pg.test.ts`: new regression through the actual runner. It covers the missing and NOT VALID constraint, then:
  - swaps in a validated same-name `CHECK (true)` (readiness fails and provisioning refuses);
  - writes an invalid `secretRef`;
  - runs cleanup, which refuses with error PO010 and only the fixed message `POWEROFFICE_CLEANUP_FAILED`, leaking no reference or definition, with no pointer, delete or audit change.

  A `finally` block restores the valid reference and the exact constraint. Afterwards readiness is healthy, provisioning reruns, and a valid cleanup still completes.

**Checks:**
- **Focused** (logs in `/tmp/atlas-stage4/s4a-repair1-hardening-work/`):
  - typecheck: exit 0
  - binding test: 5/5 passed
  - cleanup, authority, roles, nonsuper, upgrade and locks tests: 28/28 passed
  - `npm test`: 196/196 passed
- **Final** (`/tmp/atlas-stage4/s4a-checks/rc2-final/`):
  - `npm test`: 196/196 passed
  - `test:pg`: 456/456 passed
  - schema validate, db generate, typecheck, API build and smoke, PG17 check, drift, diff check and untracked-whitespace scan: all exit 0

No check failed in this phase. The earlier `rc2` and `s4a-repair1-work` logs were not touched. No docs, status, evidence, briefs, norms, frozen migrations or grants changed. B, C and LIVE scope remain deferred.

I'm stopping here and returning checkout write ownership to Codex.