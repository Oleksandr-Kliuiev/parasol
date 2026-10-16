# Astra S2-A-rc5 bounded acceptance re-review

**Verdict: APPROVE for the exact S2-A-rc5 checkpoint scope below.** My RC4 P2 DTO/storage consistency finding is closed. No obligatory findings remain in the reviewed scope.

Date: 2026-10-08. Same native reviewer session, explicit **gpt-6-astra**, effective **xhigh** throughout; no effort downgrade, model switch or fallback. Separate upstream response-model metadata is not exposed by the native runtime. This bounded re-review continues my independent RC4 source/contract inspection and 101 passing selected tests; it does not substitute another reviewer's conclusion for acceptance.

Scope: tasks 2.1–2.3, A1–A5/A3a/A4a/R1/R2, plus the persisted publication/cleanup/grant foundations included in S2-A. Excludes S2-B adapters/workers/token cache, S2-C endpoint/query behavior, full C5, live tenant and production approval. Methods remained ordinary source/contract inspection, hash verification, existing named regression tests on disposable synthetic databases, and read-only catalog cleanup counts. No exploratory/adversarial probes were constructed or run; no platform restriction occurred. Checkout remained read-only.

## Delta and finding closure

I compared the actual RC5 payload hashes with RC4 and inspected the changed text against the RC4 ZIP. Exactly six paths changed, matching `deltaFromRC4`; none were removed:

- `docs/AI_CONTEXT_MAP.md`: test routing.
- `prisma/migrations/202610081000_stage2_m365_directory/migration.sql`: aggregate byte cap 2048 → 4096 and derivation comment.
- `prisma/migrations/202610081100_stage2_m365_signin_windows/migration.sql`: aggregate byte cap 1024 → 2048 and derivation comment.
- `tests/m365-database.test.ts`: wires the shared storage regression into PGlite.
- `tests/m365-dto-storage-invariants.ts`: new parser-to-storage boundary cases and rejection checks.
- `tests/pg/m365-dto-storage.pg.test.ts`: runs those invariants on PostgreSQL and stores/reads maximum DTOs through generated Prisma under production runtime grants.

The two cap constants are the entire executable production delta. No field validator, exact key set, nullable handling, identity constraint, authorization rule, grant, lifecycle, locking, atomicity or public contract changed. This is closure of the identified inconsistency within the approved contract, so the bounded re-review is appropriate.

Independently checked the upper-bound argument against the unchanged parsers and JSONB representation. Cleaned directory text contains no C0 controls; each retained Unicode code point takes at most four UTF-8 bytes, and quote/backslash escaping takes only two. Including all keys, separators, quotes, GUIDs, longest enum and boolean yields user **2442** bytes and device **1701**, both below 4096. The opaque sign-in ID is capped at 256 UTF-16 units with controls and lone surrogates rejected: at most three bytes per unit, since an astral character consumes two units for four bytes. Together with the maximum seven-digit fractional UTC string, three GUIDs, 16-digit nonnegative safe integer and false boolean, the full sign-in DTO is **1035** bytes, below 2048. Null optionals cannot increase these maxima. These bounds cover the permitted parser domain rather than only the sampled cases.

The existing new tests assert database-computed JSONB sizes **2442 / 1701 / 1035 / 779**, round-trip real parser output (including an escaped ID) unchanged, and reject over-limit fields, extra keys, and aggregate overflow in the otherwise SQL-length-unbounded timestamp/number fields. Adjacent unchanged shape tests still reject missing/null required fields and accept legitimate null optionals. The narrowed-cap defect is repaired without removing boundedness or narrowing the DTO contract.

## Independently executed checks

```text
node --env-file=.env --experimental-strip-types --test tests/m365-dto.test.ts tests/m365-database.test.ts tests/pg/m365-dto-storage.pg.test.ts tests/pg/m365-schema.pg.test.ts tests/pg/m365-prerequisites.pg.test.ts tests/pg/m365-publication-atomic.pg.test.ts
```

Exit **0**; **35/35 passed**, no failures/cancelled/skipped tests; 5853 ms. This covers the affected DTO/storage boundary plus exact shapes/nulls, prerequisites, generated Prisma/runtime behavior and nearby publication atomicity. It also reran the existing PGlite role/cleanup foundation cases in the selected database file. Builds, generation and full suites were not rerun by this reviewer.

Verified the package identity and all **11/11** raw-log SHA-256 values in `verification/stage2/S2A_RC5_CHECKS.json`. Every receipt records exit 0: schema validation, generation, typecheck, unit **108/108**, API build/smoke, PostgreSQL **176/176 twice**, PG17 check, zero drift and diff check. These are verified root execution receipts, distinct from my 35 newly executed tests and my RC4 101-test baseline.

All selected test processes exited and teardown completed. Final read-only catalog counts were **0** `atlas_it_<8-hex>` disposable databases and **0** associated `atlas_{app,def,run}_it_<8-hex>` roles. No credentials, connection URLs or environment values were printed.

## Identity confirmed before and after

- Checkout `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; branch `planning/stage2-m365`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`; intentional dirty implementation preserved.
- Candidate **S2-A-rc5**, **213/213** source hashes and sorted-path aggregate matched before and after: `0a038288cd529ac1692b67bb8ed06343d3d381d04539aa8ed308aa45c144f2d1`.
- Previous reviewed S2-A-rc4 aggregate: `159cc5172851d2d6bb881cd3252f1a9b17fb71fb319b3e14a9ffcc99f47cd84d`.
- RC5 ZIP: all 213 payload members matched; sole extra member is its identical manifest. Container SHA-256 unchanged: `60f6c8860670f909e8560296e999d0843d12737e60dd2c4a27aeab1f7a9c4795`.
- Normative architecture RC5 (distinct from this implementation candidate): **11/11** files and aggregate unchanged: `1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb`.
- Stage 1 REVIEW_REPORT SHA-256 unchanged: `7e186cf1722540d75511b0599cb55cacc2f2df06e8490389dd2a93abffc9fc78`; no tracked historical migration differs from HEAD.

Residual limits: acceptance is tied to this exact content and checkpoint, combining the prior independent review with this bounded closure check. Standard tests and inspection are not exhaustive. Later checkpoint behavior, live vendor integration and production deployment remain outside approval. Any subsequent affected-content change needs renewed review before dependent work advances.
