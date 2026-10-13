# Stage 2 — Microsoft Graph and sync

Official sources and unresolved account facts: [06_SOURCES_AND_ADR.md](06_SOURCES_AND_ADR.md).
All numeric limits below are proposed Atlas configuration, not Microsoft quotas or SLAs.

## 1. Endpoints and permission contract

Only global commercial cloud in this stage. Graph origin is fixed to https://graph.microsoft.com, API /v1.0.
Identity authority is https://login.microsoftonline.com/{boundTenantGuid}/oauth2/v2.0/token.

| Request | Application permission | Atlas fields/query |
|---|---|---|
| GET /organization | Organization.Read.All | $select=id; exactly one org ID must equal bound tenant |
| GET /users | User.Read.All | $select=id,displayName,userPrincipalName,userType,accountEnabled; $top=500 |
| GET /devices | Device.Read.All | $select=id,deviceId,displayName,accountEnabled,operatingSystem; $top=500 |
| GET /auditLogs/signIns | AuditLog.Read.All | createdDateTime ge from AND createdDateTime le to; $top=500; do not assume undocumented $select/orderby |

Application consent is an account setup prerequisite, never performed by this pack. Avoid Directory.Read.All and all
write permissions. Sign-in API availability/licensing and actual permission grants are checked per tenant in S2-LIVE;
a 403 is not evidence of an empty dataset or proof that a specific license is missing.
No additional Policy.Read or risk permission is requested; CA/risk fields are outside the DTO.
Use Graph-documented ge/le bounds and enforce Atlas half-open [from,to) locally. Validate and discard rows exactly
at to before staging; they still count against retrieval limits. Rows outside [from,to] fail the attempt. Never
subtract an assumed timestamp precision or depend on undocumented lt support.

## 2. Auth and tenant confinement

TokenProvider is a separate interface from GET-only HttpTransport. Production implementation performs only
client_credentials POST to the fixed tenant-specific token endpoint with graph .default scope.
Initial local/live-smoke implementation uses env secret reference for client ID/secret; secrets are resolved in memory.
Certificates/federated credentials can replace TokenProvider later without changing authority rules.
Do not parse an unverified access token as proof of tenant. Graph tokens are treated as opaque.

Acquire token for the bound tenant and call /organization with that same token; require ID equality before
users/devices/signIns calls and on every newly acquired token. Cache key includes workspace/client/connection,
tenant, application ID, secretRef and lifecycleVersion; secretRef+lifecycleVersion is the credential-version identity
for this stage. Credential rotation must increment lifecycleVersion even if the reference string is unchanged;
no global token shared across clients. Expiry minus 120s refresh margin;
Operational rotation uses m365-disable before secret replacement and a new activation afterwards; no secret-mutation API is added.
if token expires sooner, use a bounded reacquisition failure rather than a refresh loop. Never persist tokens.
Recheck ACTIVE binding before secret lookup, vendor calls and publication for ordinary sync. For activation only,
use Foundation's activation-purpose issuance on a bound DISABLED connection, extended with lifecycleVersion/expiry
and one-use conditional consumption. Token/tenant/users/devices capability probes are allowed under this capability;
no data is published. Successful activation atomically checks unchanged version and authority before setting ACTIVE.
Disable/revoke invalidates prior capabilities, even if a probe is in flight; FIXTURE never follows this path.
The concrete local operation is `m365-disable` from 02 §1; old-version cache entries cannot be reused across processes.

Use redirect:error for both auth and Graph. Validate every nextLink: HTTPS, exact origin, no userinfo/fragment/port
change, same endpoint collection path and /v1.0 version. Opaque query tokens are retained in memory only.
Never accept a URL or tenant from caller, model, fixture free text or API response outside this policy.
NextLink is used as returned after validation; do not splice/rebuild its query. Same token/tenant binding for all pages.
NextLink visited twice, duplicate contradictory directory row or malformed value → safe failure, no publication.

## 3. Resource availability

Activation verifies tenant, users and devices access. Sign-in access is a separately recorded capability;
directory-only degraded activation is allowed, sign-ins remains UNAVAILABLE/error with a safe code.
Capability probe must use a bounded window; a valid zero-row response proves access only, not historical completeness.
Organization mismatch blocks all resources. A general auth failure does not get relabelled as a license failure.

Persist attempt state before I/O. No success yet → MISSING; latest failed attempt after previous success → STALE
with last good data inside its retention; no retained good data → ERROR. Deliberately unavailable capability maps
to MISSING with safeErrorCode such as M365_SIGNINS_NOT_AVAILABLE (never [] as a successful result).
Directory freshness default 60m; completed sign-in window freshness default 15m since last full reread.
Directory age >=60m (or a newer pending/failed attempt) is STALE. Existing confirmed mappings may still use the active
generation until completedAt+24h, with DIRECTORY_STALE; at expiry they become UNRESOLVED/DIRECTORY_EXPIRED.
New confirmations require fresh active membership. These rules are independent of sign-in traversal coverage.
This freshness rule intentionally also applies to historical intervals: after 15m resources are STALE until
reread, while coverage.status may remain COMPLETE and traversalComplete=true with no gaps. Use the independent
coverage.freshness field defined in 02 §5; freshness never changes traversal coverage status by itself.
Old evidence remains useful without implying recent revalidation. A reread does not promise every event is reported.
Age beyond freshness → STALE even if no recent failure. Coverage carries retrieval time independently of event time.

## 4. Directory full generations

One job per connection/resource. Before I/O atomically allocate attemptSeq and claimToken, including first-ever read.
Page size 500, max 40 pages/20,000 rows, max 5 MB response/page; timeout 15s/page, max 10m/job.
Numbers are configurable within hard bounds; hitting a bound fails with SYNC_LIMIT_EXCEEDED, never publishes a truncated directory.

Stage validated projections page by page under generationId. Retry of page/job does not expose staged rows.
After final page, in one scoped transaction: assert current claim/binding, compare attempt ordering, register opaque
ExternalEntity mirrors, verify typed constraints, publish generation pointer and counts, update lastSuccess and audit.
Only the current latestStartedSeq+claim may record state or publish. Once a newer attempt starts, older results
cannot replace either its success or failure; preserve last-good pointer separately from latest attempt status.
Record latestRecordedSeq for failures too, and never turn a newer failure into OK using an older completion.
Use the same ordering guarantees already learned in Stage 1, including overlapping first syncs with identical times.
No absence/deletion reconciliation after a failed/partial generation. A fully traversed generation replaces active
membership; absence means NOT_CURRENT, not a proven deletion (Graph directory reads can be eventually consistent).

## 5. Sign-in windows and durable recovery

Sign-ins are separate evidence, not RawEvent SECURITY_INCIDENT and not a replacement snapshot.
`m365-sync` accepts a requested interval ≤24h within the retained period. It selects intersecting canonical UTC-hour
roots (at most 25), unique per connection/rootFrom. Actual retrieval bounds are shown separately from requested bounds:
each root attempt covers [max(rootFrom, retainedFloor), min(rootTo, now-5m)]. Bounds are fixed at claim before I/O.
This bounded widening is specific to operator sync; read endpoints always return only the exact requested interval.
Skip empty intervals with an explicit not-yet-collectable gap. Graph filter and local validation enforce attempt bounds.
The retainedFloor is now minus the configured retention, fixed for the attempt; output reads still enforce current expiry.

At most 20 pages/10,000 evidence versions per leaf, 5 MB/page, 15s/page, 10m hard deadline per root attempt.
On cap, persist a SPLIT container and two nonoverlapping children inside that attempt; minimum child duration 1m
(a clipped root shorter than 1m is unsplittable). Never create overlapping or zero-length children; total leaves
≤60 per root and ≤1,500 per sync request, total staged rows ≤100,000 per root and ≤250,000 per request.
Exhausted size/time/splitting cap → FAILED/SYNC_LIMIT_EXCEEDED for the attempt. Partial leaf success is staging only.

ClaimToken + lease expires in 12m; root attempt has hard 10m deadline. Persistent retries max 5 (config); every claim
consumes an attempt, including crashes. Expired claim cannot write completion/failure/audit on behalf of its successor.
Failure → RETRY with retryAt for transient errors, FAILED for permanent/attempt exhaustion; manual requeue audited.
Restart creates a fresh immutable attempt for the same root, newly fixed bounds and a new monotonic attemptSeq, refetching
from the first page. Retry counters belong to the logical operator request/root job and survive attempt rows;
an explicit audited requeue resets that finite retry budget. Do not persist nextLink/access token as a cursor.
Persist request/root-job counters and consume them atomically; a process restart must not create a fresh budget.
Transient failure schedules retry on the root job, while the attempt itself becomes FAILED; all counters/state share
the claim fence. A CLI request ID is server-generated and requeue refers to the existing scoped job.

Pages upsert immutable evidence versions and attempt/leaf-scoped memberships. A refresh never mutates the existing
published attempt. When all leaves exactly cover fixed bounds, one transaction checks current root seq/claim and
connection lifecycle fence, then swaps publishedAttemptId and writes counts/completedAt/audit. Crash before that
commit preserves last-good publication (STALE if refresh failed/pending), or leaves a gap when none existed.
Older attempts cannot publish after a newer one starts. A failed split half means neither half is newly published.

Coverage/items/freshness and cursor fingerprint all derive from exactly one published attempt per root. A new
publication may narrow coverage only at the advancing retention boundary; otherwise reject reduced bounds until
it preserves prior unexpired coverage. A failed refresh never advances retrieval time. Query clips root coverage
to its interval and current retention; time gaps and stale roots are explicit, with no all-clear inference.
Equal ID/hash deduplicates; changed allowlisted content stores another immutable version. If the selected attempt
returned that version, its retrieval time belongs to that attempt only. Other retained published historical versions
may mark the source ID CONFLICTED and appear as historical proof, but never receive the new attempt's freshness.
Staged-only versions cannot affect visible conflicts. No automatic choice of canonical identity from conflicted evidence.

For routine operator passes, reread the last complete hour plus previous hour (overlap) and request older intervals
explicitly up to 7d. There is no high-watermark claim that older sign-ins can no longer arrive/change. A daily manual
reconciliation can reread the retained range in ≤24h chunks. No scheduler is added in Stage 2.
Coverage is limited to the source response and last retrieval; late records outside reread windows remain unknown.

## 6. Error handling and operations

| Failure | Handling |
|---|---|
| 429 | TRANSIENT; persist Retry-After delay, fallback 60s + bounded jitter if missing; do not sleep inside HTTP handler |
| 5xx/network/timeout | TRANSIENT; exponential backoff with max 15m, bounded attempts |
| 401 | Invalidate token; one reacquisition and tenant verification per attempt; then fail auth, no tight loop |
| 403 | Capability/access failure with safe code; retain bounded last good data as STALE; no invented license diagnosis |
| Invalid JSON/DTO/nextLink, tenant mismatch | PERMANENT; visible failed job and safe audit; no partial publication |
| Scope/permission rejection | Before I/O, record safe denial; never write into an inaccessible client audit |

Honor Retry-After even if greater than generic backoff cap: persist the actual delay (bounded parser rejects pathological values),
do not reuse Stage 1's 1h clamp to retry earlier than requested. Graph transport errors expose no body/URL/header.
HTTP controllers read stored data; sync is operator CLI/service only and never implicitly triggered by Ask Atlas.

Planned commands: `m365-probe`, `m365-sync --resource users|devices|signins --from ... --to ...`,
`m365-status`, `m365-requeue`, `m365-directory`, `correlation`, `m365-cleanup`.
Sync/probe/status report counts and safe codes. Permission-gated directory/correlation return approved DTOs to the caller;
do not save live personal output in verification artifacts. Existing bind/mapping commands retain their audit rules.
Cleanup is a separate explicit pass; expired payload is excluded from reads regardless of pass execution.
