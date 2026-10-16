# Astra — S3-design-rc1

REQUIRED_CHANGES. Fresh native gpt-6-astra/xhigh, session /root/astra_s3_design_rc1; effective effort retained.
Separate response-model metadata is not exposed by the native reviewer runtime. Read-only: no writes, DB or network.

Verified 8 current/ZIP files, package d2839b7f353d4571ddaa22f5ca1206330f30c88994dfe04e8056fe082284811a,
ZIP2e61652ce880cc16262b683eabcc41075a11c2aad6dc20faf53ad04a18ec955a; accepted recorder324 and Stage2norm11 hashes/aggregates match.

Required findings, before implementation:

1. P1, 03_DATA_AND_CONCURRENCY:21/35 — specify fence definer role/grants/RLS/membership, qualified references/pg_temp,
   affected-row scope, exactly-one-row/missing-fence failure, Workspace lifecycle and startup checks. Unscoped non-superuser
   owner must serialize through FORCE RLS, never silently update zero rows. Put the complete fence before fenced S3-A preview.
2. P1, 02_CONTRACTS:7/22/51 — approver with approve/read/context cannot see exact stored content. Add a protected stored
   preview/export, exact immutable hash/content binding, same-client permissions and tamper/stale tests.
3. P1, 02_CONTRACTS:33 and 03:11/04:5 — define revoke command/caller/transitions. Current-state checks do not permanently
   invalidate approval after permissions are removed then restored. Specify persisted authority epochs and exact mutation rules.
4. P1, 04_EXECUTION_AND_PORT:34 and 03:13 — persist verification nonce/candidate/deadline/ownership and abandoned-claim
   recovery. Budget remains consumed. Specify predicates for stale read, newer candidate and late create ordering; initial read count.
5. P2, 02_CONTRACTS:22/29 — resolve existing idempotency key retrieval versus stale preview hash/token rotation/binding changes.
   Retrieval must not renew immutable authority or approval. Freeze the operation ordering and terminal-request rule.

The MOCK-only boundary, separate synthetic commits, one create lifetime and visible uncertainty are sound directions.
Architecture approval remains pending for a corrected frozen package; code/live approval is separate.
