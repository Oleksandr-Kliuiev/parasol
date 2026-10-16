# Astra independent architecture acceptance — S3-design-rc3

APPROVED, MOCK-only design; no required changes. Fresh native /root/astra_s3_design_rc3,
explicit gpt-6-astra/xhigh. This accepts architecture only, not implementation, LIVE or prior live gates.

Baseline 916a4d69853ff6da636e8609a2e0bd33aa787f66.
Package dc4c518527eaeb9aecad0d0186afa34dcdfc1bd3d3dec97f0e22467073f74887.
ZIP 9267c96975902e3c7bdc48322820ba3462488bd29fc929b21e6613a50bb11fa7.
Manifest e15b49604f79f7d17eff3e78099844d121450ae335614a605345bf4adc3d46c9.
All8 current/ZIP docs, both preservation manifests, recorder324 and Stage2 normative11 + aggregate hashes verified.
S3 identity rechecked at completion.

Coherent: immutable token ROW ID/expiry captured after fenced authentication plus strict epoch/DB-clock proof preserves
accepted digest-gated ApiToken boundary; dedicated definer/FORCE RLS/count provisioning/scoped FOR UPDATE and exact ACLs
fail closed; distinct signer checks exact stored protected preview; APPROVED replay cannot renew; atomic consumption and
lifetime unique create attempt separate authorization/dispatch; recovery cannot re-create; persisted verification claims,
budgets/deadlines/candidate-original ordering preserve facts; FIXTURE port/privacy keep vendor writes outside scope.

Actual implementation acceptance must demonstrate:
1. Nonsuperuser provisioning, blank/wrong GUC, missing fence, invalid surface/pre-roles default grants.
2. Token rotation/revocation/expiry changes/natural expiry after locks, remove+restore and unchanged zero-token-row actor scope.
3. Approver without request grant, exact preview, approval replay and committed invalidation.
4. Concurrent reservation/revoke/cancel/owner mutation orderings and deadlock rollback with zero dispatch.
5. Crash/timeout/audit/publication/restart: exactly one lifetime create.
6. Read lease expiry/budget/candidate mismatch and late original/candidate ordering both ways.
7. Protected files, redaction, zero vendor calls and mandated compatibility suite.

Residual risks accepted for MOCK design: workspace-wide request churn; UNKNOWN may persist; matching ticket does not prove
upstream uniqueness; trusted filesystem/owner DDL boundaries; production wire/retention/readiness require separate amendment.
Read-only; no prior review reports, DB/migration/test/network/provider/credential/pilot operation. Effective review effort xhigh.
