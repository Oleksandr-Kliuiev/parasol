# Dev mocks

`external-apis.mjs` is one server that routes to a module per vendor: `poweroffice.mjs` imitates PowerOffice Go API v2 (token, Customers, ContactPersons, Products, SalesOrders, OutgoingInvoices; create and JSON Patch), `atera.mjs` with its seed data in `atera-data.mjs` imitates Atera API v3 (customers, contacts, tickets with work hours, agents, alerts, customer custom values; creating contacts and tickets) and `brreg.mjs` the Brønnøysund registry, so the mapping screen, the service tab, time import, registry lookup and outbound sync can be tried — and the end-to-end tests run — without API keys or internet. Sample data is generated fresh on every start; the Atera customers carry the same organization numbers as the PowerOffice ones, so both link to the same organizations. The Atera stand-in accepts either `X-API-KEY` or `Authorization: Bearer <token>` (M39.0), like `Integrations:Atera:Authentication`.

```bash
node tools/dev-mocks/external-apis.mjs
```

Start the hosts pointing at it (the `crm-web-mocks` entry in `.claude/launch.json` does the same for crm-web):

```bash
dotnet run --project src/Hosts/Crm.Worker --launch-profile http -- --Integrations:PowerOffice:Enabled=true --Integrations:PowerOffice:ApplicationKey=mock --Integrations:PowerOffice:ClientKey=mock --Integrations:PowerOffice:SubscriptionKey=mock --Integrations:PowerOffice:BaseUrl=http://localhost:5299/v2/ --Integrations:PowerOffice:TokenUrl=http://localhost:5299/OAuth/Token --Integrations:PowerOffice:WriteEnabled=true --Integrations:Brreg:BaseUrl=http://localhost:5299/enhetsregisteret/api/ --Integrations:Atera:Enabled=true --Integrations:Atera:ApiKey=mock --Integrations:Atera:BaseUrl=http://localhost:5299/api/v3/ --Integrations:Atera:WriteEnabled=true --Integrations:Atera:SlaCustomFieldName=SLA
```

The worker runs the syncs on their crons; to see data at once, trigger the jobs from Administration → Background jobs.

## Atera control routes (tests only)

A test can give the Atera stand-in data of its own and take an alert away again, to see the CRM open, keep and resolve it. These routes are not part of Atera's API and need no `X-API-KEY`; bodies are JSON objects with Atera's own field names, merged over the defaults shown.

| Route | Body | Answer |
|-------|------|--------|
| `POST /_mock/atera/customers` | `CustomerName`, `BusinessNumber`, any other customer field; all optional | `201` with the customer: a new `CustomerID` and, unless given, an organization number no other customer of this run has. It starts with 8, so the registry stand-in knows the company and the CRM can create the organization; link it as usual (customer sync by organization number, or the mapping screen). |
| `POST /_mock/atera/agents` | `CustomerID` (required), `MachineName`, `OSType`, `OS`, `Online`, `LastSeen`, any other agent field of API v3 (`VendorSerialNumber`, `MacAddresses`, `CurrentLoggedUsers`, …), and `InstalledPatches` / `AvailablePatches` (what the patch routes answer) | `201` with the agent and its new `AgentID`; unless given, a `DeviceGuid`, an `AppViewUrl` on `atera.example.invalid`, synthetic hardware, addresses and logged-in user, and for a Windows agent two installed updates and one available (M40). |
| `POST /_mock/atera/agents/{AgentID}` | any agent fields | `200`: the fields are merged into the agent — it goes silent (`Online: false`, an old `LastSeen`), is renamed, reports other keys. |
| `DELETE /_mock/atera/agents/{AgentID}` | — | `204`: the agent is gone in "Atera", so the next complete agent read marks the device removed. |
| `POST /_mock/atera/alerts` | `CustomerID` (required), `Title`, `Severity` (`Critical` by default), `DeviceName`, `Created` | `201` with the alert and its new numeric `AlertID`; it is open and listed first. |
| `DELETE /_mock/atera/alerts/{AlertID}` | — | `204`: the alert is closed in "Atera" and leaves the open list, so the next complete alert read resolves it in the CRM. `404` for an unknown id. |
| `GET /_mock/atera/alerts/{AlertID}` | — | `200` with the alert as "Atera" holds it now (`Archived: true` after the CRM resolved it), `404` once it is deleted (M40). |
| `POST /_mock/atera/tickets` | `CustomerID` (required), any ticket field (`TicketTitle`, `TicketStatus`, `TicketPriority`, `TechnicianContactID` of a known technician, …) | `201` with the ticket and its new `TicketID`; the end user is the customer's contact. It is listed by `/tickets/lastmodified` from now on (M39.2). |
| `POST /_mock/atera/tickets/{TicketID}/comments` | `CommentText` (required) | `201`: the customer's end user writes in the ticket's conversation. |
| `GET /_mock/atera/tickets/{TicketID}` | — | `200` with the ticket, its `Comments` and its `WorkHours`: what the CRM sent, for a test to check. |
| `POST /_mock/atera/technicians` | `FullName` (required), `Email`, `TechnicianContactID` | `201` with the technician; tickets can be given to it. Known from the start: 4001 Tor Tekniker, 4002 Nina Nett and 4003 Dev Admin (`admin@dev.local`, the development sign-in's employee, so they can write as it once the ticket sync has mapped it). |
| `POST /_mock/atera/faults` | `method`, `path` (exact, or a prefix ending in `*`), `status`, `count` (1) | `204`: the next `count` Atera requests with that method and path answer `status` and change nothing — a lost answer for the action tests. |

The ticket routes themselves (`/api/v3/tickets/{id}` GET and POST, `/tickets/{id}/comments` GET and POST, `/tickets/lastmodified`, `POST /tickets/{id}/workhours`) are in `atera-tickets.mjs`; a comment or a change moves the ticket's `TicketLastModified`. The agents with their inventory and the Windows updates (`GET /agents/{DeviceGuid}/installed-patches` and `/available-patches`, camel case as Atera's OpenAPI file has it; `404` for an unknown DeviceGuid) are in `atera-devices.mjs`. The alert list honours `alertStatus` (`Open`: not archived, `Resolved`: archived), and an alert can be read (`GET /alerts/{id}`), resolved (`PUT /alerts/{id}`, no body: it is archived) and deleted (`DELETE /alerts/{id}`), as Atera's API v3 describes them (M40). `POST /api/v3/customers` creates a customer (M43, the "Connect services" wizard, and the mapping screen's export): `CustomerName` is required, field names in any case, and the answer is `{ ActionID }`, Atera's way of naming the new id; the customer is listed and readable from then on.

## Huntress (M41)

`huntress.mjs`, with its seed data in `huntress-data.mjs`, imitates Huntress API v1 under `/huntress/v1` as Huntress's own reference describes it (OpenAPI at `https://api.huntress.io/v1/swagger_doc.json`): every API route wants HTTP Basic auth (Base64 of `key:secret`, `401 { "errors": ["Unauthorized"] }` otherwise); a list answers `{ <plural>: [...], pagination }` with `limit` (10 by default, at most 500) and an opaque `page_token`, `pagination` naming `next_page_token` and `next_page_url` only while another page exists; a single record answers `{ <singular>: {...} }`; an unknown id `404`, a known path with another method `405`. The seed: the account, two organizations (Fjord IT AS, Havbris Test AS), five agents (the server SRV-01, PC-17 whose Defender is `Unhealthy`, PC-22 on an older agent version, LAPTOP-09 silent for ten days, MAC-03), one `sent` incident report on PC-17 with an assisted and a manual remediation and a comment of the SOC, an unexpected-country-access escalation, a "Defender disabled" platform action and three monthly summary reports per organization. Start crm-worker with `--Integrations:Huntress:Enabled=true --Integrations:Huntress:ApiKey=mock --Integrations:Huntress:ApiSecret=mock --Integrations:Huntress:BaseUrl=http://localhost:5299/huntress/v1/`, and for actions also `--Integrations:Huntress:WriteEnabled=true` and the kinds in `--Integrations:Huntress:EnabledActions:0=incident.approve` (and so on).

| Route | Answer |
|-------|--------|
| `POST /organizations` (`name`, `key`; M43) | `201 { organization }`; `422` without a name or key, with one longer than 256 characters, or with a key another organization has. |
| `GET /account`, `GET /organizations` (`name`, `key`), `GET /organizations/{id}` | The account; the organizations with `agents_count` and `incident_reports_count` counted from the stand-in's records; one organization with `actual_usages`: `edr` (billable agents, unresponsive — no callback for 7 days —, outdated — below the newest version of its platform in the account —, isolated), `itdr`, `sat`. |
| `GET /agents` (`organization_id`, `platform`, `hostname`, `os`, `version`), `GET /agents/{id}`, `DELETE /agents/{id}` | Agents with every field the reference names (`defender_status`, `defender_substatus`, `defender_policy_status`, `last_survey_at`, `firewall_status`, `version`, `serial_number`, `mac_addresses`, …). Uninstall answers `204` and the agent is gone at once (`404` afterwards). |
| `POST /agents/{id}/isolation` (`reason`, `strict_isolation`), `DELETE /agents/{id}/isolation` | `201 { agent }` with `firewall_status` `Pending Isolation`, or `200` with the bare agent `Pending Release` (as the reference answers it); the next read of the agent shows `Isolated` or `Disabled`. `409` when the host is isolated (or about to be) already, or is not isolated for a release. |
| `GET /incident_reports` (`status`, `severity`, `platform`, `organization_id`, `agent_id`, `indicator_type`), `GET /incident_reports/{id}` | Reports with `remediations: { total_count, has_more, items }` (the first ten), `indicator_types`, `indicator_counts`, `sent_at`, `status_updated_at`, `updated_at` (moved by every change). A `draft` (back at the SOC) is never listed, only read by id. |
| `GET /incident_reports/{id}/remediations` (`types[]`, `statuses[]`), `GET …/remediations/{rid}`, `POST …/remediations/{rid}/completion` (`completed`) | Every step; marking a `manual` step done sets `completed` and `completed_at` without approving it, undoing returns it to `approved` or `unapproved` as it was. `409` for a step Huntress carries out itself, `422` without a boolean `completed`. |
| `POST …/remediations/bulk_approval`, `POST …/remediations/bulk_rejection` (`comment`, `useful`, `reason`) | Approval: every `unapproved` step becomes `approved` (by the key's user), `201 { incident_report }`. Rejection: the report becomes a `draft` and its waiting steps `cancelled`, `201` without a body; `422` without a comment (≤ 2048) or a boolean `useful`, or with a reason Huntress does not know. Both `409` unless the report is `sent`. |
| `POST /incident_reports/{id}/resolution`, `GET` and `POST /incident_reports/{id}/comments` (`body`) | Resolution: `closed` with `closed_at`, `201 { incident_report }`; `409` unless the report is `sent` and no step waits for approval. A comment (≤ 2048, `422` otherwise) is signed by the key's user. The stand-in never closes a report by itself. |
| `GET /escalations`, `GET /platform_actions` (`status`, `severity`, `subtype`, `organization_id`), `GET /escalations/{id}`, `GET /platform_actions/{id}` | Lists without entities; a single one with `entities: { total_count, has_more, items }` (`Agent` with `details.hostname`, `Identity` with `display_name`). |
| `POST /escalations/{id}/resolution` (`determination`, `scope`, …) | `resolved` with `resolved_at`, `201 { escalation, resolution_method }` (`rule` with a determination, `dismiss` for an unwanted-access escalation without one, `direct` otherwise); `409` when resolved already, `400` for a determination or scope Huntress does not know. |
| `GET /reports` (`type`, `period_min`, `period_max`, `organization_id`), `GET /reports/{id}` | Monthly summaries with `period` `YYYY-MM-DD...YYYY-MM-DD`, a few figures and a PDF `url` on `reports.example.invalid`. |

### Huntress control routes (tests only)

Like Atera's: not part of Huntress's API and not behind its key; bodies are JSON objects with Huntress's own field names, merged over the defaults; a missing required field or a body that is not an object answers `400`.

| Route | Body | Answer |
|-------|------|--------|
| `POST /_mock/huntress/organizations` | any organization field | `201` with a new organization (a unique name unless given). |
| `GET /_mock/huntress/organizations` (`key`) | — | `200`: the organizations (with the key), each with `posted.created` — the name and key the CRM sent when it created it (M43). |
| `POST /_mock/huntress/reports` | `organization_id` (required), `period_start` (the first day of the month, last month by default), any report field | `201` with a monthly summary report of the organization. |
| `POST /_mock/huntress/agents` | `organization_id` (required), any agent field | `201` with the agent: healthy, current, calling back now unless the body says otherwise. |
| `POST /_mock/huntress/agents/{id}`, `DELETE /_mock/huntress/agents/{id}`, `GET /_mock/huntress/agents/{id}` | any agent fields | The fields merged (it goes silent, Defender off, another organization); gone; or the agent as held now with `pending_firewall_status` and `posted` (the last `isolation` body, `release`, `uninstalled`) — an uninstalled agent answers `404` with `posted`. |
| `POST /_mock/huntress/incidents` | `organization_id` (required), `agent_id`, `severity` (`high`), `status` (`sent`), `subject`, `summary`, `remediations: [{ type, action, status, parameters }]` (one assisted and one manual, unapproved) | `201` with the report and every step. |
| `POST /_mock/huntress/incidents/{id}`, `GET /_mock/huntress/incidents/{id}` | any report field; `remediations` replaces the plan | The report changed (`status: "closed"` sets `closed_at`); or the report as held now with every step, its `comments` and `posted` (the last `approval`, `rejection`, `completion`, `resolution` and `comment` the CRM sent). |
| `POST /_mock/huntress/incidents/{id}/comments` | `body` (required) | `201`: Huntress's SOC comments on the report. |
| `POST /_mock/huntress/escalations`, `POST /_mock/huntress/platform-actions` | `organization_ids` (required, may be empty), `type_code`, `type`, `subject`, `severity` (`high`), `status` (`open`), `entities` (reference items, or `{ "agent_id": … }` for an agent of the stand-in) | `201` with the notice and its entities; an escalation is an unexpected-country access and a platform action a disabled Defender unless the body says otherwise. |
| `POST /_mock/huntress/escalations/{id}`, `…/platform-actions/{id}`, `GET` of both | any fields | The fields merged (`status: "resolved"` sets `resolved_at`); or the notice as held now with `posted` (the last `resolution` body). |
| `POST /_mock/huntress/faults` | `method`, `path` (exact, or a prefix ending in `*`, e.g. `/huntress/v1/agents*`), `status`, `count` (1) | `204`: the next `count` Huntress requests with that method and path answer `status` and change nothing. |

An unknown `CustomerID` or a body that is not a JSON object answers `400`. The organization numbers are unique within one start of the mock; a database shared between runs (end-to-end tests) may still hold an organization with the same number from an earlier run, so a test that must be sure passes its own `BusinessNumber`.

## CloudAlly partner API v2 (M42)

`cloudally.mjs` follows CloudAlly's own reference (api.cloudally.com/documentation, "Authentication v2" and "Management v2"; M42 document, § API). Set `Integrations:CloudAlly:BaseUrl` to `http://localhost:5299/cloudally/` with any `ClientId`, `ClientSecret`, `Email` and `Password`. It starts with two accounts — "Fjord IT AS" (a mailbox whose backup failed, a user not in the backup) and "Havbris Test AS" (a paused SharePoint backup) — that link to customers on the mapping screen like any CloudAlly account.

| Route | Answer |
|-------|--------|
| `POST /cloudally/v2/auth/partner` (headers `client-id`, `client-secret`; `{email, password}`), `POST /cloudally/v2/auth/refresh` (`{refreshToken}`) | `200` with `accessToken`, `expiresIn` 3600, `refreshToken`, `refreshTokenExpiresIn`; `401 {errorMessage}` without the headers or credentials. |
| `GET /cloudally/v2/resellers/details`, `/accounts`, `/accounts/backup-tasks`, `/accounts/backup-statuses`, `/bills` | Bearer token required (`403` with an empty body otherwise, as CloudAlly answers); pages `{page, totalPages, total, nextPageToken, data}` from `page` 1 with `pageSize` (20 by default); the statuses also follow `nextPageToken`. Statuses carry `yyyyMMddHHmmss` texts; a failed backup has a last attempt after its last success and an error with a help link. |
| `GET /cloudally/v2/resellers/accounts/{account}/backup-tasks/{task}` | The task with its `entities` (mailboxes, OneDrives, sites, teams), `NOTACTIVE` ones too. |
| `POST …/backup-tasks/{task}/backupNow`, `…/entities/{entity}/backupNow` | `{success: true}`; the entities are backed up "now". |
| `POST …/backup-tasks/{task}/pause`, `…/activate`, `…/entities/{entity}/activate` | `{success: true}`; the task is paused or active again, the entity is added (waiting for its first backup). |
| `POST /cloudally/v2/resellers/accounts/{account}/recovery/restore`, `/export` | `400` without `taskId`, `account`, `source`, `date`; else `{needRedirect: false, …}` (restore; `needRedirect: true` for an account made with `restoreNeedsSignIn`) or `{}` (export). |
| `DELETE /cloudally/v2/resellers/accounts/{account}` | `{success: true}`; the account is deleted and no longer listed. |
| `POST /cloudally/v2/resellers/accounts` (headers `client-id`, `client-secret`; `{email, password, displayName, region}`; M43) | `200` with the new account (`TRIAL`, no backup tasks until the customer's Microsoft 365 consent in CloudAlly); `401` without the headers, `400` without an address or password, with a region CloudAlly does not know, or with an address another account has. The log keeps that a password came, never the password. |

Control routes for tests (not CloudAlly's API, no token):

| Route | Body | Answer |
|-------|------|--------|
| `POST /_mock/cloudally/accounts` | `name`, `domain`, `region` (`EU`), `users` (`[{email, fullName, state, error, onedrive}]`; `state` `ok`, `failed`, `late`, `paused` or `notactive`), `sites`, `teams` (`[{name, state}]`), `services` (sources; all four by default), `pausedServices`, `restoreNeedsSignIn` | `201` with the account, its tasks and their entities (ids for links and actions). |
| `GET /_mock/cloudally/accounts/{account}` | — | `200` with the account as "CloudAlly" holds it now. |
| `POST /_mock/cloudally/entities/{entity}` | `state`, `error` | `200`: the entity's backup is now in that state. |
| `GET /_mock/cloudally/log` | — | `200`: every change the CRM asked for (method, path, body), oldest first. |

## Teams channels (M43)

`teams.mjs` stands in for the Power Automate Workflows webhooks of the team channels: `POST /teams/{channel}` (`sales`, `finance`, `operations`) takes the message the CRM posts — `{type: "message", attachments: [{contentType: "application/vnd.microsoft.card.adaptive", content}]}` — and answers `202`; anything else `400`. Start crm-worker with `--Integrations:MicrosoftGraph:Teams:Enabled=true --Integrations:MicrosoftGraph:Teams:Channels:Operations=http://localhost:5299/teams/operations` (a loopback `http` address is the only one allowed outside the Workflows hosts) to see urgent alerts arrive. `GET /_mock/teams/posts?channel=operations` lists the cards received, oldest first, flattened to `{channel, at, title, text, facts: [{title, value}], link, linkText}`; `DELETE /_mock/teams/posts` empties the list.

Data lives in memory and resets on restart. Never point test or production hosts at it.
