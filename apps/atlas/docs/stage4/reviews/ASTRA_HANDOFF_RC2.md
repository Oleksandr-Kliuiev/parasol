# Bounded RC2 implementation handoff consistency check

**Verdict: CONSISTENT. No normative amendment is required for this handoff.**

This is a bounded continuation of the existing explicit GPT-6 Astra/xhigh review session; effective effort remains xhigh. It checks implementation choices against the approved architecture and does not constitute new independent initial architecture review, code acceptance, permission to bypass a checkpoint, or LIVE admission. Native launch/runtime identity and effort evidence remain the coordinator's responsibility.

## Exact artifacts and scope

- Handoff: `docs/stage4/IMPLEMENTATION_HANDOFF.md`, 56 lines; SHA-256 **`9f199dbb27d255f60db9f926e788cc23b5cba83722d5c0aff780a913f18b94ab`**.
- Approved normative package: `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`.
- Original immutable approval report: `/tmp/atlas-stage4/ASTRA_DESIGN_RC2.md`, SHA-256 `f992df46bc4539804ab1f04507db83b658a5b639d13904313d8263a2d30906b6`.
- Reviewed the handoff and relevant unchanged clauses of 02_CONTRACTS, 03_DATA_AND_CONCURRENCY and 04_PORT_AND_SYNC. Hashes of these three normative documents still match the prior RC2 review. The original approval report hash also remains unchanged. Other normative-file identity is inherited from the unchanged-package handoff; this bounded pass did not re-audit the entire baseline.
- No source inspection, database operation, build, code test, account/vendor operation, subagent or repository write was performed. The only write is this separate report.

## Consistency decisions

1. **Restrictive three-ID definer RLS — consistent.** Handoff lines31–33 select a role-specific restrictive definer policy intersected with the permissive workspace/client policy. This implements the already required workspace/client/connection confinement in 03:96–105, including same-client connection X/Y isolation, without changing either installed fence policy. Runtime, runner and owner grants are not enlarged. The acceptance test must observe effective row visibility under the actual non-superuser definer and verify policy flags.

2. **Purged snapshot and lastSuccessAt — consistent.** Lines34–35 make explicit the interpretation already necessary to satisfy 03:118–126 and the EXPIRED/purged row at 04:51: an extant pointer must agree with its snapshot's publishedAt; clearing an expired pointer preserves the prior-success timestamp. Both snapshot pointer fields must still clear together, lastCompleted history remains coherent, and cleanup receives no lastSuccessAt update privilege. This resolves implementation ambiguity without authorizing arbitrary pointer or history changes.

3. **Deferred invariant mechanism — consistent.** Lines36–38 choose deferred invoker constraint triggers for the already specified commit-time cross-row invariants. They preserve qualified relations, migration-time PUBLIC EXECUTE revocation, both directions of ACTIVE discoverability and the scoped FKs. This is a concrete enforcement mechanism, not a relaxation to application-only checking or SQL CHECK truth semantics.

4. **Implicit FK locks and fixed conflict handling — consistent.** Lines19 and36–38 acknowledge the implicit locks that remain even though explicit Connection row-lock SELECT is forbidden. The architecture never promises freedom from every deadlock. Admission must roll back and return a fixed conflict without retry; publication may retry only known 40P01/40001 rollback, at most three total transactions, with the same detached fact/identities, fresh checks and zero port calls. The existing narrowly authorized private-failure rollback policy in 03:73–77 also remains unchanged. Tests must create an actually conflicting FK/tuple-lock ordering and cover either transaction becoming the victim; no claim that every ordinary UPDATE necessarily produces this lock conflict is needed.

5. **HTTP 503 UNAVAILABLE view — consistent.** Lines39–43 retain 02:83's explicit binding-failure HTTP503 mapping while returning 04:50's UNAVAILABLE representation after current read authorization. The summary DTO carries summary:null; the status DTO still omits summary/amounts as 02:81 requires. All responses retain synthetic:true, fixed codes, no-store and the inherited service-owned audit rules. Other authorized precedence rows can return200. Unknown/invisible/non-PowerOffice connection404, auth401, scope403 and readiness/mode503 remain separate fixed cases. The quoted HTTP200 alternative is expressly a recommendation and is not the chosen contract.

6. **Identical completed receipt after the original deadline — consistent.** Lines44–46 apply the original deadline to new publication from ACTIVE, while allowing recognition of an already committed SUCCEEDED fact. That recognition is a no-op receipt, with full owned-fact/identity equality, fresh current token/ACTIVE actor, all sync permissions on one membership, unchanged current binding, no financial payload and no duplicate success audit. It creates no new export, authority capability, claim revival, retry window or public API surface. A receipt cannot bypass revocation or binding drift. A changed fact still conflicts, and an ACTIVE claim at/after deadline still cannot publish. This implements the existing distinction between publication and idempotent receipt in 03:64–70.

7. **Trusted fixture seeding — consistent.** Line47 places the C4 seed in private test/fixture code and keeps onboarding, CLI binding and generic bindable-system authority unchanged. No production or persistent pilot provisioning is implied.

8. **Audit outcome naming — consistent.** Lines48–49 distinguish the operational JSON enum from the workspace security-audit column without adding a metadata key or weakening the six-key allowlist. Financial/deletion counts, source dates, binding identifiers and raw messages remain excluded; sequence remains an operational ordinal. The workspace-denial/client-success separation is unchanged.

The operational notes at lines53–56 accurately carry forward the bounded fence wait, explicit retention/admission cap and per-read audit obligations. They grant no scheduling, UI, LIVE or production scope.

## Required changes and continuing gates

**Required changes: none.** Carry these concrete choices and their acceptance cases into the applicable S4-A/B/C briefs. Actual code must still satisfy the entire frozen package, including unchanged fresh authority, privacy, cancellation, replay, cleanup and legacy-regression requirements. No implementation claim or test pass is inferred from this consistency result.

The original RC2 architecture approval remains intact and applies only to the same frozen eight-file package. This administrative handoff is not a ninth normative file. Any subsequent choice that relaxes these obligations or changes a public/authority contract requires the designated renewed architecture gate.
