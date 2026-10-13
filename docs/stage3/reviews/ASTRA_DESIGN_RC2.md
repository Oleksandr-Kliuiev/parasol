# Astra architecture review — S3-design-rc2

Verdict: REQUIRED_CHANGES. Fresh native /root/astra_s3_design_rc2, explicitly gpt-6-astra/xhigh.
Package 1c715ed4f977e8181453829591f48f6c616a2c8ba13f6ef23efea93e5fcd1521;
ZIP d9bb342cbddc9015302ef0f82a704fd05f2f62282dfb53a02ba2e59c5d21d264.
Eight current/ZIP files and accepted recorder324/Stage2 normative11 plus HEAD/branch verified.
Read-only architecture review; no code, DB, network/provider calls or Stage3 tests.

1. P1, 03:36: actor/workspace ApiToken SELECT policy plus existing table-wide SELECT exposes tokenHash/label by direct SQL.
   Preserve accepted digest-gated policy and tests/sql-invariants.ts:206; any descriptor surface must enforce column privacy
   at DB level, exact signer identity, scope, expiry/revocation and transaction cleanup.
2. P2, 03:69: unscoped runtime under RLS cannot certify one fence per workspace. Define trusted provisioning completeness
   plus fail-closed scoped admission; incomplete backfill must fail provisioning and missing fence must refuse mutation/admission.
3. P2, 02:52: explicitly admit exact same-signer valid APPROVED replay without mutation/expiry renewal; refuse other terminal
   decisions, changed preview/hash, another signer and stale authority.
4. Normalize ACTION_NOT_DUE versus ACTION_RECOVERY_NOT_DUE in 02/04.

Otherwise coherent at design level: exact preview, monotonic epoch, dedicated definer, reservation authorization point,
one lifetime create, durable verification budget/leases and late-original/candidate ordering. Full fence belongs in S3-A.
Residual risks: FORCE provisioning, result/audit atomicity, lock order, deadline enforcement and safe output require actual
PostgreSQL/fault evidence at implementation checkpoints. No LIVE assurance.
