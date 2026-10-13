# Microsoft 365 — Graph read adapter (Stage 2)

Stage 2 specification: [M365 Correlation pack](../../docs/stage2/README.md). First slice uses Graph v1.0 users, registered devices and bounded user sign-in evidence, with confirmed canonical mappings. Intune inventory, Lighthouse/WorkIQ and writes remain outside this slice.

S2-B implementation (mock/recorded transport only; not live-verified): `contract.ts` (fixed authority/Graph URLs, limits),
`http.ts` (GET-only Graph transport, URL/nextLink boundary, safe error classes), `auth.ts` (client_credentials token
provider, scoped token cache), `connector.ts` (Graph session: authority recheck, same-token tenant verification, one 401
recovery), DTO validators in `dto-common.ts`, `directory-dto.ts`, `signin-dto.ts`. Domain services: `packages/m365/`.

The secret behind a connection's `secretRef` is `<application ID GUID>:<client secret>`, resolved in memory only. No
credentials, permissions or live API calls are configured by this repository; S2-LIVE is a separate gate.
