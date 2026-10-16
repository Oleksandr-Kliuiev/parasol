# Parasol context map

- Scope and local commands: `README.md`.
- Product readiness, current gaps and local pilot gates: `docs/PRODUCT_READINESS.md`.
- M01–M03 implementation and follow-up: `docs/migration/M01-M03.md`.
- Customer identity / M04: `docs/migration/M04-CUSTOMER-IDENTITY.md`; Atlas `apps/api/src/db/clients.ts`, CRM `src/Integrations/Crm.Integrations.Core/Parasol`, shared fixture `contracts/customer-identity`.
- Unified entry, roles and customer workspace / M05: `docs/migration/M05-WORKSPACE.md`; CRM `Parasol/AtlasWorkspace*`, `web/src/features/parasol`, `Auth/AuthenticationSetup.cs`, `Http/DataProtectionSetup.cs`.
- VPS document storage / M06: `docs/migration/M06-VPS-DOCUMENTS.md`; CRM `Documents/FileSystemDocumentStore.cs`, ADR-026, runbook 16.
- VPS deployment / M07: `deploy/hostinger/README.md`, `docs/migration/M07-HOSTINGER.md`; Compose, host configuration, restic and isolated recovery tooling.
- Customer mapping UI / M08: `docs/migration/M08-CUSTOMER-MAPPING-UI.md`; CRM `web/src/features/parasol/CustomerIdentity*`, identity import validation and explicit link correction.
- Employee-scoped Atlas directory / M09: `docs/migration/M09-ATLAS-DIRECTORY.md`; CRM `Parasol/Atlas{ReadClient,IdentityReader}`, `web/src/features/parasol/atlasIdentitySource.ts` and the mapping screen.
- Devices and active observations / M10: `docs/migration/M10-CUSTOMER-TECHNICAL-DETAILS.md`; CRM `Parasol/Atlas{WorkspaceContracts,ProjectionJson,DeviceProjection,ObservationProjection,WorkspaceProjection}`, frontend `CustomerTechnicalDetails.tsx`, `workspaceContract.ts`, synthetic contract `contracts/customer-workspace`.
- Full customer observation queue / M11: `docs/migration/M11-OBSERVATION-QUEUE.md`; CRM `Parasol/AtlasObservation{Queue*,Cursor}`, frontend `ObservationQueue.tsx`, `observationQueueContract.ts`, shared `technicalContract.ts` and `ObservationRows.tsx`.
- Observation to assigned CRM work / M12: `docs/migration/M12-OBSERVATION-WORK.md`; CRM `Parasol/AtlasObservation{SourceReader,Task*}`, `CustomerIdentityGuard`, Activities `SourceTask*` and Customers read-only organization lease; frontend `ObservationTaskDialog.tsx`, `AtlasTaskSourceButton.tsx`.
- Actual local CRM/Atlas composition / M13: `docs/testing/COMPOSITION.md`; `tools/composition`, `web/e2e-composition`; synthetic acceptance evidence in `docs/testing/evidence/composition-2026-10-16.json`.
- Original Git identities and import commits: `docs/migration/sources.json`, `IMPORT.md`.
- Strict Atlas tests and native fixture setup: `docs/testing/ATLAS.md`.
- Historical import failures (no longer an exception mechanism): `docs/migration/BASELINE.md`, `atlas-baseline.json`.
- Root build orchestration: `scripts/tasks.mjs`; CI: `.github/workflows/ci.yml`.
- Atlas entry points and module map: `apps/atlas/docs/AI_CONTEXT_MAP.md`.
- CRM architecture: `apps/crm/README.md`, `apps/crm/CLAUDE.md`, `apps/crm/docs/adr`.

Read only the relevant module and tests. Do not load credential files or large historical verification archives wholesale.
