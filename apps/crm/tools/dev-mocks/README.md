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

The ticket routes themselves (`/api/v3/tickets/{id}` GET and POST, `/tickets/{id}/comments` GET and POST, `/tickets/lastmodified`, `POST /tickets/{id}/workhours`) are in `atera-tickets.mjs`; a comment or a change moves the ticket's `TicketLastModified`. The agents with their inventory and the Windows updates (`GET /agents/{DeviceGuid}/installed-patches` and `/available-patches`, camel case as Atera's OpenAPI file has it; `404` for an unknown DeviceGuid) are in `atera-devices.mjs`. The alert list honours `alertStatus` (`Open`: not archived, `Resolved`: archived), and an alert can be read (`GET /alerts/{id}`), resolved (`PUT /alerts/{id}`, no body: it is archived) and deleted (`DELETE /alerts/{id}`), as Atera's API v3 describes them (M40).

## Huntress and CloudAlly stubs (M40.S)

`huntress.mjs` and `cloudally.mjs` stand in for the next integrations before any code reads them (Huntress in M41, CloudAlly in M42). They hold synthetic data only and are deliberately small: what public sources agree on, with the rest left for M41/M42 to confirm against each vendor's own reference.

| Route | Answer |
|-------|--------|
| `GET /huntress/v1/account`, `/huntress/v1/organizations`, `/huntress/v1/agents` (`organization_id`, `limit` ≤ 500, `page` or `page_token`), `/huntress/v1/agents/{id}` | HTTP Basic auth required (`401` without it); lists answer `{ <items>, pagination }` with both `next_page` and `next_page_token`, since sources disagree on Huntress's paging. Two organizations, three agents. |
| `POST /cloudally/auth/partner` (`clientId`, `clientSecret`), `POST /cloudally/auth/refresh` | `200` with a synthetic `accessToken`; `400` without the client's id and secret. |
| `GET /cloudally/v1/partners/tasks` | Bearer token required (`401` otherwise); three Microsoft 365 backup tasks: one succeeded, one failed, one paused. |

An unknown `CustomerID` or a body that is not a JSON object answers `400`. The organization numbers are unique within one start of the mock; a database shared between runs (end-to-end tests) may still hold an organization with the same number from an earlier run, so a test that must be sure passes its own `BusinessNumber`.

Data lives in memory and resets on restart. Never point test or production hosts at it.
