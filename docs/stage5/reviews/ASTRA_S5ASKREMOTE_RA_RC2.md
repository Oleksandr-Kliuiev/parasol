# Independent R-A RC2 acceptance

**APPROVE — S5ASKREMOTE-RA-rc2, offline R-A only. Required findings: none.**

Fresh native reviewer explicitly assigned `gpt-6-astra` / `xhigh`, with no initial prior-review verdict and no additional agents or model/provider calls. This records the native assignment; raw provider-response telemetry and attributable reviewer token/quota usage are unavailable. No historical RC1 acceptance report was used as acceptance evidence. Original checkout remained read-only.

## Accepted identity and scope

- Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`.
- Package: `1b6ff0b80b1bfcb68c82be4064aa7c909623769c03261bde9e9d87869df7556d`.
- Manifest: `verification/stage5/S5ASKREMOTE_RA_RC2_MANIFEST.json`, SHA-256 `c34320baa762814a82dbacaa23068c5ff5b57a35219c2bde96f6113f1ddb760b`.
- Source ZIP: SHA-256 `e1f406835d3edf3af5fcc0c2d23724663d0f50deffbbdf966dd54ab1965b7823`; all 1,179 entries match the manifest exactly.
- Built inventory: `cd0f8a081398188c7872f6815fcf202f758587799568f97503b88e2ef4c066c0`; all 228 files match, and all 228 independently reproduce from the sealed copy.
- Repair baseline: `37e80c3365358b85062dec3e0a319c1f0156a073930ed0cfc123ade5e0a0c870`; scope review: `7c8eaf20d05ce51ab728a12e71507b86c0e983b45eb25e643710792d847e8568`; implementation evidence: `87bd2751dc6cf92aab89a9094f93183b24a593bb92bfc689b0c942096763f8d1`.

Recomputed package/inventory hashes, the archive bytes, all eight dependency pins, 59 archive exclusions, both baseline deltas, and all 88 durable implementation-proof hashes/sizes. Reviewed all 13 cumulative existing-file deltas and 11 RC2 existing-file deltas, plus new R-A source/schema/migrations/tests. BEFORE bytes match the original implementation baseline and repair baseline. The remaining additions are declared source/tests and preserved administrative/review evidence. No unexplained scope change or old assertion weakening was found. All accepted migrations, ten remote norms, old fence source/routine/policies and operator sources remain preserved. Cumulative compiled delta is the shared runtime readiness module plus four new R-A modules; operator output is unchanged.

## Independent assessment

1. **Caps and immutable policy history.** Revision rejects either cap above its current value before fence/version mutation, regardless of approval text, expiry renewal or reactivation. The guard independently rejects increases. Own probes verify atomic unchanged policy/fence/ledger snapshots for refusals, accepted lowering, and refusal below existing spend without rewriting history. Existing PG tests also cover singleton identity, scoped links, no-op/material changes, allowlist and revocation revisions, stale consent despite fresh epoch, and terminal max-bigint tombstones.
2. **Effective confinement.** The new scanner anchors relation privileges to `public`, evaluates effective cross-schema capabilities and column grant options, and detects PUBLIC grants, schema ownership/CREATE, sequences and non-allowlisted routines. Own negative probes cover PUBLIC column grants on a same-named foreign-schema table, foreign table INSERT, fence/attempt column grant options, PUBLIC schema CREATE, schema ownership and sequence usage. Every restoration passes remote, old-fence and full runtime readiness. The focused suite also verifies direct runtime DML denial, default regrant/reprovisioning, routine ACLs, membership, protected-table registration and table/trigger/FK drift. No new privilege for the old fence definer is required.
3. **Expiry atomicity.** Own tests observe a real PostgreSQL Lock wait on MONTH and separately DAY, wait until the DB clock exceeds expiry, release the blocker, and obtain AR001 with byte-equal ledger state. A separate test-only AFTER DAY-update delay exercises the immediate-pre-return check: expiry rolls back the attempt and both newly inserted counters. This is an injected database timing seam, not R-B deadline or network proof.
4. **Time and money.** Own invalid-time matrix covers NaN, infinities, fractional/out-of-range values, invalid creation/now/expiry, reversed time and exact 10-second edges near both Date-range ends. Full-range chronological verified usage remains exact. Fixed 300000 reserve, integer 275/825 ceil settlement, exactly-once/refund/scoped identity checks, original UTC periods, absent-counter races, last day/month dollar races and conservative unknown liabilities pass the actual PG suite.
5. **Nonsuperuser populated upgrade.** Independently migrated a populated accepted 23-migration baseline as a real NOSUPERUSER/NOBYPASSRLS owner, then provisioned twice. Old membership data, fence versions, old routine owners/ACLs and both fence policies stay equal; no ask:remote permission or policy is auto-granted. FORCE RLS, direct-owner DML refusal and runtime reserve/settle work after upgrade.
6. **NO_DISPATCH boundary.** Independently confirmed that a fresh connection inside the window can settle 0. This is an intentionally documented SQL limitation, not a security proof: SQL trusts the runtime outcome and proves neither absent dispatch nor process continuity. R-B must implement private non-reconstructible in-process dispatch/refund ownership; persisted IDs, reconnects or elapsed time cannot supply it. No partial R-B protocol was added.

## Verification and evidence

Independent executions in the sealed scratch copy:

- `npm ci --ignore-scripts --offline`; explicit `npm run db:generate`, `npm run api:build`, `npm run typecheck`: passed. No network dependency update.
- `npm test`: **368/368**, no skipped/cancelled tests, after correcting scratch setup described below.
- `node --experimental-strip-types --test --test-concurrency=1 tests/pg/ask-remote-*.pg.test.ts`: **35/35** on PostgreSQL 17.11, including actual multiprocess races and nonsuperuser provisioning.
- `review/independent.ts`: **143/143 assertions**, including isolated catalog tampering, atomic expiry/cap probes, exact time edges and reconnect limitation.
- `review/nonsuper-upgrade.ts`: **14/14 checks**, real populated nonsuperuser upgrade and repeated provisioning.
- Independent rebuilt inventory: **228/228 byte-equal**. `npm prune --omit=dev --ignore-scripts --offline`, then foreign-cwd OFF/MOCK startup/authority/asset smoke: both pass; **41/41 served assets per mode** match hashes. Processes terminated and awaited.

Verified, rather than reran, the implementer's full fourteen-check evidence: all commands exit 0; **368 unit/PGlite, 651 PG17, 73 browser**. It also binds clean production staging, DB OFF/MOCK startup, browser smoke, dev prune and foreign-cwd assets. Active-file context-budget test passes. The raw native implementation stream independently contains 101 assistant message records labelled `claude-opus-5-5`, in the same pinned session. No subscription saving is inferred from cache or API-dollar estimates.

RC2 mutation qualification is **11/12 killed**. N05 survives because it removes only the effective-column grant-option term while the direct-ACL term still catches that grant. N12 removes both and is killed. The two expiry checks are redundant for the blocked-counter scenario; the own immediate-pre-return delay separately exercises the late check. RC1's 18 mutation proofs are historical, not new RC2 proof.

Preserved reviewer failures are in `FAILURES.md`: the archive initially lacked Git metadata, causing the established protected-output test to create a one-byte fixture; after Git initialization that residual fixture caused its expected-absent assertion to fail. The fixture was moved to an evidence file and the focused test plus full unit suite passed without source/assertion changes. A separate runner log-name edit accidentally requested a nonexistent npm script; its log and runner are preserved. No product defect is inferred from those setup errors. Pruning normalized two root version metadata fields in the scratch lockfile only; `scratch-prune-lock.diff` preserves this, dependency entries were unchanged, and sealed bytes were restored.

## Nonblocking note

`packages/ask/remote/budget.ts:59–63`: `utcPeriods` slices fixed ISO positions, so a valid expanded-year Date such as `+275760-09-13` returns malformed keys (`+275760-09`, `+275760-01`). It has no production caller, and current admitted DB-clock periods cannot reach this case. This does not affect R-A acceptance or the corrected admission/settlement time guards. Before using it for arbitrary historical/future dates, explicitly constrain supported years or derive keys without fixed four-digit-year offsets. Observation is preserved in `independent-probes.json`.

## Residuals and ownership

R-A acceptance establishes offline policy/accounting/confinement building blocks. It does not establish bearer/permission composition at egress, R-B timing/floor/drain behavior, genuine provider usage or no-dispatch proof, live HTTP/model quality, or provider-invoice enforcement. Unknown commits remain conservative liabilities. Shared workspace-fence contention and post-admission revocation limits remain documented.

All reviewer processes finished. Own before/after database and role metadata match; the four unknown-owned databases `atlas_it_1218b258`, `atlas_it_41e76548`, `atlas_it_4465c2fc`, `atlas_it_f517f626` were untouched. Final verification finds **1,239 original working files and 228 compiled files unchanged**, with no extra/missing source paths. Scratch-only evidence remains under the assigned directory.

Stop at R-A. R-B/R-C are not started; paid data/budget admission, R-EVAL, real tenant use, LIVE and deployment remain outside this approval.
