# Native Fable S2-C plan RC3 acceptance

Date 2026-10-08. Fresh explicit claude-fable-5-1/high; native Anthropic firstParty/claude.ai subscription. Actual assistant message.model: claude-fable-5-1 only; zero permission denials; no fallback/usage credits/API billing enabled. Read-only, external hash verification by Codex.

Review complete. No tool-visible output was shown to you during the checks, so here is the full result.

**Verdict: ACCEPTED** for `docs/stage2/reviews/S2C_IMPLEMENTATION_BRIEF_RC3.md` at the identity below. Hashes are as declared in the manifest and externally verified by Codex, not recomputed by me (no Bash was used).

| Item | Value |
|---|---|
| Brief SHA-256 | de3eea93865ef907872a4cf170a87993f629f4ff2ea006bf7fe4293073ad7f57 |
| Manifest | verification/stage2/S2C_PLAN_RC3_MANIFEST.json, version S2-C-plan-rc3 |
| Baseline | S2-B-rc4, d122f0ea4031ce3421c114c286d409b974d83449d8db6f3930b53884486eb841 |
| Normative RC5 | 1d3b1064c2633ed64ab2089a7ea62401e9415a72b16ba5a9dcd9a50c870a1efb |
| HEAD | 916a4d6, branch planning/stage2-m365 |

**Required corrections: none.** I found no contract decision that contradicts RC5 C1–C6 or the lettered cases, and none left open for the implementer. Evidence for the load-bearing claims:

- **Seven-digit time key** is coherent with stored data. The DTO keeps the source fraction with at least three digits and trailing zeros stripped (`connectors/microsoft365/dto-common.ts:53-70`), and occurredAt is truncated to the millisecond (`packages/m365/signin-rows.ts:16-18,37`). Zero-padding the DTO text to seven digits and widening the millisecond prefilter is therefore exact.
- **Conflict predicate** matches the schema. A superseded attempt keeps publishedAt, and publishedAt non-null implies COMPLETE or SUPERSEDED (`prisma/migrations/202610081100_stage2_m365_signin_windows/migration.sql:238-241`); the lifecycle trigger also allows RUNNING to SUPERSEDED with null publishedAt, which the brief correctly excludes from visible conflicts, consistent with 03 §5.
- **Additive reason codes**: exactly six existing codes in `packages/correlation/contracts.ts:16-18`; the ten new ones are additive and the items comment clarification is consistent with 02 §5.
- **Composed registry**: `decideToolCall`, `toolsAvailableTo` and `executeTool` all default to stage1Tools today (`packages/policy/tool-policy.ts:20,34`, `packages/tools/gateway.ts:42`), and both API paths use the defaults (`apps/api/src/atlas.module.ts:63`, `apps/api/src/db/tools.ts:27`). The brief's injection requirement is exactly what 02 §5 demands. The 2048-char body cap exists at `apps/api/src/http-boundary.ts:65`.
- **Cleanup binding**: the routine takes only a correlation ID and derives scope from exactly one client plus actor context (`...cleanup_routine/migration.sql:16-35`); roles.sql provisions a distinct EXECUTE-only runner (`prisma/roles.sql:115-139`); the harness already issues a same-target runner URL (`tests/support/pg-harness.ts:111`). Prisma 6.19 `datasourceUrl` supports the runner client without a pg dependency. The documented residual revoke gap is honest and required by 02 §6's "service checks before context" rule.
- **Fetch preload** is sound: transports call global fetch at call time (`connectors/microsoft365/http.ts:20-21`) and the CLI composes them in `packages/m365/io.ts:21-22`.
- **CLI freeze** is consistent with authority.ts (CONNECTION_ALREADY_ACTIVE at `packages/m365/authority.ts:52`), 02 §1 permissions, and the generic 256-length flag limit at `packages/ops/commands.ts:110`.

**Optional notes** (no hash change needed; implementer may apply):

- Line 13 cites 03 §§6–7, but 03 ends at §6; the dedup, historical-proof and coverage-narrowing rules the brief restates are in §5. Add §5 to the routing list.
- Line 270: `--import tests/support/...` is a bare specifier under ESM resolution and will likely fail with module-not-found. Spawn with `./tests/support/m365-fetch-preload.ts` or a file URL.
- Line 128: "1-digit canonical fractions" cannot exist in stored DTOs (minimum three digits). Intended meaning is a 1-digit input fraction; wording only.
- Line 215: the legacy flag limit is 256 UTF-16 units, not bytes.
- Lines 184–186: the FAILED closure plus client tool.failed after an in-flight authority loss preserves the Stage 1 gateway but diverges from the S2-B recording precedent (`packages/m365/denial.ts:42-52` with `lockForRecording`). The brief decides this explicitly, so it is not obligatory; the test should assert that closure metadata is the safe code only, even after full membership removal.
- Line 89: name `packages/correlation/contracts.ts` explicitly, since `packages/core/contracts.ts` also exists.
