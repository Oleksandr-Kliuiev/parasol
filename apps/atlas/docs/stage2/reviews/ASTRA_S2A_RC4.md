# Astra S2-A-rc4 independent acceptance review

**Verdict: REQUEST_CHANGES.** One P2 DTO/storage contract inconsistency remains. No implementation changes were made.

Reviewed 2026-10-08 using explicit native runtime binding **gpt-6-astra / xhigh**, fresh independent context. Separate upstream response-model metadata is not exposed by this native runtime; no fallback or model switch was observed. This report does not use an implementer's conclusion as acceptance.

Scope: tasks 2.1–2.3, A1–A5/A3a/A4a/R1/R2, and the persisted publication/cleanup/grant foundations included in this checkpoint. Excludes S2-B Graph adapters, workers and token cache; S2-C endpoint/query behavior; full C5; live tenant or production approval. Methods were ordinary source/contract inspection, artifact verification, and existing named regression tests on disposable synthetic databases. No exploratory/adversarial queries or new test probes were constructed or run. No platform restriction occurred during this bounded session.

## Required finding

**[P2] Make SQL DTO byte caps cover the approved validator output.**

- `prisma/migrations/202610081000_stage2_m365_directory/migration.sql:198` caps `octet_length(dto::text)` at 2048 bytes.
- `connectors/microsoft365/directory-dto.ts:47–48`, through `dto-common.ts:42–46` and `connectors/dto.ts:38–40`, accepts and preserves display name and UPN up to 256 and 320 Unicode code points respectively. Those are the field limits in `docs/stage2/02_CONTRACTS.md:54–56`; the normative contract does not declare a narrower aggregate byte limit.
- The two accepted string fields alone can occupy `(256 + 320) × 4 = 2304` UTF-8 bytes, before the required ID, field names and JSON syntax. Thus a DTO accepted by the current parser and individual SQL character constraints is rejected when stored. This is a deterministic source-derived contract counterexample, not a newly executed database reproduction. The relevant existing text-limit test uses ASCII and does not round-trip maximum Unicode output into the SQL predicate.
- The analogous sign-in predicate at `prisma/migrations/202610081100_stage2_m365_signin_windows/migration.sql:263` has a 1024-byte aggregate cap, while `signin-dto.ts:36–38` / `dto-common.ts:37–39` admit a 256-character BMP opaque ID plus all optional GUIDs, a strict UTC string and a safe integer status. Their permitted aggregate can also exceed the SQL byte limit. Review both caps together.

Required resolution: derive SQL aggregate caps from the full approved DTO domain, including UTF-8 encoding and JSON serialization overhead/escaping, and add ordinary parser-to-storage regression coverage for valid boundary values. Preserve the exact allowlist and existing character limits. Silently imposing a smaller parser limit would narrow the approved contract. Re-review the changed artifact and affected checks before advancing dependent work.

## Inspection and verification

Inspected the current normative scope, four new M365 migrations, DTO modules/correlation types, production role provisioning/startup guard, mapping permission/freshness paths, local disable/current-authority transaction, legacy context/tool projections, and corresponding permanent tests. Lifecycle insertion checks explicitly reject invalid initial states and missing/nonvisible prerequisites; the ExternalEntity system check is AFTER ROW. Publication transitions have deferred pointer constraints and current-lifecycle/newest-attempt fences. The existing tests exercised these properties successfully; the finding above is separate from those passed checks.

Independently executed these three commands from the checkout, each exit 0, with no cancelled/skipped tests:

```text
node --env-file=.env --experimental-strip-types --test tests/pg/m365-prerequisites.pg.test.ts tests/pg/m365-publication-atomic.pg.test.ts tests/pg/m365-race-directory.pg.test.ts tests/pg/m365-race-signin.pg.test.ts tests/pg/m365-schema.pg.test.ts
# 23/23 passed; 2829 ms

node --env-file=.env --experimental-strip-types --test tests/pg/m365-runtime-membership.pg.test.ts tests/pg/m365-privileges.pg.test.ts tests/pg/m365-routine-acl.pg.test.ts tests/pg/m365-nonsuper.pg.test.ts tests/pg/m365-scope.pg.test.ts tests/pg/m365-upgrade.pg.test.ts tests/pg/roles-output.pg.test.ts
# 25/25 passed; 3524 ms

node --env-file=.env --experimental-strip-types --test tests/pg/m365-permissions.pg.test.ts tests/pg/m365-disable.pg.test.ts tests/pg/m365-confirm-clock.pg.test.ts tests/pg/ops-cli.pg.test.ts tests/pg/lifecycle-race.pg.test.ts tests/pg/operator-passes.pg.test.ts tests/m365-dto.test.ts tests/m365-public-compat.test.ts tests/tool-permissions.test.ts tests/decision-config.test.ts tests/m365-database.test.ts
# 53/53 passed; 6033 ms
```

Total independently executed: **101/101 passing**. One pg client concurrent-query deprecation warning was emitted by the scope test; no failure resulted. I did not rerun builds, generation, the full suite, or drift. Verified all 11 raw-log SHA-256 values referenced by `verification/stage2/S2A_RC4_CHECKS.json`; every receipt records exit 0, including unit 107/107 and two PostgreSQL runs of 174/174. These are verified receipts, not tests newly performed by this reviewer.

All test processes finished and their teardown ran. A final read-only catalog check found **0** `atlas_it_<8-hex>` disposable databases and **0** matching `atlas_{app,def,run}_it_<8-hex>` roles. The catalog check was limited to cleanup counts; it was not an application-data probe. No credentials, connection URLs or environment values were printed.

## Frozen identity, before and after

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; branch `planning/stage2-m365`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`; intentional dirty implementation.
- S2-A-rc4: **211/211** listed source hashes matched before and after; aggregate `159cc5172851d2d6bb881cd3252f1a9b17fb71fb319b3e14a9ffcc99f47cd84d` matched both times, using sorted `<sha256>  <path>\n` entries.
- ZIP: all 211 payload members matched; its sole extra member is the identical RC4 manifest. Container SHA-256 `5cf480271251de50babfbee70c5ba0175514d37a0805a484b7f6a6ed671d18e5` matched at final verification.
- Normative RC5: **11/11** source hashes and aggregate `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb` matched before and after.
- Stage 1 REVIEW_REPORT SHA-256 remained `7e186cf1722540d75511b0599cb55cacc2f2df06e8490389dd2a93abffc9fc78`; no tracked historical migration differed from HEAD.

Residual limits: standard tests and ordinary inspection are not exhaustive; no new runtime reproduction was attempted for the required finding because the review was expressly bounded. Later checkpoint behavior and live/production gates remain unreviewed. No further obligatory finding was established before ending this bounded review after the material contract finding. The current artifact is not accepted.
