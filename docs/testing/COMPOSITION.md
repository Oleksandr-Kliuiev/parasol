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

The six scenarios form one synthetic workflow. A failed earlier action can also fail later
durability assertions; the first failure is retained rather than retried or hidden by skips.

## Ownership and retained evidence

Every run has new credentials, loopback ports and Docker ownership labels. Database
commands verify the container label and loopback binding before use; destructive cleanup
uses the verified immutable container ID. The owner-only fixture control is a local CLI
with an operation allowlist, never a product endpoint or arbitrary SQL interface.

CRM Web and Worker use separate restricted SQL roles. Atlas uses the existing confined
runtime role, without superuser, bypass-RLS, role membership or relation ownership. The
gate verifies these facts before browser acceptance and again with durable evidence.

Application subprocess groups are owned and bounded. CRM readiness uses a newly generated,
run-specific certificate trusted only by the launcher; no system trust/keychain change is
made. Private credentials, cookies, documents and Data Protection keys are removed only
after owned resources are confirmed stopped. Unrelated processes and containers are untouched.

`report.json` contains bounded synthetic counts, fixed failure classifications and cleanup
status. Acceptance requires a build in the same invocation, all six browser scenarios with
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
Repeat the full command after the concurrent strict Atlas run releases its compiled-artifact
freeze, before closing M13. The separate complete Atlas PostgreSQL/browser results remain
pending in the M12 record.
