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
- Actual local CRM/Atlas composition / M13: `docs/testing/COMPOSITION.md`; `tools/composition`, `web/e2e-composition`; current synthetic acceptance evidence in `docs/testing/evidence/composition-current-2026-10-17.json`.
- Personal Atlas attention in My Day / M14: `docs/migration/M14-ATLAS-ATTENTION.md`; CRM `Parasol/AtlasAttention*`, frontend `AtlasAttentionPanel.tsx` and `atlasAttentionContract.ts`; actual composition `04-attention.spec.ts`.
- Read-only local connection readiness / M15: `docs/migration/M15-LOCAL-READINESS.md`; CRM `Parasol/LocalReadiness*` and Web `LocalReadinessFlagsReader.cs`; frontend `ConnectionReadinessPage.tsx` / `localReadinessContract.ts`; actual composition `05-readiness.spec.ts`.
- Existing Task editor correctness / M16: `docs/migration/M16-TASK-EDITING.md`; frontend `activities/ActivityDialog.tsx` / `activityDueDate.ts`; SQL `SourceTaskEditTests.cs`.
- Personal Task read/error/refresh reliability / M17: `docs/migration/M17-PERSONAL-TASK-RELIABILITY.md`; frontend `activities/MyTasksPanel.tsx` / `usePersonalTasks.ts`; actual recipient refresh in `02-handoff.spec.ts`.
- Existing Atera ticket contact safety / M18: `docs/migration/M18-SERVICE-CONTACT-SAFETY.md`; Service ticket-request admission and Atera ticket handler; no new provider feature or credentials.
- Exact customer Activity navigation / M19: `docs/migration/M19-EXACT-ACTIVITY-NAVIGATION.md`; Activities `ActivityQuery`/`ListAsync`, frontend `activityNavigation.ts`, `useSelectedActivity.ts`, `ActivityTimeline.tsx`; real API browser `activity-navigation*.spec.ts`. Test-only jsdom visibility model: `web/src/test/syntheticLayout.ts`.
- Versioned complete/reopen / M20: `docs/migration/M20-ACTIVITY-STATUS-CONCURRENCY.md`; Activities status routes and `MutateAsync`, SQL `ActivityStatusConcurrencyTests.cs`; frontend `useActivityStatusCommands.ts`, `statusFocus.ts`, `ActivityStatusFeedback.tsx`; real API browser `activity-status.spec.ts`.
- Truthful saved Service reads / M21: `docs/migration/M21-SAVED-SERVICE-DATA.md`; frontend `service/useSavedServiceList.ts`, `SavedServiceReadState.tsx`, `CreateTicketDialog.tsx`; real API browser `service-readiness*.spec.ts` and existing `service-time.spec.ts`. Customer tab visibility: `organizations/useCustomerTabVisibility.ts`.
- Original Git identities and import commits: `docs/migration/sources.json`, `IMPORT.md`.
- Strict Atlas tests and native fixture setup: `docs/testing/ATLAS.md`; final local strict unit/PostgreSQL/browser evidence: `docs/testing/evidence/atlas-strict-current-2026-10-16.json`.
- Historical import failures (no longer an exception mechanism): `docs/migration/BASELINE.md`, `atlas-baseline.json`.
- Root build orchestration: `scripts/tasks.mjs`; CI: `.github/workflows/ci.yml`.
- Atlas entry points and module map: `apps/atlas/docs/AI_CONTEXT_MAP.md`.
- CRM architecture: `apps/crm/README.md`, `apps/crm/CLAUDE.md`, `apps/crm/docs/adr`.

Read only the relevant module and tests. Do not load credential files or large historical verification archives wholesale.
