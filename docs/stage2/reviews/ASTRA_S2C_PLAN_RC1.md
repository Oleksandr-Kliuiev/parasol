# Astra S2-C plan RC1 review

Date 2026-10-08. Fresh native GPT-6 Astra, explicit xhigh. READ ONLY. Verdict: CHANGES_REQUIRED.
Artifact: S2C_IMPLEMENTATION_BRIEF_RC1.md, SHA-256 7ae6040c2c2ccd3f59c40a49d888e92497799a6d32f7a2eb723ff4e333f09656.
Native task /root/astra_s2c_plan_rc1. Reviewer verified brief, all 11 normative and all 269 S2-B baseline hashes.
No tests/migrations/network/implementation executed. No implementation or live acceptance.

Required findings:

1. P1, lines123–127: separate cleanup URL may target another correctly provisioned Atlas DB with matching scope IDs.
   Bind runner target to authenticated runtime database before context/cleanup. Derive target substituting credentials only
   or validate complete target identity. Test a second DB rejection with no cleanup/audit there.
2. P1, lines91–93: include resolved DEVICE identity and Device.personId (including null) in cursor snapshot fingerprint;
   assignment changes alter ASSIGNED_PERSON_ACTIVITY and counts. Test reassignment and assignment removal => CORRELATION_CHANGED.
3. P2, lines40–45,113: ordinary stored-read ACTIVE/no-I/O rules conflict with DISABLED activation probe.
   Separate probe/activation behavior and status states; freeze probe behavior for DISABLED/ACTIVE including mid-probe revoke.
4. P2, lines111–119: define exact CLI create vs resume modes/flags/request-root selection/reset/requeue execution behavior.
   Subprocess tests preserve request ID/counters/retryAt, no early I/O, explicit recovery reset.

Optional: use preserved seven-digit DTO timestamps for exact filtering/order; test-only fetch preload for actual CLI is
feasible, with fixed production authorities and refusal of unexpected outbound requests.
Deterministic ID rules, coverage/freshness, shared MAC key, composed registry/legacy projections and time-bounded cleanup
otherwise align with RC5. Provider identity is explicit native assignment; per-response billing counters unavailable.
