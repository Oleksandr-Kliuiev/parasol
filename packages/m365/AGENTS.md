# M365 domain services routing (Stage 2, S2-B)

Read docs/AI_CONTEXT_MAP.md first; contracts: docs/stage2/02_CONTRACTS.md §1–3, 03_CONNECTOR_SYNC.md §2–6.
Graph transport/auth/nextLink rules live in ../../connectors/microsoft365 (contract.ts, http.ts, auth.ts, connector.ts).
- authority.ts: pins (tenant + lifecycleVersion), Connection-first lock, current-authority recheck, Graph session authority.
- activation.ts: versioned one-use activation capability (private numeric expiry), probes, conditional ACTIVE.
- directory.ts: atomic admission (state row ensured, then locked; exhaustion, then retryAt) → stage pages → ONE publication
  transaction (mirrors, pointer, counts, budget reset, audit) / fenced failure persisting retryAt for every TRANSIENT error;
  8-attempt budget `attemptsUsed` (migration 202610081400). directory-retry.ts: explicit audited reset of a spent chain.
- denial.ts: one workspace security denial per public sync boundary (directory sync/reset, sign-in request/run/requeue).
- windows.ts: sign-in request, root-job budget, attempt claim, publication, failure, requeue. ingest.ts: leaves, pages, splits.
- signin-rows.ts (pure: [from,to) position, version hash, backoff, split), status.ts (pure read semantics), io.ts (composition).
Lock order everywhere: Connection → request (counters) → window/resource state → root job → attempt/generation → leaf.
Never hold a lock over network I/O; read the clock after locks; never store nextLinks or tokens. Keep files ≤500 lines.
Leases/deadlines/bounds are read from the persisted rows; claim descriptors are informational only.
M365SyncRequest.state stays OPEN by design in S2-B (finished outcomes are immutable while requeue may reopen a job);
per-root job states are authoritative; a derived request status belongs to S2-C m365-status.
Tests: tests/m365-{auth,http,adapter,denial}.test.ts, tests/m365-budget-invariants.ts and tests/pg/m365-{activation,directory,
directory-retry,directory-budget,budget-upgrade,order,windows,window-recovery,window-publication,window-limits,signin-outcomes,
sync-denial,retry-upgrade}.pg.test.ts. Policy: docs/stage2/reviews/S2B_RETRY_REPAIR_PLAN_RC2.md (approved implementation detail).
S2-C (brief docs/stage2/reviews/S2C_IMPLEMENTATION_BRIEF_RC3.md): reads.ts (directory/sign-in lists), read-contracts.ts,
status-read.ts (m365-status), maintenance.ts + maintenance-role.ts (m365-cleanup on the EXECUTE-only runner; runtime URL pairing
via openRuntimeDatabase). Correlation itself lives in ../correlation (snapshot, cursor, coverage, resolve, query). Reads never do I/O.
