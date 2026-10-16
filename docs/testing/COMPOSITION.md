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

The eight scenarios form one synthetic workflow. A failed earlier action can also fail later
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
status. Acceptance requires a build in the same invocation, all eight browser scenarios with
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

The [current full-build run](evidence/composition-current-2026-10-16.json) includes M17/M18
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
The compact report refers to this final current-source invocation; earlier diagnostics and
the auth-mode failure remain retained separately. Real provider accounts are unverified.
