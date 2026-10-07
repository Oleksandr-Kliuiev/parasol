-- Runtime database role for the Atlas API and worker. Run once per database AS THE OWNER (the role that ran
-- `prisma migrate deploy`), after the migrations:
--
--   psql "$DATABASE_URL" -v atlas_app_password="$(cat /path/to/secret)" -f prisma/roles.sql
--
-- Then point the application at this role (ATLAS_RUNTIME_DATABASE_URL in .env.example). The owner URL stays for
-- migrations and the synthetic seed only. The password comes from your secret store; never commit it.
--
-- Why a separate role: row-level security does not apply to a table's owner or to roles with BYPASSRLS. An application
-- that connects as the owner has RLS silently disabled. packages/graph/scoped-db.ts refuses to start in that case.

CREATE ROLE atlas_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'atlas_app_password';

GRANT USAGE ON SCHEMA public TO atlas_app;
-- Reads and writes needed by the scoped repositories. No DELETE and no TRUNCATE anywhere: Stage 1 never deletes.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO atlas_app;
-- Audit logs are insert-only for the application (the triggers enforce it for everyone, including the owner).
REVOKE UPDATE ON "AuditEvent", "SecurityAuditEvent" FROM atlas_app;
-- Migration bookkeeping is not application data.
REVOKE ALL ON "_prisma_migrations" FROM atlas_app;
-- Tables created by future migrations get the same grants automatically when created by this owner.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO atlas_app;
