# Dev mocks

`external-apis.mjs` imitates PowerOffice Go API v2 (token, Customers, ContactPersons, Products; create and JSON Patch), Atera API v3 (customers, contacts, tickets with work hours, agents, alerts, customer custom values; creating contacts and tickets) and the Brønnøysund registry, so the mapping screen, the service tab, time import, registry lookup and outbound sync can be tried — and the end-to-end tests run — without API keys or internet. Sample data is generated fresh on every start; the Atera customers carry the same organization numbers as the PowerOffice ones, so both link to the same organizations.

```bash
node tools/dev-mocks/external-apis.mjs
```

Start the hosts pointing at it (the `crm-web-mocks` entry in `.claude/launch.json` does the same for crm-web):

```bash
dotnet run --project src/Hosts/Crm.Worker --launch-profile http -- --Integrations:PowerOffice:Enabled=true --Integrations:PowerOffice:ApplicationKey=mock --Integrations:PowerOffice:ClientKey=mock --Integrations:PowerOffice:SubscriptionKey=mock --Integrations:PowerOffice:BaseUrl=http://localhost:5299/v2/ --Integrations:PowerOffice:TokenUrl=http://localhost:5299/OAuth/Token --Integrations:PowerOffice:WriteEnabled=true --Integrations:Brreg:BaseUrl=http://localhost:5299/enhetsregisteret/api/ --Integrations:Atera:Enabled=true --Integrations:Atera:ApiKey=mock --Integrations:Atera:BaseUrl=http://localhost:5299/api/v3/ --Integrations:Atera:WriteEnabled=true --Integrations:Atera:SlaCustomFieldName=SLA
```

The worker runs the syncs on their crons; to see data at once, trigger the jobs from Administration → Background jobs.

Data lives in memory and resets on restart. Never point test or production hosts at it.
