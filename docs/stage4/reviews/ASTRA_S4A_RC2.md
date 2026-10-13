# Atlas S4-A RC2 — independent actual-code acceptance

**Decision: CHANGES_REQUIRED.** Three required findings remain in maintenance-role confinement (A3/R2). Do not advance S4-B or S4-C. These findings restore the approved exact-privilege contract; they do not require a broader architecture or deferred services.

Reviewed 2026-10-09, completed approximately 10:23 UTC. Reviewer: native Codex subagent explicitly launched as **gpt-6-astra / effective xhigh**, fresh context. Assignment evidence is the native launch/runtime, not this report's self-identification. No previous S4-A assessment report or another reviewer's verdict was read. Implementer reports/tests were treated as evidence, not acceptance.

## Artifact and scope

- Checkout: `/Users/oleksandr/atlas-v1.1.3/vardahei-atlas-stage1-v1.1`; HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `planning/stage2-m365` plus sealed dirty work. HEAD diff was not used as the checkpoint delta.
- RC2 package hash: `f59e3a9368d2fe94111a38d8f5680acbe43ccaf638728121773e39d0f7029b55`.
- `verification/stage4/S4A_RC2_MANIFEST.json` SHA256: `1086e58365a7c4bce69d3303aafb8a9e2295f6419740afe718b8a33e739e561b`.
- `verification/stage4/S4A_RC2_PACKAGE.zip` SHA256: `de6265faa5ed9f5927debdcdf7252574e00d020210c5e181811a0e183970d8aa`.
- Working-inventory hash: `d4e06e2f5ff86925485d4087f1c8acea68ab89c7c9d841f6bc3b79636570a5de`; all 727 entries matched before and after independent checks. All 690 text archive entries matched the manifest, with no extra archive entries.
- Baseline SHA256: `6888685478c236dd7fff0779caf3090c24fe151ea829d05621574b739d4e1d95`; independently calculated delta: 30 changed, 55 added, zero removed.
- Approved architecture: package `d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`; design RC2 manifest SHA256 `43f86a7eb492738a2fb0d9c43c18470e26d19860a259f708f38bb7e9ee3c7230`. All eight normative files matched. Mandatory handoff SHA256 `9f199dbb27d255f60db9f926e788cc23b5cba83722d5c0aff780a913f18b94ab` matched.
- Scope: normalized DTOs/aggregation, bearer authority foundation, scoped schema/guards, exact role/readiness surface, SQL cleanup foundation, and accepted integration preservation. S4-B/C public workflows remain deferred.

## Required findings

### F1 — P2: Foreign-schema relation privileges bypass readiness and survive provisioning

**Locations:** `packages/graph/poweroffice-role.ts:59,80,137–164`; `prisma/roles.sql:203–204` and its final confinement checks.

`po_rels` only enumerates `current_schema()`. Consequently both maintenance roles can hold table/view, column, or sequence privileges in another application schema without any violation. `roles.sql` resets relations only in `public` and has no complete relation-privilege postcondition, so it reports success while leaving these grants intact. This breaks the definer's exact allowlist/no-auth-access and the runner's EXECUTE-only contract in design 03 / A3.

**Independent real-PG reproduction:** on a newly created disposable database, call `addPowerOfficeFixtures(owner)`, connect the confined runtime and PowerOffice runner, and as the migration owner execute the following, substituting the harness's generated role names:

```sql
CREATE SCHEMA review_extra;
CREATE VIEW review_extra.token_surface AS
  SELECT "tokenHash" FROM public."ApiToken";
GRANT USAGE ON SCHEMA review_extra TO <po_runner>, <po_definer>;
GRANT SELECT ON review_extra.token_surface TO <po_runner>, <po_definer>;
```

Evaluate `RUNTIME_ROLE_CHECK_SQL` as runtime and pass its row to `assertConfinedRuntimeRole`. It accepts: `poOwnerViolations=0`, `poExecuteViolations=0`. The runner in a separate session successfully reads the owner-backed view; the definer also reads it under `SET LOCAL ROLE`. The probe queried only a row count and printed only a boolean; every underlying credential was a disposable generated fixture. Re-running the actual `provisionRoles`/`roles.sql` succeeds, readiness still accepts, and the runner can still read those rows.

The same independent probe matrix confirmed acceptance before **and after successful provisioning** for:

- Column-only `SELECT("tokenHash")` on the foreign view.
- `SELECT` on foreign `review_extra."PowerOfficeSnapshot"` (same name as an allowed public relation).
- `USAGE` on foreign sequence `review_extra."PowerOfficeAttempt"`.

Positive control: the equivalent owner-backed **public-schema** view grant produces `poOwnerViolations=2`, `poExecuteViolations=1`, readiness refuses, and provisioning removes its access. Thus the foreign-schema result is a real enumeration gap, not a broken assertion or non-executable grant.

**Required repair:** enumerate effective table, column and sequence privileges over all relevant user relations, and anchor allowlisted relations/columns to exact schema-qualified identities or OIDs. Merely widening enumeration while matching by unqualified `relname` would incorrectly allow the same-name test above. Provisioning must remove unauthorized explicit grants where it can do so safely, or fail atomically; it must verify no unauthorized effective privilege remains, including PUBLIC/inherited/other-grantor paths. Do not silently rewrite unrelated global privileges. Add regressions for each role separately, table versus column grants, same-name foreign objects, sequence access, and non-revocable residual access.

This is a configuration/tamper-admission defect: an extra grant is required. Freshly provisioned default roles were not shown to leak data. The mandatory readiness/provisioning gate nevertheless accepts the demonstrated unsafe configuration.

### F2 — P2: User-created temporary-schema routines escape the supposedly complete routine confinement check

**Locations:** `packages/graph/poweroffice-role.ts:85–88`; `prisma/roles.sql:214–215,341–342`.

The blanket `left(nspname, 3) <> 'pg_'` filter also excludes user-created functions in `pg_temp_*`. These are callable from a different session by qualified name. A granted owner-backed SECURITY DEFINER function there is therefore an additional capability that neither readiness nor provisioning detects or revokes. The exact capability/shared-invoker allowlist must also cover this user-created routine surface.

**Independent reproduction:** in the disposable migration-owner session, create a temporary anchor table, obtain its schema using `pg_my_temp_schema()`/`pg_namespace`, and create the following in that actual `pg_temp_<n>` schema:

```sql
CREATE FUNCTION <temp_schema>.review_credential_count() RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
  AS 'SELECT count(*) FROM public."ApiToken"';
REVOKE ALL ON FUNCTION <temp_schema>.review_credential_count() FROM PUBLIC;
GRANT USAGE ON SCHEMA <temp_schema> TO <po_runner>, <po_definer>;
GRANT EXECUTE ON FUNCTION <temp_schema>.review_credential_count()
  TO <po_runner>, <po_definer>;
```

With that owner session still open, the separate runner session successfully executes the qualified function over the synthetic credential rows. Observed output:

```json
{"check":"owner-created temp-schema SECURITY DEFINER routine","ready":true,"poOwnerViolations":0,"poExecuteViolations":0,"call":{"succeeded":true,"seededCredentialsVisible":true}}
{"check":"temp routine after provisioning","ready":true,"poOwnerViolations":0,"poExecuteViolations":0,"runnerRetainsExecute":true}
```

**Required repair:** distinguish actual trusted system routines from user-created temporary objects; do not exempt a user-controlled object solely by the `pg_` namespace prefix. Readiness must reject this effective EXECUTE path for either maintenance role. Provisioning must safely revoke the unauthorized grant or refuse, and recheck the result. Preserve the accepted exact shared-helper list and Stage3 contracts. Add a real separate-session temporary-schema SECURITY DEFINER regression with PUBLIC revoked; cover PUBLIC/effective grants without widening the allowed helper surface.

### F3 — P2: Schema CREATE and schema ownership are not confined for both maintenance roles

**Locations:** `packages/graph/poweroffice-role.ts:130–136,153–164`; `prisma/roles.sql:335`.

The definer is checked for CREATE only in `current_schema()`/`public`; the runner has no schema-CREATE check. Namespace ownership is not checked. These roles can therefore hold object-creation authority beyond their documented SQL capability while both readiness and provisioning declare confinement.

**Independently reproduced, each from an otherwise healthy disposable fixture:** `GRANT CREATE ON SCHEMA public TO <po_runner>`; `GRANT CREATE ON SCHEMA review_extra TO <po_runner>, <po_definer>`; and `ALTER SCHEMA review_extra OWNER TO <po_definer>`. For every case, readiness accepts with both PO violation counters zero, `roles.sql` succeeds, and readiness still accepts afterwards. Grants/ownership were individually repaired in the test before the next case; no repository source changed.

**Required repair:** inspect effective CREATE and namespace ownership across the applicable persistent/user schemas for both roles, allowing only the explicitly required USAGE surface. Provisioning must safely restore or reject excess schema authority and verify its postcondition. Test explicit, PUBLIC/inherited-effective, foreign-schema and ownership paths; preserve ordinary temporary-work behavior only where the contract actually permits it. Existing role membership and relation/routine ownership checks should remain intact. This finding is not a claim that those already-covered membership checks failed.

## Independent checks and evidence

All PostgreSQL work used `/tmp/atlas-stage3/claude-tools/pgenv.sh` and the existing disposable harness. The wrapper, environment values, URLs and private credentials were never read or printed. Databases/connections/roles were disposed in `finally`/test teardown.

| Independently run check | Result |
|---|---|
| `node --experimental-strip-types --test tests/poweroffice-*.test.ts` | 15/15 passed; no fail/cancel/skip; ~0.19 s |
| wrapper + `node --experimental-strip-types --test tests/pg/poweroffice-*.pg.test.ts` | 55/55 passed; no fail/cancel/skip; ~7.47 s |
| wrapper + `node --experimental-strip-types --test tests/pg/action-requests.pg.test.ts tests/pg/action-guard.pg.test.ts` | 16/16 passed; no fail/cancel/skip; ~32.20 s |
| Independent ordinary/temporary-schema adversarial probes above | Confirmed F1–F3; default/public-schema positive controls behaved as described |
| Sealed manifest/archive/inventory and baseline preservation, before/after | Passed; zero reviewed-file drift |

An initial custom F1 probe confirmed the unsafe read/readiness result, then its **re-provisioning setup** stopped because my synthetic placeholder password did not match the existing harness's secret format. Its `finally` cleanup ran. I corrected that reviewer-side input to generated hex, reran the probe successfully, and then completed the separate matrix above. That setup failure is not an implementation finding or a passing provisioning check. A read-only extraction-comparison helper also needed its search corrected from exported to non-exported original `currentToken`; its corrected comparison passed.

Implementer final evidence inspected: `verification/stage4/S4A_RC2_IMPLEMENTATION_EVIDENCE.json`, SHA256 `69e2fbf95dbc0650a5f93f40671c18ca577d0e52423c0ea7b85ce2bef0dd4678`. All eleven final checks report exit 0. Corresponding `rc2-final` logs exist; npm-test footer is 196/196 and test-pg 456/456, zero failures/cancellations/skips. Schema validation/generation, typecheck, API build/smoke, PG17, drift and both whitespace checks are implementer evidence; I did not rerun generators/builds or label those checks independent. The superseded earlier pass and historical failed/cancelled RC1 run were not reclassified.

Native implementation receipts report actual assistant response model `claude-opus-5-5`, effective high, native firstParty/claude.ai subscription with no fallback/credits, same session `8e56f05b-1dbf-4fc4-b4da-a526b2fbeb5d`. Those receipts are provider/execution evidence, not acceptance. Reviewer quota/attributable usage was unavailable; no quota-saving claim is made.

## Confirmed implementation and preservation

No additional required issue was established in the inspected DTO, BigInt/Oslo aggregation, terminal export disposal, private bearer authority, paired binding, scoped FK/NULL/lifecycle/aggregate guards, ordinary deferred completion, retention and SQL cleanup behavior. The independent focused tests verified these boundaries, including real last-lock token expiry, direct deadline refusal with backdated transport times, commit rollback, same-client connection RLS, restricted locks, upgrade and non-superuser paths. This is bounded evidence, not a claim that all future adversarial cases or S4-B/C behaviors are implemented.

The Stage3 current-token query and `setLocal` implementation match the accepted S3C archive/baseline byte-for-byte apart from making `currentToken` an export in its shared module; the actions integration only imports/re-exports the extraction. Relevant Stage3 tests passed. Generic PowerOffice connection/credential resolution refuses before a secret resolver, and the domain audit factory enforces the six-key allowlist.

All 20 installed migrations plus lock, eight Stage4 normative files, earlier inventoried history and prior sealed artifacts remained unchanged. No baseline file was removed. Final git inventory had only the expected RC2 manifest/ZIP outside the manifest's pre-seal inventory. HEAD and branch stayed unchanged. I wrote no checkout source, generated files, status or evidence; this outside-repository report is the only filesystem deliverable.

## Residual/deferred scope and gate

S4-B actual source sessions, claim/publication/failure/recovery services, retries/replays/cancellation and required Connection/FK deadlock-victim journeys remain deferred. S4-C dedicated reads/API/CLI, fresh maintain admission, paired runner DB verification, and original whole-transaction 10 s cancellation/1 s lock-timeout wrapper remain deferred. SQL cleanup's tested foundation does not establish those service guarantees. All eight handoff obligations remain binding at their applicable checkpoints. LIVE remains **DEFERRED_BY_OWNER**; no vendor semantics, account access, operational schedule or production readiness is accepted.

Fix F1–F3, preserve the approved scope, run affected verification and the required checkpoint suite on the resulting sealed source, then obtain fresh independent Astra/xhigh acceptance for that identity. **S4-A RC2 is not accepted.**
