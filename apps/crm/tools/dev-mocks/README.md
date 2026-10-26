# Dev mocks

`external-apis.mjs` imitates PowerOffice Go API v2 (token, Customers, ContactPersons, Products; create and JSON Patch), Atera API v3 (customers, contacts, tickets with work hours, agents, alerts, customer custom values; creating contacts and tickets — in `atera.mjs`) and the Brønnøysund registry, so the mapping screen, the service tab, time import, registry lookup and outbound sync can be tried — and the end-to-end tests run — without API keys or internet. Sample data is generated fresh on every start; the Atera customers carry the same organization numbers as the PowerOffice ones, so both link to the same organizations.

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
| `POST /_mock/atera/agents` | `CustomerID` (required), `MachineName`, `OSType`, `OS`, `Online`, `LastSeen` | `201` with the agent and its new `AgentID`. |
| `POST /_mock/atera/alerts` | `CustomerID` (required), `Title`, `Severity` (`Critical` by default), `DeviceName`, `Created` | `201` with the alert and its new numeric `AlertID`; it is open and listed first. |
| `DELETE /_mock/atera/alerts/{AlertID}` | — | `204`: the alert is closed in "Atera" and leaves the open list, so the next complete alert read resolves it in the CRM. `404` for an unknown id. |

An unknown `CustomerID` or a body that is not a JSON object answers `400`. The organization numbers are unique within one start of the mock; a database shared between runs (end-to-end tests) may still hold an organization with the same number from an earlier run, so a test that must be sure passes its own `BusinessNumber`.

Data lives in memory and resets on restart. Never point test or production hosts at it.
