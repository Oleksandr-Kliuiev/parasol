# Synthetic Atlas workspace contract

`atlas-context.v1.example.json` is a synthetic `ClientContextV1` input to the CRM BFF
projection. It follows `apps/atlas/packages/core/contracts.ts`; the client/workspace
scope is repeated in every graph and observation row.

It contains two devices with the same hostname but distinct IDs. Only one has confirmed
Atera/Huntress agent links. The observation page covers a critical observation with
MONITOR routing, an acknowledged high observation with no entity, and a medium observation
whose device has no confirmed source link. This exercises urgency and exact-ID attribution.
Stale and missing snapshots exercise source coverage independently of the active queue.

All identifiers, contacts and private-field markers are synthetic. Contacts, person
references, connection IDs, source IDs and raw resource items must never appear in the
projected BFF response. The fixture is consumed by CRM unit and SQL integration tests.
Browser tests use `web/src/test/atlasWorkspace.ts`, a separate projected response;
they do not call external providers or an existing Atlas installation.
