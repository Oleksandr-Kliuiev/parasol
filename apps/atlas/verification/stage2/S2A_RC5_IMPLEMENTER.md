Implementation handoff — NOT independent acceptance.

The two aggregate byte caps are raised so that every DTO the parsers can produce now fits. Directory goes from 2048 to **4096**, sign-in from 1024 to **2048**. The new tests store the largest real parser outputs and pass on PGlite and PostgreSQL. No field limit, DTO shape, key list, lifecycle check or grant changed.

**Byte bounds.** The cap measures `octet_length(dto::text)`, the jsonb text form. In that form non-ASCII characters are written as raw UTF-8, and only `"`, `\` and control characters are escaped. The worst cases:

| DTO | Field worst case | Largest output | Old cap | New cap |
|---|---|---|---|---|
| Directory user | `safeText` turns controls into spaces, so at most 4 bytes per code point (an escaped `"`/`\` is only 2). displayName 256×4 + UPN 320×4 | 2442 bytes | 2048 | 4096 |
| Directory device | displayName 256×4 + operatingSystem 128×4 | 1701 bytes | 2048 | 4096 |
| Sign-in | id: 256 UTF-16 units, no controls or lone surrogates, so at most 3 bytes per unit; plus three GUIDs, 7-digit fraction time, errorCode 9007199254740991 | 1035 bytes | 1024 | 2048 |

The test asserts these exact sizes from the database itself: 2442, 1701, 1035, and 779 for a sign-in id made entirely of escaped `"\` characters.

**Tests added.** One shared check runs on both PGlite and PostgreSQL (`tests/m365-dto-storage-invariants.ts`):
- **Stored and read back unchanged:** the maximum user, device and sign-in DTOs produced by the real parsers, including the escaped id and an all-null user.
- **Still rejected, field limits:** displayName of 257, UPN of 321, operatingSystem of 129, sign-in id of 257, and an extra field.
- **Still rejected, cap binding:** an oversized createdDateTime and an oversized numeric errorCode — the fields the SQL check bounds only through the cap.

A second PostgreSQL test (`tests/pg/m365-dto-storage.pg.test.ts`) stores the same maximum DTOs as the runtime role through Prisma, with production grants.

**Checks.** Typecheck 0 errors; `npm test` 108/108; full `test:pg` 176/176; `db:check:pg17` and `db:check:drift` pass; `git diff --check` clean. The Stage 1 review hash and RC5 hash are unchanged, no historical migration changed, and no test roles or databases were left behind.

**Changed files**
- `prisma/migrations/202610081000_stage2_m365_directory/migration.sql` — cap 4096, with the arithmetic in a comment
- `prisma/migrations/202610081100_stage2_m365_signin_windows/migration.sql` — cap 2048, with the arithmetic in a comment
- `tests/m365-dto-storage-invariants.ts` (new)
- `tests/pg/m365-dto-storage.pg.test.ts` (new)
- `tests/m365-database.test.ts`
- `docs/AI_CONTEXT_MAP.md`

**Residual risks**
- The bounds assume PostgreSQL's current jsonb text formatting. The test asserts the exact sizes, so a formatting change in a future PostgreSQL version would show up as a test failure.
- Directory DTOs written directly to the table, bypassing the parser, could carry escaped control characters. They are still bounded by the per-field limits and cannot exceed 4096 bytes.
