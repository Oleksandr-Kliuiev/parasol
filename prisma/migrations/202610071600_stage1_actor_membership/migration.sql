-- Stage 1 task 1.3: verified actors with per-client memberships (docs/02 "Actor и права"). Additive; the three earlier
-- migrations are frozen. Written by hand for Prisma 6.19 conventions, like 202610071200.
--
-- Authentication runs before any scope is known, through the same confined runtime role as everything else, so it has
-- its own narrow RLS path instead of a privileged function:
--   * an ApiToken row is visible only to a transaction that already holds its SHA-256 digest (app.token_hash);
--   * an Actor row and that actor's ClientMembership rows only to a transaction that names the actor (app.actor_id)
--     inside its workspace (app.workspace_id);
--   * an ordinary client scope (app.client_ids) exposes none of them.
-- There is no write policy: actors, memberships and tokens are written by the owner (synthetic seed) until an
-- administration slice adds reviewed write paths. Every link carries the workspace (composite foreign keys).

CREATE TABLE "Actor" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "workspacePermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Actor_pkey" PRIMARY KEY ("workspaceId","id")
);
CREATE TABLE "ClientMembership" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMembership_pkey" PRIMARY KEY ("workspaceId","clientId","actorId")
);
CREATE TABLE "ApiToken" (
    "workspaceId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("workspaceId","id")
);
CREATE INDEX "ClientMembership_workspaceId_actorId_idx" ON "ClientMembership"("workspaceId", "actorId");
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");
CREATE INDEX "ApiToken_workspaceId_actorId_idx" ON "ApiToken"("workspaceId", "actorId");
ALTER TABLE "Actor" ADD CONSTRAINT "Actor_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_workspaceId_clientId_fkey"
  FOREIGN KEY ("workspaceId", "clientId") REFERENCES "Client"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_workspaceId_actorId_fkey"
  FOREIGN KEY ("workspaceId", "actorId") REFERENCES "Actor"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_workspaceId_actorId_fkey"
  FOREIGN KEY ("workspaceId", "actorId") REFERENCES "Actor"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Explicit vocabularies: a new permission is a reviewed migration, not a free-text value. NULL elements fail.
ALTER TABLE "Actor" ADD CONSTRAINT "Actor_status_check" CHECK (status IN ('ACTIVE','DISABLED'));
ALTER TABLE "Actor" ADD CONSTRAINT "Actor_workspacePermissions_check"
  CHECK (array_position("workspacePermissions", NULL) IS NULL AND "workspacePermissions" <@ ARRAY['security_audit:read']::TEXT[]);
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_permissions_check"
  CHECK (array_position(permissions, NULL) IS NULL AND permissions <@ ARRAY['context:read','events:ingest']::TEXT[]);
-- Only the SHA-256 hex digest of a bearer secret is stored, never the secret itself.
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_expiry_check" CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt");

-- Row-level security: lookup policies only (FOR SELECT), no write policy.
CREATE FUNCTION atlas_app_actor() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')
$$;
CREATE FUNCTION atlas_app_token_hash() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.token_hash', true), '')
$$;
ALTER TABLE "ApiToken" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ApiToken_lookup" ON "ApiToken" FOR SELECT
  USING ("tokenHash" = atlas_app_token_hash());
ALTER TABLE "Actor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Actor_self" ON "Actor" FOR SELECT
  USING ("workspaceId" = atlas_app_workspace() AND id = atlas_app_actor());
ALTER TABLE "ClientMembership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ClientMembership_self" ON "ClientMembership" FOR SELECT
  USING ("workspaceId" = atlas_app_workspace() AND "actorId" = atlas_app_actor());

-- Least privilege for a runtime role that already exists (roles.sql ran before this migration, and its ALTER DEFAULT
-- PRIVILEGES granted INSERT/UPDATE on the new tables). Fresh installs get the same REVOKE from prisma/roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
    REVOKE INSERT, UPDATE ON "Actor", "ClientMembership", "ApiToken" FROM atlas_app;
  END IF;
END
$$;
