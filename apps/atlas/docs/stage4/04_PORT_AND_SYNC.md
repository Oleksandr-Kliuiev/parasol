# Stage 4 synthetic port and synchronization

## Built in port

packages/poweroffice owns authority, contracts, aggregation, state/publication, reads and maintenance admission.
connectors/poweroffice owns only the Atlas-normalized port and built-in deterministic synthetic export; it contains no
fetch/HTTP/OAuth/secret resolver. A trusted composition issues private export sessions pinned to connection/company/
lifecycleVersion/attempt/asOf; no operator-controlled callback or raw DTO can issue a session.

readPage receives a private session, expected ordinal and control {signal, monotonicDeadline}. It returns exactly02's page.
Per-page deadline is min(now+10s, original attempt read deadline); total read window60s from the committed attempt's DB
startedAt, with20s for persistence/recovery. Conservative monotonic anchoring occurs before the final admission DB-clock
read; pool/lock waiting consumes the original window. No timer restarts after await. Built-in cancellation checks before
and after work; future I/O adapters must honor in-flight abort. Tests inject failures only at private in-process seams.

The first page and EVERY later page require fresh caller/binding authorization before one invocation; authorization and
port call have separate commits/no held DB transaction. Revocation immediately after page admission can leave that
bounded already-admitted read in flight; it permits no next page or publication. A cancelled/failed/unknown source result
never auto-retries. Strict validation runs before any summary contribution. Track at most10000IDs in bounded private memory;
discard all page buffers and IDs when the pass ends. No staging rows, raw-body persistence or page URLs.

## Manual synchronization

1. Fresh admission creates one ACTIVE attempt and private session capability. BUSY and the1000attempt retention cap
   refuse before a port call. The CLI selects one already existing FIXTURE connection; it cannot create/bind/activate it.
2. Read bounded pages serially; before every call reauthorize using the same original attempt deadline and binding.
   A changed export/header/count/ordinal, duplicate ID, overflow, malformed DTO, timeout or source failure aborts the whole
   pass. A page boundary never renews the lease. No incremental/partial summary is exposed or persisted.
3. After the final verified page, compute exact grouped aggregates and publish as03's single transaction with fresh current
   authority. Publication uses the allocated snapshot ID; at most3 known-rollback DB attempts, zero additional port calls.
4. Failure closes only the owned ACTIVE attempt with safe code/audit, preserving last snapshot. If DB/audit/persistence
   fails, return visible fixed error and leave the claim for explicit recovery; never claim publication succeeded.
5. Explicit recover at DB clock>=deadlineAt (startedAt+80s) marks ABANDONED and clears the active pointer; before it, RECOVERY_NOT_DUE.
   No ACTIVE claim returns POWEROFFICE_NO_ACTIVE_ATTEMPT with zero business/audit effects, including after a lost publication acknowledgement.
   A later sync creates a fresh attempt, not a retry or continuation of the abandoned export. Late results never publish.
   Recovery may close an old claim despite current DISABLED status/lifecycle drift in the same immutable synthetic binding;
   it cannot reactivate the connection, call the source or publish the old result.

No automatic sync/backoff/scheduler is supplied. Retry means a new explicit authorized command after terminal failure or
recovery, with new allocated sequence, bounded retention cap and no reuse of ambiguous in-memory source sessions.

## Read view

Read uses03's fence FOR SHARE, scoped plain Connection read, State FOR SHARE and protected plain Attempt/Snapshot reads;
fresh current bearer authority and DB clock after final locks. No State initialization/domain mutation; successful audit
is atomic and audit failure emits no data. Precedence below is first matching row; all date/age tests use stored DB times.

| Binding/snapshot/history | Status / safeErrorCode / payload |
|---|---|
| Binding invalid/unavailable or snapshot lifecycle differs from current | UNAVAILABLE / CONNECTION_UNAVAILABLE or BINDING_CHANGED / null |
| Prior success exists and snapshot absent (purged), or snapshot expired (DB clock>=expiresAt) | EXPIRED / SNAPSHOT_EXPIRED / null, regardless of later FAILED/ABANDONED/ACTIVE |
| No prior success/snapshot; lastCompleted is FAILED or ABANDONED | ERROR / retained lastCompletedErrorCode / null, even if new ACTIVE |
| No prior success/snapshot; no completed outcome (including first ACTIVE) | MISSING / null / null |
| Unexpired current snapshot; lastCompleted FAILED or ABANDONED | STALE / retained lastCompletedErrorCode / bounded summary, even if new ACTIVE |
| Unexpired current snapshot; age>15minutes, lastCompleted not failure | STALE / SNAPSHOT_STALE / bounded summary |
| Unexpired current snapshot; age<=15minutes, lastCompleted not failure | FRESH / null / bounded summary |

Codes in the table have their full POWEROFFICE_ prefixes from02. Missing immutable binding refuses before any financial
read; UNAVAILABLE outranks EXPIRED. EXPIRED outranks later failure. Last-completed fields remain available as operational
history even when expired; safeErrorCode follows the table. An ACTIVE claim changes only progress/lastAttemptState, never
repairs failure-induced STALE or changes lastCompleted. Complete successful publication replaces lastCompleted and clears
the previous failure; known empty is {totalCount:0,currencies:[]}, never null. No source call on status/summary/API/CLI read.
Gateway exposes no PowerOffice tool or reader in this slice; legacy tools cannot reach these tables/services.

## Official references and future LIVE

Public sources checked2026-10-09, without authentication or account/vendor API calls:

- [Current API authentication](https://developer.poweroffice.net/documentation/authentication): v2 has per-client integration
  credentials and separate demo/production environments. Keys/tokens are secrets; no assumption that a workspace has one company.
- [v1 to v2](https://developer.poweroffice.net/documentation/from-v1-to-v2) and the
  [vendor legacy repository](https://github.com/PowerOffice/go-api-documentation): legacy wire DTOs are not current-v2 contracts.
- [Requests and paging](https://developer.poweroffice.net/documentation/requests): paging information is in x-pagination,
  and reads use replicated data. Pagination alone does not establish a stable accounting export.
- [Invoice payments](https://developer.poweroffice.net/workflow/usecase/reporting/retrieving-invoice-payments): invoice balance
  semantics are connected to ledger matching. This motivates a separate verified mapping before any real financial summary.

These references justify boundaries, not our invented MOCK fields or a live completeness guarantee. The normalized
export token/header are synthetic; do not claim a real vendor snapshot token exists. Exact v2 endpoint/OpenAPI, company
identity proof, read-role permissions, balance/credit/overpayment/currency/date semantics, complete bounded-export consistency,
replication/freshness and retention constraints are OPEN LIVE gates. If a real snapshot-completeness guarantee is unavailable,
LIVE cannot reuse a FRESH complete-summary claim without a reviewed contract amendment.

Before a future LIVE adapter: freeze current official schema and permission surface, bind one verified Go client key to
one Atlas client/connection, define secret handling/host redirects/pagination/cancellation/rate limits/body redaction,
prove no account-wide read or customer mix, validate reconciliation semantics with synthetic and approved account evidence,
obtain fresh dual architecture review and explicit owner read admission. Demo registration and token POST are account/API
operations, not permission implied by this local stage. No real invoices, credentials or company IDs are needed now.
