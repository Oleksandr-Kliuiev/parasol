# S4-A / S4A-rc4 independent checkpoint review

**Verdict: CHANGES_REQUIRED.** One confirmed P2 finding remains in A3 runtime readiness. The current provisioning path already removes the tested grant options; the required corrective scope is the readiness predicate and focused regressions. S4-B and S4-C remain NOT_STARTED; LIVE remains DEFERRED_BY_OWNER.

Reviewer: native `/root/astra_s4a_rc4`, explicitly assigned **gpt-6-astra / xhigh**, fresh independent context. This is the effective effort of this review. Model assignment is grounded in the parent's native dispatch, not model self-identification or implementer accounting. I did not read prior S4-A assessment reports/verdicts. Review performed on 2026-10-09, read-only in the repository; only report/probes/logs under `/tmp/atlas-stage4` were written.

## Exact artifact and preservation

Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; branch `planning/stage2-m365`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66` plus the manifest's dirty inventory. HEAD diff is not the checkpoint delta.

| Identity | SHA-256 |
|---|---|
| `verification/stage4/S4A_RC4_MANIFEST.json` | `408de3d0aab9fc6e13d8657cebcee8d7b3a5ccbbd9f02e45e9d2cd88ee2c2dfc` |
| Source package, 721 files | `8d31d976ec42a84828ac36265bd71e8f4e090f70057ef231fb71dbccb0f81beb` |
| Working inventory, 760 files | `b0563f2eaedb7b738622597d018583e656a0665cd606dd7158c11019d9873bc3` |
| `verification/stage4/S4A_RC4_PACKAGE.zip` | `f3365f218fd2ccb7e1d1c883358376ace1f406bad58d1b724fa5f68d0b182fe1` |
| Approved eight-file architecture | `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec` |
| `docs/stage4/IMPLEMENTATION_HANDOFF.md` | `9f199dbb27d255f60db9f926e788cc23b5cba83722d5c0aff780a913f18b94ab` |
| RC4 implementation evidence | `30a962fccc3abcd0a34e06d4676fbbe272205a773f485111405e4162636e9c28` |
| RC4 repair baseline | `9f917fad6ee387e6ea9fba672743b8b9e10ab21289f4ea9180822693d48bf9ca` |

Independently recomputed every source/inventory file hash and both aggregate hashes before and after review. The archive has exactly the 721 declared members and their matching content; its hash also remained unchanged. The approved architecture's eight files and aggregate hash match. Baseline comparison found exactly the 30 declared existing-file changes, no undeclared change or deletion. The original 20 migrations plus lock are unchanged. The frozen earlier norms, historical artifacts and fixtures are outside that changed set; an additional 302-file preservation subset covering migrations/history/fixtures matched. The copied S3-C role fixture equals the accepted archive's `prisma/roles.sql` byte for byte. `packages/graph/fence-role.ts` and `packages/auth/authority.ts` remain unchanged. New/changed PowerOffice active source examined is below 500 lines. The three pending PowerOffice migrations are part of this exact unaccepted artifact, not changes to installed history.

Identity evidence: `/tmp/atlas-stage4/astra-rc4-identity-before.json` and `astra-rc4-identity-after.json`.

## Required finding

**R1 — P2: Runtime grant options are invisible to the exact PowerOffice readiness check.**

Location: `packages/graph/poweroffice-role.ts:140–147` (`poRuntimeGrantViolations`); regression entry `tests/pg/poweroffice-roles.pg.test.ts:37`. The predicate checks forbidden ordinary privileges and out-of-allowlist UPDATE columns, but never checks table or column grant options for the runtime. The maintenance-role predicate separately checks grant options; it does not cover `r`, the runtime role. Both full startup and per-admission PowerOffice readiness therefore report healthy after these capability changes.

Reproduction on actual PG17, uniquely generated disposable database/roles, one owner transaction ending in unconditional ROLLBACK:

```sql
GRANT SELECT ON public."PowerOfficeSnapshot" TO <disposable_runtime> WITH GRANT OPTION;
```

On the same transaction, `has_table_privilege(runtime, 'public."PowerOfficeSnapshot"', 'SELECT WITH GRANT OPTION')` is true. Evaluate the production `RUNTIME_ROLE_CHECK_SQL` with `SET LOCAL SESSION AUTHORIZATION` to that runtime, asserting both `session_user` and `current_user` equal it. Result: `poRuntimeGrantViolations = 0`, `sessionRoleMismatch = false`, and `assertConfinedRuntimeRole` accepts. The runtime now has delegation authority beyond the approved SELECT/INSERT/mutable-UPDATE contract. This finding is a missing fail-closed tamper check, not a claim that the normal provisioning script grants those options or that a grant itself disables RLS.

I completed the finite adjacent matrix requested by the orchestrator, all rollback-only:

| Path | Result |
|---|---|
| Table SELECT and INSERT WITH GRANT OPTION, each of State/Attempt/Snapshot (6 combinations) | Undetected; full startup accepts |
| Column SELECT and INSERT WITH GRANT OPTION, all 43 columns across the three tables (86 column capabilities) | Undetected; full startup accepts |
| Column UPDATE WITH GRANT OPTION on the 12 approved State operational columns and 3 approved Attempt terminal columns (15 capabilities) | Undetected; full startup accepts |
| All other PG17 table privileges on each table, including broad UPDATE, REFERENCES, TRIGGER, DELETE, TRUNCATE and MAINTAIN (18 controls) | Already rejected |
| Column REFERENCES across each table; UPDATE of every immutable column, including every Snapshot column | Already rejected |

The 38 grouped cases cover all eight PG17 table privilege names on all three tables, eleven column-privilege groups, and three immutable-UPDATE groups. State's affected UPDATE list is `nextSequence, activeAttemptId, snapshotId, snapshotVersion, lastAttemptId, lastAttemptState, lastAttemptErrorCode, lastCompletedAttemptId, lastCompletedState, lastCompletedErrorCode, lastSuccessAt, updatedAt`; Attempt's is `state, completedAt, safeErrorCode`. Snapshot has no approved UPDATE column.

**Required correction:** make runtime readiness reject every table/column grant option on these three PowerOffice tables, including options on otherwise allowed privileges. Cover the full startup assertion and the shared per-admission facts. Add focused positive/negative PG regressions for the table and column paths, preserving the legitimate grants and existing forbidden-privilege checks. Exercise actual production provisioning under the safe rollback envelope, verifying recovery to exact grants. No broader Stage2/3 role redesign or new role allowances are needed.

**Provisioning qualification:** the real production provisioning body, under SAVEPOINT inside each probe's outer rollback transaction, successfully removed every tested column grant option (including approved UPDATE columns); the normal privileges and healthy readiness returned. There is no demonstrated provisioning-repair defect to add to R1.

Probe files: `/tmp/atlas-stage4/astra-rc4-runtime-grantoption.mjs` and `astra-rc4-runtime-grantoption-complete.mjs`; corresponding `.log` files contain bounded capability results only. The initial three observations and the 38-case matrix are independent probes, not additional repository test counts.

## Independent verification and reviewed behavior

Executed independently, all exit 0:

- `/tmp/atlas-stage3/claude-tools/pgenv.sh node --experimental-strip-types --test --test-concurrency=1 tests/pg/poweroffice-*.pg.test.ts`: **69/69 passed**, zero failed/skipped, approximately 58.34 seconds. Log `/tmp/atlas-stage4/astra-rc4-pg.log`.
- `node --experimental-strip-types --test tests/poweroffice-*.test.ts tests/m365-database.test.ts`: **23/23 passed**, zero failed/skipped, approximately 5.92 seconds. Log `/tmp/atlas-stage4/astra-rc4-unit.log`.

Total independent repository tests: **92 passed**. I did not rerun generators, builds or the full required suite. In addition to R1 probes, a small pure-validator check rejected trailing LF/CR/U+2028/U+2029 on canonical money/date/UUID values; it yielded no finding.

Code and independent tests substantiate these current S4-A obligations:

- Strict detached/frozen normalized DTOs, exact canonical BigInt arithmetic, separated credit/invoice magnitudes, Oslo date calculation, complete page/export bounds, poisoning after failure, and permanently failed disposal of an incomplete export. Shared adversarial aggregate cases agree between TS and SQL.
- Scoped compound FKs, strict null truth, one ACTIVE claim, immutable history, allocation ownership, latest/last-completed metadata, bidirectional ACTIVE/pointer discoverability and deferred commit constraints. Actual unrounded DB time is checked for new publication/FAILED closure at statements and deferred completion; late closure rolls back, while identical terminal no-op remains possible. Service-level receipt authorization remains S4-B.
- Purging clears the pointer while preserving `lastSuccessAt`; a non-null pointer requires matching publication time. The cleanup foundation enforces exact scope/settings, validated paired binding, fence then State lock order, ACTIVE BUSY, bounded indexed candidates, combined 1000 deletions, retention/reference guards and atomic audit rollback. No secretRef grant is added to its definer.
- Maintenance roles include MAINTAIN in every PG17 table privilege scan, cover user relations/columns/sequences/routines in all schemas and temporary namespaces, schema CREATE, explicit grants/grant options/ownership, initially restricted built-ins, large objects, FDW/server/mappings, defaults, parameters and shared-object dependencies. Restrictive three-ID policies intersect the ordinary scope policy. The shared invoker list and original two fence policies are preserved.
- Readiness enumerates every `pg_tablespace` row through fixed SQL formatted only with numeric catalog role OIDs when the catalog is readable; provisioning enumerates directly. Unreadable real PostgreSQL fails closed. The Emscripten branch is a narrow compatibility exception for the pinned in-memory PGlite engine, checking its two built-in tablespaces; it supplies no real-PG shortcut. The PGlite suite exercised the compatibility path; real PG17 tests independently exercised the general catalog path and rollback-only non-default `pg_global` ACL drift. I accept this compatibility choice for the stated test-only environment, not as support for arbitrary/custom tablespace-capable Emscripten distributions.
- Authority uses the private bearer credential, shared current-token lookup, fence/readiness, one-membership all-of permissions, denial audit, proper client scope, and the final DB-clock/token/actor recheck after operation locks. Direct comparison with the accepted S3-C archive shows the token/settings extraction preserves its function body; generic PowerOffice connection/credential refusals occur before secret resolution, with bindable systems unchanged.
- Non-superuser owner behavior and a populated accepted-20-migration upgrade pass independently. The reviewed changes to old tests/support add the two roles and explicit later migrations without weakening accepted behavior.

## Implementer evidence and limitations

Inspected RC4 evidence and the corresponding final logs: **196/196 unit/PGlite and 470/470 PG**, all eleven required commands recorded exit 0 (tests, schema validation, generation, typecheck, API build/smoke, PG17 and drift checks, tracked/untracked whitespace). Each of those log files equals its durable `~/.codex/atlas-evidence/stage4/S4A_RC4/required-final` copy. These are implementer executions, distinct from the 92 independent tests above.

The execution receipts record native Anthropic actual message model `claude-opus-5-5`, high effort, session `8e56f05b-1dbf-4fc4-b4da-a526b2fbeb5d`, 445 seconds for the last repair, subscription route with no fallback/usage credits. I inspected the receipts, not the private raw inference stream or authentication files; this review does not independently re-attest those private provider observations. Attributable subscription quota is unknown; API estimates/cache statistics are not quota evidence.

All reviewer PG work used own disposable databases and generated roles. Shared/built-in ACL probes were inspected and executed only within guaranteed rollback envelopes; a separate observer checks invisibility. No host/file/network built-in, vendor API, real credential row, real tablespace storage operation, persistent database or account operation was used. The previously reported pre-RC3 committed PUBLIC parameter-ACL diagnostic is a historical unsafe action that was reported restored; I do not relabel it safe or use it as final safe-test evidence. Current rollback tests independently confirm no parameter ACL rows remain after their probes.

No additional required finding was established. Future sync/publication/recovery services, dedicated API/CLI, maintenance admission/runner pairing and whole-transaction timeout wrapper remain outside S4-A. No LIVE or production readiness follows from this review. **Resolve R1 on a new exact artifact and obtain independent acceptance before dependent checkpoint work.**
