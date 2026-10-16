# Stage 4 authority and DTO contracts

## Authentication and permissions

Public services take a bearer credential, selected clientId and connectionId, never Actor/permissions supplied by DTOs.
Only the accepted bearer-hash lookup policy reads the current token; clear the digest before actor lookup. A small shared
packages/auth/transaction-token.ts may extract Stage3 current-token lookup verbatim for both domains. This refactor must
preserve Stage3 token-expiry/fence semantics and original ApiToken policies/grants; no new credential visibility/view/definer.

Every admission and success publication runs under the installed workspace authority fence. After ALL locks, read
clock_timestamp in UTC and recheck this token (revocation, exact current expiry), ACTIVE actor and all-of permissions
on ONE membership for the chosen client. Authentication hints from an earlier transaction confer no authority.

| Operation | All permissions on that client |
|---|---|
| status and summary read | context:read + poweroffice:read |
| sync, recover | context:read + poweroffice:read + poweroffice:sync |
| purge admission | context:read + poweroffice:read + poweroffice:maintain |

New permissions join the existing DB permission CHECK through an additive migration; existing memberships are not
expanded. No default grants, workspace-admin shortcut, model-supplied scope, cross-client union or actor snapshot bypass.
A denial after successful authentication writes exactly one workspace SecurityAuditEvent with requested client as safe
text; no client audit leakage. If that audit fails, refuse with a fixed audit/conflict code and zero effects. An expired
caller after the last lock refuses that public transaction without mutation, port call or client audit. Only a previously
issued private failure continuation may later close its owned claim under03, without financial data. Successful reads audit atomically before
return; audit failure returns no financial payload. Known DB conflicts return a fixed code, not raw SQL.

## Internal normalized DTO

All objects are strict whitelists with runtime validation; no vendor object spread. These are Atlas DTOs, not vendor wire schemas.
The built-in binding is externalTenantId=synthetic-po-<lowercase UUID> and secretRef=fixture://poweroffice/<same UUID>;
boundBy/boundAt are non-null. The secret reference is never resolved and never returned/audited.

| DTO | Exact fields and bounds |
|---|---|
| Export header | synthetic:true, companyKey (exact bound synthetic ID), exportId UUID, asOf UTC instant supplied by the claim, totalCount integer0..10000 |
| Invoice | id UUID; kind INVOICE or CREDIT_NOTE; currency from NOK,EUR,USD,GBP,SEK,DKK; gross and outstanding canonical nonnegative decimal strings; dueDate Gregorian YYYY-MM-DD |
| Page | header; ordinal integer1..100; items array0..100; hasMore boolean |

At most100pages and10000distinct IDs,100items/page,512KiB canonical bytes/page and8MiB total. Every non-final page has100
items; a final empty page is permitted only for totalCount0/ordinal1. Every page repeats the exact header/export identity;
ordinals are contiguous, final count matches totalCount, no repeated ID or unexpected field. Bound mismatch is refused.
Amounts have exactly2fractional digits, no sign/exponent/leading zeros except0, maximum15integer digits; outstanding<=gross.
Unknown currency, overpayment/negative balance or unsupported schema fails the export visibly. Conversion to these DTOs
from a future vendor contract needs its own reviewed semantics; there is no inferred currency conversion or coercion.

Validated DTOs and completed aggregate facts are detached immutable values; later caller mutation cannot change them.
The exact aggregate object is {totalCount,currencies}; currencies is a lexically sorted array of unique nonempty currency
groups, each containing exactly currency,count,openInvoiceCount,overdueInvoiceCount,creditNoteCount,
outstandingInvoiceAmount,outstandingCreditAmount. totalCount equals sum(count), lies0..10000; each present group count>=1.
Known empty is {totalCount:0,currencies:[]}; missing/unavailable/expired summary is null. TS and SQL validate this same shape.
Use BigInt minor units, never floating-point sums. A normalized credit note carries positive magnitudes but remains
separate by kind. Aggregate by currency in lexical order, with count, openInvoiceCount, overdueInvoiceCount,
creditNoteCount, outstandingInvoiceAmount and outstandingCreditAmount. count includes both kinds; openInvoiceCount<=count-creditNoteCount
and overdueInvoiceCount<=openInvoiceCount. Counts0..10000; sums canonical2-decimal strings
with at most19integer digits. Totals never combine currencies or subtract credits. An invoice is open when outstanding>0,
overdue when also dueDate<businessDate. businessDate is the Europe/Oslo date of claim DB asOf, fixed throughout the export;
validate calendar dates without local-runtime timezone coercion. Do not infer a paid state from missing data.

## Public interface

GET /clients/:clientId/poweroffice/:connectionId/status and /summary are dedicated reads. A route-specific Stage4
dispatch/auth adapter receives the Authorization bearer as a private credential and calls the new service directly; it
does not enter the legacy Actor-only Gateway/ToolReaders or ToolExecution ledger. It owns parsing and fixed synthetic
auth/error envelopes, including missing/malformed/expired bearer401; it does not reuse the legacy bare401 response.
Only the service owns fresh authority, workspace denial and atomic read-success auditing. No earlier client audit or
ledger STARTED/FAILED write occurs. Credentials/digests never become DTO/Actor fields, logs or audit.
No PowerOffice tool is registered/advertised/executable through /tools/execute; existing discovery/name grammar/tools
and legacy auth/ledger/audit behavior stay unchanged. A future financial Gateway tool needs separately reviewed bearer,
ledger, audit and AI privacy semantics; spelling or policy changes alone cannot admit it.
CLI: poweroffice-status, poweroffice-summary, poweroffice-sync, poweroffice-recover, poweroffice-cleanup; strict flag
allowlists, required explicit --client and --connection; tokens come from the existing protected environment convention,
never argv. No source/tenant/currency/clock/body/raw output flag. Cleanup selects that connection only.

Summary DTO: connectionId, status MISSING|FRESH|STALE|ERROR|UNAVAILABLE|EXPIRED, asOf:null|UTC, expiresAt:null|UTC,
businessDate:null|date, summary:null|bounded aggregates, lastAttemptState NEVER_SYNCED|ACTIVE|SUCCEEDED|FAILED|ABANDONED,
lastCompletedState:null|SUCCEEDED|FAILED|ABANDONED, lastCompletedErrorCode:null|fixed code,
safeErrorCode:null|fixed code, synthetic:true. lastCompleted fields persist unchanged during an ACTIVE claim;04 defines
status and safeErrorCode precedence. Public failure codes use their full POWEROFFICE_ spelling where listed below.
No invoice or external-company ID, token, secret reference, nonce, cursor, private path or raw vendor message is exposed.
Status DTO omits summary/amounts; it may include local attemptId/sequence/timestamps. All envelopes/errors include synthetic:true.
HTTP Cache-Control:no-store. CLI exits0 on successful reads/complete sync/recover/purge,1 on operation failure,2 on usage/config;
HTTP401 invalid auth,403 scope/permission,404 invisible/unknown connection,409 busy/conflict,503 mode/binding/readiness failure.

Fixed domain codes: POWEROFFICE_DISABLED, POWEROFFICE_MODE_UNSUPPORTED, POWEROFFICE_AUTHENTICATION_FAILED,
SCOPE_DENIED, PERMISSION_DENIED, POWEROFFICE_CONNECTION_UNAVAILABLE, POWEROFFICE_BINDING_CHANGED,
POWEROFFICE_DTO_INVALID, POWEROFFICE_EXPORT_INCOMPLETE, POWEROFFICE_SOURCE_FAILED, POWEROFFICE_SYNC_BUSY,
POWEROFFICE_SYNC_LIMIT, POWEROFFICE_DEADLINE, POWEROFFICE_RECOVERY_NOT_DUE, POWEROFFICE_CLAIM_STALE,
POWEROFFICE_AUDIT_FAILED, POWEROFFICE_DB_CONFLICT, POWEROFFICE_PUBLICATION_CONFLICT, POWEROFFICE_NOT_FOUND,
POWEROFFICE_SNAPSHOT_EXPIRED, POWEROFFICE_SNAPSHOT_STALE, POWEROFFICE_RUNTIME_NOT_READY,
POWEROFFICE_NO_ACTIVE_ATTEMPT, POWEROFFICE_CLEANUP_TIMEOUT, POWEROFFICE_CLEANUP_FAILED, INVALID_ARGUMENTS, UNEXPECTED_ERROR.
Map unknown errors to UNEXPECTED_ERROR; safe codes/details only. Audit metadata allowlist: local connectionId, attemptId,
snapshotId, sequence, outcome and safeErrorCode only. Extend packages/audit/sanitize.ts additively for these exact keys
in S4-A; existing shared allowlisted count/tool keys are never populated by PowerOffice. sequence is an operational ordinal,
not a financial/deletion count. No amounts/counts,
source asOf/business dates, keys or hashes in audit. No usage of broad AtlasError.details to echo inputs.
