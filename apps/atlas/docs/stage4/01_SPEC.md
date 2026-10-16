# Stage 4 scope and privacy

## Operator result

For one explicitly selected client and PowerOffice connection, show integration state, last synchronization outcome,
source time and expiry, and a complete bounded invoice summary grouped by currency. A successful empty export is a
known zero; a missing, failed, expired, incomplete or unavailable source is never a zero summary.

The invoice summary counts INVOICE and CREDIT_NOTE separately and reports their positive outstanding magnitudes
separately. It may identify the count of outstanding invoices past their due date. It never nets currencies, credit notes
or accounts, estimates creditworthiness, scores customers or recommends collection action. Amounts and overdue status
are normalized MOCK semantics, not a verified mapping of vendor accounting rules.

## First slice boundaries

Only built-in synthetic data behind trusted MOCK composition is implemented. The default mode is DISABLED; the only
opt-in is exact MOCK. Every public Stage4 output carries synthetic:true. Connections must be system=poweroffice,
status=FIXTURE, with recorded binding provenance, lifecycleVersion>0 and the fixed synthetic binding format in02.
A missing/mismatched binding refuses source work; no auto-binding, activation, credential resolution or onboarding exists.
Recover and cleanup are the no-source exceptions: an existing synthetically bound PowerOffice connection may be DISABLED
or have advanced lifecycleVersion; those commands close old claims/purge expired data without restoring it or reading a source.

There is no vendor HTTP adapter, token provider, OAuth request, webhook, scheduler, UI, billing write, invoice creation,
payment, reconciliation write, bank/ledger import or external message. Existing Stage3 ticket actions are not extended.
No caller-supplied script, URL, callback, SQL, port or fixture file selects source behavior. Test fault injection remains
private test code. Public documentation GETs used for architecture are not application vendor access.

## Data minimization

Persist only bounded aggregates and operational metadata. Invoice IDs exist transiently for duplicate detection during
one export; they, customer IDs, names, organization numbers, emails, addresses, account numbers, invoice numbers,
line items, free text, documents, raw responses, next links and credentials never enter persistent business tables,
audit, logs, telemetry, public errors or prompts. Strict internal DTO validation rejects extra fields before aggregation.
The opaque connection binding ID is private operational metadata, not an organization number.

Aggregate summaries remain sensitive business data. Dedicated PowerOffice permissions and dedicated tables/read paths
prevent context:read alone from exposing them. ClientContextV1, ResourceSnapshot, ExternalEntity, RawEvent, M365
correlation, observations, Decisions inputs and existing Gateway tools retain their accepted contracts unchanged.
No PowerOffice Gateway tool is added in this slice; financial tool dispatch/ledger/AI exposure requires a separate
reviewed contract. Dedicated API and operator CLI supply the first read path. No cross-client/MSP-wide summary or search exists. Workspace-admin rights do not imply client business permissions.

## Freshness and retention

A complete snapshot is fresh for15minutes from its source asOf. It expires24hours after publication; expired summary
payloads are hidden immediately by read-time DB-clock checks even if maintenance is late. Partial pages never become a
snapshot. Refresh failure preserves an unexpired last complete snapshot as STALE with visible safe failure status.
A later ACTIVE claim does not clear that failure; only a complete successful publication does. Expired/purged prior
success is EXPIRED/null even after a later failure or ACTIVE claim; never-successful states remain MISSING/ERROR as04.
Physical purge is explicit bounded maintenance (03); future LIVE requires an owner-approved operational schedule and
retention/privacy admission. Synthetic test evidence does not establish operational or production readiness.
