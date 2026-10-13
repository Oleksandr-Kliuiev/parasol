# S4-A RC5 independent implementation acceptance

**ACCEPTED — S4-A MOCK foundation only.** No required findings remain in the reviewed artifact. This accepts the DTO/aggregation, schema/guards, exact roles/readiness, bounded SQL cleanup foundation, private transaction-authority foundation and approved compatibility integration. S4-B/S4-C service acceptance and LIVE are not included.

Review date: 2026-10-09. Reviewer: fresh native Codex subagent `/root/astra_s4a_rc5`, explicitly assigned **gpt-6-astra / xhigh**, with fresh context and no subagents. Effective review effort remained xhigh. The initial assessment used the approved contracts and actual implementation, without opening previous S4-A assessment reports. Repository access was read-only; reviewer outputs and scratch files are under `/tmp/atlas-stage4/`. No generators/builds/source/status changes were run by this reviewer.

## Exact accepted identity

Repository: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`.
HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365`, **plus the inventoried dirty files**. HEAD diff is not the checkpoint delta.

| Artifact | SHA-256 / identity |
|---|---|
| `verification/stage4/S4A_RC5_MANIFEST.json` | `36bc34fae3c2fe78ea22b0334b66c05dc7ca52e6efe6cbfbe0c6c2fad1e60209` |
| Source package, 731 entries | `7efcdf162c9912655de0f812dbbb13cef83d6adb1564111525c737c025021bd9` |
| Working inventory, 771 entries | `0e89c3f607aa17f0d8c3ea213740de6aa99bd3e5f6f028946673273d00ee0418` |
| `verification/stage4/S4A_RC5_PACKAGE.zip` | `bf56140a7d88d10ca9a5c1c12dc60a41eacbbd253259f9b199640594caa84bc7` |
| Approved eight-file design | `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec` |
| `docs/stage4/IMPLEMENTATION_HANDOFF.md` | `9f199dbb27d255f60db9f926e788cc23b5cba83722d5c0aff780a913f18b94ab` |
| `verification/stage4/S4A_BASELINE.json` | `6888685478c236dd7fff0779caf3090c24fe151ea829d05621574b739d4e1d95` |
| `verification/stage4/S4A_RC5_REPAIR_BASELINE.json` | `f79444e23b8731c4ba543ea616a3fb0897683d88f0726684607ad6e21e22bfca` |
| `verification/stage4/S4A_RC5_IMPLEMENTATION_EVIDENCE.json` | `1816f39ed62422945096094351d6e708479260fb6deffc0cc47f14330f2d8712` |

I recomputed file hashes, sorted aggregate hashes, ZIP hashes and all archive member contents before and after review. Both measurements match exactly: zero changed/missing inventoried files, zero extra/mismatched archive entries. The Git path inventory contains precisely those 771 entries plus the RC5 manifest and ZIP. The 672-file S4-A baseline has only its declared 30 changes and no missing files. The original 20 migrations plus migration lock, earlier normative documents, 11 fixture files and prior review/evidence/ZIP/seal history remain preserved. All eight approved Stage 4 normative files match the design manifest. The last repair baseline has one changed source file, `packages/graph/poweroffice-role.ts`, plus the added grant-option test; administrative changes are distinct. All 68 changed/added active code/test/schema/SQL files examined remain below 500 lines; the largest is `prisma/roles.sql`, 474 lines.

## Actual-code assessment

- **A1:** `packages/poweroffice/{contracts,money,calendar,dto,export,aggregate,audit,binding}.ts` implements detached frozen whitelist DTOs, exact BigInt minor units, separate invoice/credit magnitudes and currencies, Oslo claim-fixed dates, complete-export identity/count/order/duplicate bounds, and terminal disposal. TS and SQL agree on the tested adversarial aggregate corpus. Audit metadata is confined to six operational keys; generic financial/context exposure was not added.
- **A2:** `prisma/poweroffice.prisma` and the three pending `2026100912xx` migrations provide scoped compound FKs, explicit NULL truth, one ACTIVE attempt, allocated snapshot ownership, immutable identity/history, sequence/latest/completed coherence, FORCE RLS and invoker deferred constraint triggers. Statement and deferred-completion deadline checks use the actual unrounded DB clock for original 80-second claim expiry; backdated supplied times do not bypass them. Identical terminal no-op updates remain possible. Pointer clearing preserves `lastSuccessAt`; a non-null pointer must match the published snapshot and its success.
- **A3 runtime:** `packages/graph/poweroffice-role.ts` checks ordinary forbidden privileges and effective **WITH GRANT OPTION for all eight PG17 table privileges and all four column privileges on every column** of the three tables. Approved SELECT/INSERT and the 15 mutable UPDATE columns remain usable without delegation rights. Startup and per-admission facts reject excess rights. Production provisioning restores the approved rights; it does not add new runtime grants.
- **A3 maintenance:** `poweroffice-surface.ts`, `poweroffice-role.ts` and `prisma/roles.sql` check the two roles' user and built-in relations/columns, sequences, routines including temporary schemas, ownership, grant options, schema authority, initial PUBLIC built-in ACL baseline, large objects, FDW/server/mapping/default ACLs, shared parameters and tablespaces. Membership and PUBLIC paths are included. Ordinary initial SQL/catalog privileges remain compatible. Forbidden authority is revoked where the owner can revoke it or causes atomic provisioning refusal. No broader Stage 2/3 privilege redesign was required or accepted.
- **Tablespaces:** real PostgreSQL readiness dynamically enumerates every catalog row through fixed numeric OIDs; it is not restricted to the default tablespace. The independent unreadable-catalog probe produced readiness violations rather than a permissive fallback. The Emscripten exception is limited to the pinned in-memory PGlite test engine and checks its two initial tablespaces; it is not a real-server fallback. No storage-backed tablespace operation was performed.
- **SQL cleanup foundation:** the actual confined routine validates argument/GUC scope and the installed, validated, exact paired-binding CHECK before relying on the synthetic binding without a secret-reference SELECT grant. Restrictive three-ID policies intersect the ordinary scope policy. Fence → plain Connection read → State locking, ACTIVE BUSY, bounded indexed candidates, combined 1000-row budget, retention/reference guards, atomic pointer/audit/deletes and scoped `morePending` are implemented and exercised under real grants, including a non-superuser migration owner.
- **A4/R1/R2:** private bearer capability and current-token lookup, one-membership all-of authorization, workspace denial audit, scope-before-data and final token/actor/permission checks after operation locks are present. I compared the token helpers against the accepted S3-C archive: extraction is verbatim apart from exporting `currentToken`; shared auth authority and `fence-role.ts` are byte-identical. Generic PowerOffice resolution/activation/credential routes refuse before secret resolution. Populated old-20-migration upgrade, pre-provisioning Stage 3 fence behavior, repeated provisioning and no automatic membership expansion passed.

No required finding or code repair is requested. These conclusions concern actual foundation behavior, not the implementer's self-assessment or the deferred public workflows.

## Independent verification

All commands used current frozen RC5 source. PostgreSQL commands used the existing silent `/tmp/atlas-stage3/claude-tools/pgenv.sh` wrapper, without reading its contents or printing environment/URLs. Databases and roles were unique disposable fixtures; PostgreSQL reported **17.11 (Debian 17.11-1.pgdg13+2)**.

| Reviewer command/check | Result |
|---|---|
| `node --experimental-strip-types --test tests/poweroffice-*.test.ts tests/m365-database.test.ts` | 23/23 pass, no skips; 6.39 s |
| Wrapper + `node --experimental-strip-types --test --test-concurrency=1 tests/pg/poweroffice-*.pg.test.ts` | 74/74 pass, no skips; 60.93 s |
| Wrapper + serial `action-requests`, `action-guard`, `action-replay` PG files | 19/19 pass, no skips; 35.20 s |
| Independent `/tmp/atlas-stage4/astra-rc5-probe.ts` | 24/24 table × privilege grant-option drift/restore cases pass; real-PG unreadable tablespace-catalog refusal and observer/rollback preservation pass |
| `git diff --check`; identity/archive/baseline checks | pass |

**Independent total: 116 tests**, plus the additional bounded probes. The 74 focused PG tests include the internal matrix of 6 table SELECT/INSERT options, 86 column SELECT/INSERT options and 15 approved mutable UPDATE options, positive ordinary grants, forbidden adjacent privileges, actual production provisioning and separate-observer isolation. Internal loop cases are not inflated into the test count.

Reviewer logs and SHA-256:

- `/tmp/atlas-stage4/astra-rc5-unit.log`: `295b06016cb81868c68ad0a5130581b9e7bba0dd66a79c4c54d0ac967a6cfffe`
- `/tmp/atlas-stage4/astra-rc5-pg.log`: `aff47c3d0603b9f99df72445e8fee03d22e96948a16fe44401113f9ab711ca9d`
- `/tmp/atlas-stage4/astra-rc5-regression.log`: `09758d74ece31fa53e4e6f633bedd9a80f27b83f6bb5d34e6f63e8a546529aab`
- `/tmp/atlas-stage4/astra-rc5-probe.log`: `7de47bf8e51ccae247ca64b3efdc6951404d7cbc30c2dcc68047f43dab56966b`

Before/after identity records: `/tmp/atlas-stage4/astra-rc5-identity-before.json` and `astra-rc5-identity-after.json`.

Separately, I inspected the packaged implementation evidence and bounded final-log summaries: **196 unit/PGlite + 475 PostgreSQL tests**, all 11 required commands recorded exit 0. Those full-suite/build/generation runs are implementer/orchestrator evidence, not my independent runs. The packaged native execution records report actual message model `claude-opus-5-5`, high effort, session `8e56f05b-1dbf-4fc4-b4da-a526b2fbeb5d`, native first-party subscription routing. I did not inspect private authentication/session files or raw provider streams; provider/billing observations remain attributed to the orchestrator, with no inferred subscription-quota savings.

## Evidence qualifications and remaining scope

The blanket phrase “all phase grants rolled back / no PUBLIC grants committed” is **too broad for the complete rerun suite**. It is accurate for the new grant-option probes and for built-in/shared/global/host-capable ACL tampering, which uses guaranteed outer rollback, same-connection confined identities and observer checks. Existing disposable-database tests also commit temporary **database-local synthetic** ACL arrangements, including PUBLIC access to the one-byte large-object fixture and the NO HANDLER FDW/server metadata fixture, and then repair/drop them in cleanup. Other local surface tests similarly use synthetic relations/routines. These are not shared parameter grants or host-access exposure. This distinction qualifies the frozen RC5 notes and must accompany acceptance evidence; the notes should not be represented as a universal no-commit claim.

The earlier pre-RC3 committed PUBLIC parameter-drift diagnostic was reported restored. This review does not retroactively declare that diagnostic safe. Current relevant tests verified rollback isolation and an empty parameter-ACL baseline after execution. No real credential rows, vendor/account/pilot/persistent data, host files, network/OS built-ins or real tablespace storage were accessed by these probes.

S4-B source/session/sync/publication/failure/recovery services remain NOT_STARTED. S4-C dedicated API/CLI, read-success auditing and response precedence, maintain admission, runner/database pairing, original whole-transaction 10-second deadline and 1-second lock-timeout wrapper remain NOT_STARTED. Their future end-to-end, cancellation, deadlock-victim and privacy cases remain gates. The SQL cleanup function alone does not establish the complete maintenance workflow. LIVE remains DEFERRED_BY_OWNER; there is no vendor accounting/completeness, deployment or production acceptance.

Acceptance is bound to the exact RC5 identity above. Dependent work must begin from that artifact; later affected source changes require renewed review.
