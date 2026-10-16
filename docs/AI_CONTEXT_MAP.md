# Parasol context map

- Scope and local commands: `README.md`.
- M01–M03 implementation and follow-up: `docs/migration/M01-M03.md`.
- Original Git identities and import commits: `docs/migration/sources.json`, `IMPORT.md`.
- Known inherited Atlas failures: `docs/migration/BASELINE.md`, `atlas-baseline.json`.
- Root build orchestration: `scripts/tasks.mjs`; CI: `.github/workflows/ci.yml`.
- Atlas entry points and module map: `apps/atlas/docs/AI_CONTEXT_MAP.md`.
- CRM architecture: `apps/crm/README.md`, `apps/crm/CLAUDE.md`, `apps/crm/docs/adr`.

Read only the relevant module and tests. Do not load credential files or large historical verification archives wholesale.
