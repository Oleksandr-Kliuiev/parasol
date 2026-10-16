# Parasol context map

- Scope and local commands: `README.md`.
- M01–M03 implementation and follow-up: `docs/migration/M01-M03.md`.
- Customer identity / M04: `docs/migration/M04-CUSTOMER-IDENTITY.md`; Atlas `apps/api/src/db/clients.ts`, CRM `src/Integrations/Crm.Integrations.Core/Parasol`, shared fixture `contracts/customer-identity`.
- Original Git identities and import commits: `docs/migration/sources.json`, `IMPORT.md`.
- Strict Atlas tests and native fixture setup: `docs/testing/ATLAS.md`.
- Historical import failures (no longer an exception mechanism): `docs/migration/BASELINE.md`, `atlas-baseline.json`.
- Root build orchestration: `scripts/tasks.mjs`; CI: `.github/workflows/ci.yml`.
- Atlas entry points and module map: `apps/atlas/docs/AI_CONTEXT_MAP.md`.
- CRM architecture: `apps/crm/README.md`, `apps/crm/CLAUDE.md`, `apps/crm/docs/adr`.

Read only the relevant module and tests. Do not load credential files or large historical verification archives wholesale.
