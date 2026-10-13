-- Stage 3 S3-A (docs/stage3/03_DATA_AND_CONCURRENCY.md): action permissions and the COMPLETE workspace authority fence.
-- Additive; every earlier migration is frozen. prisma/roles.sql (after this deploy) creates the dedicated fence definer,
-- transfers the trigger function to it, installs its role-specific policy and verifies global fence completeness.
-- Applications and owner auth/Connection mutation stay stopped between this deploy and completed roles provisioning:
-- until then a non-superuser owner has no fence policy (ACTION_FENCE_NOT_READY) and the runtime startup check refuses.
--
-- Fence protocol: every INSERT/UPDATE/DELETE of Actor, ClientMembership, ApiToken or Connection increments the one
-- ActionAuthorityFence row of the affected row's workspace (derived from NEW/OLD only, never from app.* settings), in the
-- same transaction, through the SECURITY DEFINER trigger function. A missing row or a refused update rolls the mutation
-- back with SQLSTATE AT001 (ACTION_FENCE_NOT_READY). An unchanged version therefore proves that no auth/binding row of
-- that workspace changed. Action admissions lock the same row (SELECT ... FOR UPDATE, runtime UPDATE(workspaceId) only).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Permission vocabulary: the existing list plus the four action permissions; nothing removed or widened.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ClientMembership" DROP CONSTRAINT "ClientMembership_permissions_check";
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_permissions_check"
  CHECK (array_position(permissions, NULL) IS NULL
         AND permissions <@ ARRAY['context:read','events:ingest','mapping:review','connections:manage','observations:triage','m365:read',
                                  'actions:read','actions:request','actions:approve','actions:execute']::TEXT[]);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Fence table and its self-guards (all roles, including the definer and the owner)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ActionAuthorityFence" (
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActionAuthorityFence_pkey" PRIMARY KEY ("workspaceId"),
    CONSTRAINT "ActionAuthorityFence_version_check" CHECK ("version" >= 0)
);
ALTER TABLE "ActionAuthorityFence" ADD CONSTRAINT "ActionAuthorityFence_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Plain (invoker) guard: refusals and the fence self-guard need no privilege. Trigger-only (RETURNS trigger).
CREATE FUNCTION public.atlas_action_fence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'ACTION_FENCE_GUARD: % cannot be truncated', TG_TABLE_NAME USING ERRCODE = 'AT003';
  END IF;
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'Workspace' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'ACTION_FENCE_GUARD: Workspace deletion is refused' USING ERRCODE = 'AT003';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'ACTION_FENCE_GUARD: Workspace identity is immutable' USING ERRCODE = 'AT003';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'ActionAuthorityFence' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'ACTION_FENCE_GUARD: fence rows cannot be deleted' USING ERRCODE = 'AT003';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.version IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'ACTION_FENCE_GUARD: a fence starts at version 0' USING ERRCODE = 'AT003';
      END IF;
      RETURN NEW;
    END IF;
    -- Exactly one increment per update; the workspace never changes. Rejects no-op and runtime UPDATE(workspaceId).
    IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW.version IS DISTINCT FROM OLD.version + 1 THEN
      RAISE EXCEPTION 'ACTION_FENCE_GUARD: the fence version only increments by one' USING ERRCODE = 'AT003';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ACTION_FENCE_GUARD: unexpected trigger use' USING ERRCODE = 'AT003';
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_action_fence_guard() FROM PUBLIC;
CREATE TRIGGER "ActionAuthorityFence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ActionAuthorityFence"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_action_fence_guard();
CREATE TRIGGER "ActionAuthorityFence_truncate" BEFORE TRUNCATE ON "ActionAuthorityFence"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_action_fence_guard();

-- Initialization of every existing workspace BEFORE row-level security is forced; completeness is asserted here.
INSERT INTO "ActionAuthorityFence" ("workspaceId", "version") SELECT id, 0 FROM "Workspace";
DO $$
BEGIN
  IF (SELECT count(*) FROM "Workspace") <> (SELECT count(*) FROM "ActionAuthorityFence") THEN
    RAISE EXCEPTION 'ActionAuthorityFence backfill is incomplete';
  END IF;
END
$$;

-- Runtime: exactly its workspace, SELECT and the FOR UPDATE row lock (USING/WITH CHECK). The definer's own policy is
-- role-specific and installed by prisma/roles.sql (the role name is set there).
ALTER TABLE "ActionAuthorityFence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActionAuthorityFence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ActionAuthorityFence_scope" ON "ActionAuthorityFence" FOR ALL
  USING ("workspaceId" = atlas_app_workspace()) WITH CHECK ("workspaceId" = atlas_app_workspace());

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The privileged trigger function. SECURITY DEFINER; prisma/roles.sql transfers it to the dedicated NOLOGIN fence
--    definer, whose only privileges are SELECT(workspaceId, version), INSERT(workspaceId, version), UPDATE(version) on
--    the fence. Fixed search_path, every object qualified, no dynamic SQL, no caller argument, no app.* setting.
--    Trigger-only: it cannot be called directly. EXECUTE is revoked from PUBLIC; PostgreSQL checks EXECUTE when a trigger
--    is created (here, as the migration owner), not when it fires, so runtime Connection updates still fire it.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.atlas_action_authority_fence() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_workspace text;
  v_keys text[];
  v_key text;
  v_count bigint;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'ACTION_FENCE_NOT_READY' USING ERRCODE = 'AT001';
  END IF;
  IF TG_TABLE_NAME = 'Workspace' THEN
    IF TG_OP <> 'INSERT' OR TG_WHEN <> 'AFTER' THEN
      RAISE EXCEPTION 'ACTION_FENCE_NOT_READY' USING ERRCODE = 'AT001';
    END IF;
    -- Exactly one version-0 fence per new workspace, in the inserting transaction; a collision or refusal rolls back.
    BEGIN
      INSERT INTO public."ActionAuthorityFence" ("workspaceId", "version") VALUES (NEW.id, 0);
    EXCEPTION WHEN unique_violation OR insufficient_privilege OR foreign_key_violation THEN
      RAISE EXCEPTION 'ACTION_FENCE_NOT_READY' USING ERRCODE = 'AT001';
    END;
    RETURN NULL;
  END IF;
  IF TG_WHEN <> 'BEFORE' THEN
    RAISE EXCEPTION 'ACTION_FENCE_NOT_READY' USING ERRCODE = 'AT001';
  END IF;
  v_keys := CASE TG_TABLE_NAME
    WHEN 'Actor' THEN ARRAY['workspaceId', 'id']
    WHEN 'ClientMembership' THEN ARRAY['workspaceId', 'clientId', 'actorId']
    WHEN 'ApiToken' THEN ARRAY['workspaceId', 'id', 'actorId']
    WHEN 'Connection' THEN ARRAY['workspaceId', 'clientId', 'id']
  END;
  IF v_keys IS NULL THEN
    RAISE EXCEPTION 'ACTION_FENCE_NOT_READY' USING ERRCODE = 'AT001';
  END IF;
  -- No workspace, client or identity move: a signed identity always names the row it named at signing.
  IF TG_OP = 'UPDATE' THEN
    FOREACH v_key IN ARRAY v_keys LOOP
      IF (pg_catalog.to_jsonb(NEW) -> v_key) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) -> v_key) THEN
        RAISE EXCEPTION 'ACTION_AUTHORITY_IDENTITY_IMMUTABLE: % scope and identity cannot move', TG_TABLE_NAME USING ERRCODE = 'AT002';
      END IF;
    END LOOP;
  END IF;
  IF TG_OP = 'DELETE' THEN v_workspace := OLD."workspaceId"; ELSE v_workspace := NEW."workspaceId"; END IF;
  -- Every mutation, including a no-op or unrelated one, takes and increments the same row. Exactly one row.
  BEGIN
    UPDATE public."ActionAuthorityFence" SET "version" = "version" + 1 WHERE "workspaceId" = v_workspace;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'ACTION_FENCE_NOT_READY' USING ERRCODE = 'AT001';
  END;
  IF v_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ACTION_FENCE_NOT_READY' USING ERRCODE = 'AT001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.atlas_action_authority_fence() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Triggers. ENABLE ALWAYS: they also fire under session_replication_role = replica. Created by the migration owner.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TRIGGER "Actor_action_fence" BEFORE INSERT OR UPDATE OR DELETE ON "Actor"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_action_authority_fence();
CREATE TRIGGER "ClientMembership_action_fence" BEFORE INSERT OR UPDATE OR DELETE ON "ClientMembership"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_action_authority_fence();
CREATE TRIGGER "ApiToken_action_fence" BEFORE INSERT OR UPDATE OR DELETE ON "ApiToken"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_action_authority_fence();
CREATE TRIGGER "Connection_action_fence" BEFORE INSERT OR UPDATE OR DELETE ON "Connection"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_action_authority_fence();
-- Bulk erasure cannot bypass the epoch: statement-level TRUNCATE refusal (row triggers do not fire on TRUNCATE).
CREATE TRIGGER "Actor_action_fence_truncate" BEFORE TRUNCATE ON "Actor"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_action_fence_guard();
CREATE TRIGGER "ClientMembership_action_fence_truncate" BEFORE TRUNCATE ON "ClientMembership"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_action_fence_guard();
CREATE TRIGGER "ApiToken_action_fence_truncate" BEFORE TRUNCATE ON "ApiToken"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_action_fence_guard();
CREATE TRIGGER "Connection_action_fence_truncate" BEFORE TRUNCATE ON "Connection"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_action_fence_guard();
-- Workspace: insertion initializes its fence; deletion, identity moves and TRUNCATE are refused in this slice.
CREATE TRIGGER "Workspace_action_fence_init" AFTER INSERT ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_action_authority_fence();
CREATE TRIGGER "Workspace_action_fence_guard" BEFORE UPDATE OR DELETE ON "Workspace"
  FOR EACH ROW EXECUTE FUNCTION public.atlas_action_fence_guard();
CREATE TRIGGER "Workspace_action_fence_truncate" BEFORE TRUNCATE ON "Workspace"
  FOR EACH STATEMENT EXECUTE FUNCTION public.atlas_action_fence_guard();

ALTER TABLE "Actor" ENABLE ALWAYS TRIGGER "Actor_action_fence", ENABLE ALWAYS TRIGGER "Actor_action_fence_truncate";
ALTER TABLE "ClientMembership" ENABLE ALWAYS TRIGGER "ClientMembership_action_fence", ENABLE ALWAYS TRIGGER "ClientMembership_action_fence_truncate";
ALTER TABLE "ApiToken" ENABLE ALWAYS TRIGGER "ApiToken_action_fence", ENABLE ALWAYS TRIGGER "ApiToken_action_fence_truncate";
ALTER TABLE "Connection" ENABLE ALWAYS TRIGGER "Connection_action_fence", ENABLE ALWAYS TRIGGER "Connection_action_fence_truncate";
ALTER TABLE "Workspace" ENABLE ALWAYS TRIGGER "Workspace_action_fence_init", ENABLE ALWAYS TRIGGER "Workspace_action_fence_guard",
  ENABLE ALWAYS TRIGGER "Workspace_action_fence_truncate";
ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard", ENABLE ALWAYS TRIGGER "ActionAuthorityFence_truncate";
