# Local CRM–Atlas composition

This gate starts the compiled CRM Web, CRM Worker and Atlas API against fresh SQL Server
and PostgreSQL databases. Browser requests reach the actual CRM BFF, personal Atlas
credentials and restricted PostgreSQL runtime. Technical responses are not intercepted.
All data is synthetic; no working provider account, deployment or publication is involved.

## Run

Install the repository's existing Atlas/web dependencies, restore the CRM solution and
install Playwright Chromium. Node, .NET, Docker and OpenSSL must be available on PATH.
The SQL Server and PostgreSQL image digests are pinned in `tools/composition/plan.mjs`;
cache those images explicitly before running. The launcher uses `--pull=never`.

```sh
npm run test:composition:unit
npm run test:composition -- --directory /absolute/path/to/a/new/private/run-directory
```

The directory must be new, absolute, normalized and have no symlinked parents. The full
command builds Atlas, the SPA, CRM Web and Worker from the current local source. It then
migrates its owned databases, provisions restricted logins, bootstraps the Development
identities and confirms the customer mappings through the real preview/apply endpoints.
It does not reuse an existing application or database.

`--skip-build` and `--skip-browser` are diagnostic options. Their reports always have
`accepted: false`, even when the selected diagnostic stages succeed.

## Synthetic workflow

- Forty mapped CRM/Atlas clients, ten devices per client and three distinct employees.
  Admin sees all forty clients; Technician and ServiceLead each see a different twenty.
  All 120 employee/client access decisions are read through the actual application chain.
- One client has 126 active observations, including an older Critical, a Low observation
  beyond the first 100, acknowledged records, and separate resolved/suppressed history.
  Six real cursor pages must contain 126 distinct IDs and the exact severity histogram.
- Duplicate hostnames do not substitute for identity. A positive confirmed Huntress link
  resolves the exact device; an Atera-only device cannot confirm a Huntress association.
  Stale, missing and synthetic source provenance remains visible.
- Two employees assign the same observation concurrently through the UI. SQL must retain
  one Task, one permanent source receipt, one create audit and one creation outbox event.
  Personal Tasks completes that Task, adding the completion event. Replay preserves the
  completed Task, original assignee and due instant without another create or provider write.
- Membership/token revocation clears old technical content while an independently
  authorized employee continues to work. Finance cannot gain Atlas source authority through
  a generic Task; ReadOnly cannot create technical work. A ReadOnly employee may read an
  authorized source with its own configured Atlas credential and existing read permissions.
- A foreign-workspace collision fails closed. Replacing a mapping with the same source
  pair changes its LinkId and invalidates old confirmation hashes and queue cursors.
- My Day attention independently reads the forty/twenty/twenty customer sets, reports exact
  active/High/Critical totals and retains partial source coverage. The urgent preview opens
  the existing fresh M12 confirmation without creating another Task or writing to a provider.
- Local connection readiness reads real configuration/SQL for Admin and personal configuration
  for the technical employees and ReadOnly. Its local mapping review detects the intentionally
  retained unlinked collision reference. Opening and refreshing the page must leave the Atlas
  HTTP request counter and durable Task evidence unchanged; Finance receives no access.

- The actual observation Task from the handoff is linked through the UI to a synthetic saved
  ticket with exact accepted Atera customer/LinkId provenance. Another employee explicitly
  records 0.75 own hours; an identical request adopts the same time entry. Exact SQL requires
  one time row, receipt and create audit, unchanged Task assignment/status, and only the
  original two ActivityLogged events (creation and completion). The mobile dialog is tested
  in both themes with keyboard, active-modal Axe and full-page checks before/after closing.

The nine scenarios form one synthetic workflow. A failed earlier action can also fail later
durability assertions; the first failure is retained rather than retried or hidden by skips.

## Ownership and retained evidence

Every run has new credentials, loopback ports and Docker ownership labels. Database
commands verify the container label and loopback binding before use; destructive cleanup
uses the verified immutable container ID. The owner-only fixture control is a local CLI
with an operation allowlist, never a product endpoint or arbitrary SQL interface.

CRM Web and Worker use separate restricted SQL roles. Atlas uses the existing confined
runtime role, without superuser, bypass-RLS, role membership or relation ownership. The
gate verifies these facts before browser acceptance and again with durable evidence.

The transparent Atlas recorder counts forwarded Atlas requests and mutating HTTP methods.
The retained `providerWrites` field describes that counter; it is not a traffic monitor for
every external provider. Atera, PowerOffice, Graph and PartnerCenter are explicitly disabled
in this synthetic fixture and their endpoints are confined to an unused loopback address.

Application subprocess groups are owned and bounded. CRM readiness uses a newly generated,
run-specific certificate trusted only by the launcher; no system trust/keychain change is
made. Private credentials, cookies, documents and Data Protection keys are removed only
after owned resources are confirmed stopped. Unrelated processes and containers are untouched.

`report.json` contains bounded synthetic counts, fixed failure classifications and cleanup
status. Acceptance requires a build in the same invocation, all nine browser scenarios with
zero failures/skips/retries, exact durable/privacy evidence and confirmed cleanup. Stage logs
are private and redacted; browser artifacts contain synthetic fixture data. CI publishes only
the compact report, never the private state, logs, screenshots or traces.

## Limits

This gate verifies the joined local application. It does not establish working Atera,
Huntress, PowerOffice or Microsoft 365 account compatibility, Entra consent, production
traffic capacity, external backup access or VPS readiness. The strict Atlas unit/PostgreSQL/
browser gates and the CRM's existing unit, SQL, architecture and multi-browser checks remain
separate required checks. Composition does not replace or waive them.

## Local verification, 16 October 2026

The [full-build run](evidence/composition-2026-10-16.json) passed six of six browser scenarios,
with exact durable/privacy evidence, restricted runtime roles and confirmed cleanup. Eleven
launcher unit tests, composition TypeScript/ESLint, YAML parsing, history and secret checks
also passed locally. The new GitHub job has not been published or executed.

Final review strengthened the access oracle: the browser now independently requires the
Technician's first twenty and ServiceLead's last twenty clients, instead of deriving expected
access from the same manifest used to seed memberships. A subsequent
[diagnostic run](evidence/composition-acl-diagnostic-2026-10-16.json) passed all six strengthened
scenarios on the unchanged compiled applications, with exact evidence and cleanup. Its
`accepted: false` correctly records `--skip-build`; it is not another full-build acceptance.
M14 adds the seventh attention scenario. Its
[diagnostic run](evidence/composition-attention-diagnostic-2026-10-16.json) passed all seven
scenarios against the actual compiled applications, including personal 40/20/20 attention,
exact urgent counts and fresh M12 preview, with the same durable/privacy evidence and cleanup.
It also correctly records `accepted: false` because it used `--skip-build` during the strict
Atlas compiled-artifact freeze. M15 adds the eighth local-readiness scenario. Its first full
run exposed an incorrect auth-mode projection (7/8); the adapter now reads the actual auth
singleton and both mode regressions pass. Two later complete runs passed all eight scenarios.

The [previous full-build run](evidence/composition-current-2026-10-16.json) includes M17/M18
and the final customer-card/queue keyboard-refresh correction. It passed 8/8 with `accepted: true`, fresh
builds of both applications, zero skipped/unexpected/flaky tests, exact Task/receipt/audit/
outbox/privacy evidence, 555 forwarded Atlas requests, all restricted runtime roles and
confirmed cleanup. The frontend passed the full 415/415 unit suite after M17, then the affected
56/56 after the last refresh correction; these are separate runs. Current related
mock-BFF browser regressions passed 38/38. Readiness screenshots in both themes and from the actual
composition were inspected; neutral status labels are readable.

Separate complete strict Atlas unit 711/711, PostgreSQL 789/789 and browser 90/90 pass
without exceptions. [Safe evidence](evidence/atlas-strict-current-2026-10-16.json) confirms
cleanup and all 1,421 frozen source/input hashes plus exact inventory unchanged.
Composition does not substitute for these gates.
No code or workflow has been published, and the new GitHub job remains unexecuted.

M17 strengthens the accepted handoff scenario: the recipient is already on My Day before
creation and uses the explicit personal-task refresh to receive and complete the task.
The compact report above refers to that M17/M18 invocation; earlier diagnostics and
the auth-mode failure remain retained separately. Real provider accounts are unverified.

## M19 local verification, 17 October 2026

The [M19 full-build run](evidence/composition-M19-2026-10-17.json) includes M19 exact
Activity navigation and the mobile Panel header correction. It passed 8/8 with `accepted: true`,
zero skipped/unexpected/flaky cases, exact durable/privacy evidence, restricted runtime roles
and confirmed cleanup. The recorder forwarded 564 Atlas requests and no mutating requests.
The handoff now opens the exact Task and requires focus on its selected heading.

The separate full frontend suite passed 456/456 in 53 files; ESLint, app/E2E/composition
TypeScript and the 290.5/300 KB SPA budget pass. CRM browser regressions passed 49/49,
including actual SQL-backed exact-selection, concurrent edit, missing/wrong customer and
delayed-read cancellation in three engines, plus phone keyboard/Axe checks in both themes.
Existing technical BFF mocks remain explicitly synthetic; they do not replace this full
composition. SQL exact-selection/SourceTask tests passed 39/39 and architecture 94/94.

The initial browser run's 48/49 timeout remains retained. The final cancellation assertion
observes the real fetch AbortSignal before releasing the real API response, without changing
the request or its promise. A separate 3/3 diagnostic and the final 49/49 pass establish that
invariant; the original timeout cause is unproven. No retries, skips or failure exceptions
were introduced. Atlas strict source/input hashes remain unchanged from the separate
711/789/90 acceptance. No publication, deployment or live provider call occurred.

## M20 local verification, 17 October 2026

The [M20 full-build run](evidence/composition-M20-2026-10-17.json) includes versioned
complete/reopen and the native editor-close focus correction. It passed 8/8 with zero
skipped/unexpected/flaky cases, exact durable/privacy evidence, restricted runtime roles and
confirmed cleanup. The recorder forwarded 563 Atlas requests and no mutating requests.
Completion now explicitly carries the recipient's actual displayed ETag.

The [M20 acceptance summary](evidence/activity-status-M20-2026-10-17.json) records full
frontend 484/484, 56 files, SQL 38/38, architecture 94/94, all static gates, the 290.5/300 KB
SPA budget and final CRM browser 55/55 with cleanup. All 361 tested web inputs still match.
Actual two-employee browser tests cover stale/fresh complete and reopen, pending duplicate
admission, permissions and exact assignment/due/body/priority/version preservation.

The initial browser 53/55 and separate native focus diagnostic remain retained. A closed
editor left an empty, visibly animating DialogSurface in the DOM; the old raw-role gate
mistook it for an open editor and did not capture focus ownership. The correction uses
the actual editor lifecycle and keeps input/modal/hidden/inert fences. The unchanged phone
assertions now pass in both themes, including keyboard focus and Axe. No timeout increase,
retry, skip or failure exception was introduced. No live provider account or VPS was used.

## M21 local verification, 17 October 2026

The [M21 full-build run](evidence/composition-M21-2026-10-17.json) includes scoped
saved Service reads and mobile customer tab visibility. It passed 8/8, zero
skipped/unexpected/flaky cases, exact durable/privacy evidence, restricted runtime roles
and confirmed cleanup. The recorder forwarded 564 Atlas requests and no mutating requests.

The [M21 acceptance summary](evidence/saved-service-M21-2026-10-17.json) records 513/513
frontend tests in 59 files, all static gates, 371 unchanged web inputs and the 290.5/300 KB
SPA budget. CRM browser regressions passed 67/67 without retries, skips or exceptions,
including real API independent read failures, GET-only refresh and native cancellation in
three engines, existing time approval and disabled-Atera request handling, plus phone
keyboard/Axe checks in both themes. Previous SQL/architecture and Atlas strict evidence
are retained separately; their 775/1421 inputs still match and were not rerun in M21.

The initial 63/67 browser report remains retained. Axe exposed an unfocusable Tickets
scroll container; it now has a named keyboard target, visible focus and native ArrowRight
coverage. Both initial WebKit sign-in failures showed Too many requests in AuthGate.
Only the owned browser fixture API budget was aligned with existing E2E configuration;
production and composition settings remain unchanged. Raw HTTP traces of that initial
429 were not retained. No timeout increase or assertion exclusion was introduced.
No publication, deployment or live provider call occurred.

## M22 local verification, 17 October 2026

The [M22 source-build run](evidence/composition-M22-2026-10-17.json) passed all nine
scenarios, including actual Atlas observation → assigned Task → verified saved ticket →
current employee time and exact retry. It retained one time row, receipt and create audit,
the unchanged Task and precisely two ActivityLogged events; provider writes were zero.
The recorder forwarded 554 Atlas requests. Restricted roles, privacy and cleanup passed.

The [M22 summary](evidence/task-ticket-time-M22-2026-10-17.json) records CRM 911 unit,
94 architecture and 63 affected SQL tests, 559 frontend tests, static/build gates, the
291.7/300 KB budget and 67 CRM browser regressions in three engines. All passed with
zero skips/retries/exceptions. SQL uses exact current sources with only an owned loopback
fixture adapter. The 811 backend/build and 387 web inputs still match their tested hashes.
Atlas strict 711/789/90 is retained with all 1421 unchanged inputs, not rerun in M22.

Earlier seed, modal-oracle and excess-contact-event failures remain retained and are
described in M22. The first real-chain invocation passed 9/9 browser cases but was correctly
rejected by durable evidence: linking emitted a third ActivityLogged. The domain now
audits association metadata without a customer-contact event, and current SQL/domain
regressions verify that contract. No acceptance threshold was relaxed.
Concurrent period closure across all Time writers remains M23; already-closed refusal
does not prove that race resolved. No publication, deployment or live provider call occurred.

## Current M23 local verification, 17 October 2026

The [current source-build run](evidence/composition-current-2026-10-17.json) passed 9/9
with month admission active in the actual Task → ticket → own time chain. Exact durable
evidence, restricted roles, privacy and cleanup passed; 577 Atlas requests, zero
mutating requests. There were no skips, retries or flaky cases.

The [M23 summary](evidence/time-period-M23-2026-10-17.json) records 917 unit, 94 architecture,
102 affected SQL, 562 frontend and 70 CRM browser cases, all passing. The three new
real-API browser cases check closing refusal, approval, closing, a retained refused time
form, ServiceLead permissions and explicit Finance reopening. Existing 67 regressions
remain included. 824 backend/build and 389 web inputs match; all 2634 composition inputs
were unchanged through the invocation. Atlas strict 711/789/90 remains supported by its
1421 frozen inputs and exact inventory; it was not rerun. Static gates and 291.7/300 KB pass.

The first 100/101 SQL result remains retained: canceling a SQL-confirmed application-lock
wait raised SqlException. The helper now normalizes it to cancellation only for a canceled
caller token, keeping the original assertion, rollback and lock-release checks. All 102
pass after the correction. Cross-module HourBank recovery and asynchronous invoice
finalization are not established by period locks. Nothing was published or deployed.

One independent CRM browser test was corrected after composition: Date's required marker
is accepted and the submitted date is asserted. This file is not compiled into the SPA
or imported by composition. All application/composition inputs still match the accepted
run; the original 2634-input manifest was unchanged during it. The subsequent oracle
hashes are recorded separately and verified by current static/frontend and 70/70 browser
checks. Both earlier 67/70 browser reports remain retained, first for opening the customer
picker and then for the required Date label. Neither is accepted.
