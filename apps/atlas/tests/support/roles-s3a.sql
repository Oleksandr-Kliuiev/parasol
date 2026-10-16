-- Least-privilege database roles for Atlas. Run AS THE OWNER (the role that ran `prisma migrate deploy`) after EVERY
-- `prisma migrate deploy`, before the API, worker or ops CLI start (docs/RUNBOOK.md):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v atlas_app_password="$(cat /path/to/app-secret)" \
--        -v atlas_cleanup_runner_password="$(cat /path/to/runner-secret)" -f prisma/roles.sql
--
-- Both variables are always required; a password is used only when its role does not exist yet. An existing role keeps
-- its credentials: it is validated (confinement attributes, no role memberships, owns no relation) and the script stops,
-- changing nothing, if it is not confined. All grants and revokes are then reapplied from scratch. One transaction.
-- Passwords come from your secret store; never commit them.
--
--   runtime  (atlas_app)                   API, worker, ops CLI. SELECT/INSERT/UPDATE as the scoped repositories need, no
--            DELETE/TRUNCATE anywhere; on the M365 tables UPDATE only on mutable state columns (identity, DTOs, hashes
--            and memberships are never updatable); no EXECUTE on the cleanup routine.
--   definer  (atlas_m365_cleanup_definer)  NOLOGIN owner of public.atlas_m365_cleanup: not a table owner, no BYPASSRLS,
--            no memberships. Connection: SELECT on six columns and UPDATE(id) for the row lock only (id is immutable by
--            trigger); SELECT/DELETE on the M365 payload, membership and attempt tables; UPDATE of the current pointer and
--            status columns; INSERT on AuditEvent. RLS applies to it.
--   runner   (atlas_m365_cleanup_runner)   LOGIN with its own credential; EXECUTE on the cleanup routine and nothing else:
--            no table privilege, cannot SET ROLE to the definer.
--   fence    (atlas_action_fence_definer)  NOLOGIN owner of the trigger-only public.atlas_action_authority_fence (Stage 3):
--            SELECT(workspaceId, version), INSERT(workspaceId, version), UPDATE(version) on ActionAuthorityFence and
--            nothing else; its own FORCE RLS policy there. No EXECUTE for anyone else (triggers fire without it).
--            Runtime on the fence: SELECT + UPDATE(workspaceId) (the row lock), never INSERT or version UPDATE.
--
-- Why separate roles: row-level security does not apply to a table's owner or to roles with BYPASSRLS. An application
-- that connects as the owner has RLS silently disabled; packages/graph/runtime-role.ts refuses to start in that case and
-- whenever the grants or the routine owner above are not in place (an upgrade stays stopped until this script passed).
-- The owner may be a superuser or a NOSUPERUSER role with CREATEDB and CREATEROLE (tests/pg/m365-nonsuper.pg.test.ts).
-- PostgreSQL 16+ links such a creator to the roles it creates with ADMIN only; that link of the migration owner is the
-- one membership tolerated on the runner (never with SET or INHERIT) and on the definer (where the owner also needs SET).
-- Role names are set once below (tests render unique names per database; roles are cluster-wide).
-- psql substitutes the variables here, outside the DO block. set_config returns the value it set, so every column is
-- reduced to a boolean: psql prints whether a setting was given, never a password.
BEGIN;
SELECT set_config('atlas.runtime_role', 'atlas_app', true) IS NOT NULL AS runtime_role_set,
       set_config('atlas.definer_role', 'atlas_m365_cleanup_definer', true) IS NOT NULL AS definer_role_set,
       set_config('atlas.runner_role', 'atlas_m365_cleanup_runner', true) IS NOT NULL AS runner_role_set,
       set_config('atlas.fence_role', 'atlas_action_fence_definer', true) IS NOT NULL AS fence_role_set,
       set_config('atlas.runtime_password', :'atlas_app_password', true) <> '' AS runtime_password_given,
       set_config('atlas.runner_password', :'atlas_cleanup_runner_password', true) <> '' AS runner_password_given;
DO $roles$
DECLARE
  v_runtime TEXT := current_setting('atlas.runtime_role');
  v_definer TEXT := current_setting('atlas.definer_role');
  v_runner TEXT := current_setting('atlas.runner_role');
  v_fence TEXT := current_setting('atlas.fence_role');
  v_fence_fn REGPROCEDURE := to_regprocedure('public.atlas_action_authority_fence()');
  v_workspaces BIGINT; v_fences BIGINT; v_fn REGPROCEDURE;
  -- The accepted Stage 1/2 SECURITY INVOKER helpers/trigger functions the fence definer may execute through PUBLIC
  -- (exact schema-qualified identities, quote_ident(schema).quote_ident(name)(identity arguments); the same routine name in
  -- another schema is NOT allowed; packages/graph/fence-role.ts FENCE_SHARED_INVOKER_ROUTINES). Nothing generic.
  v_fence_shared TEXT[] := ARRAY[
    'public.atlas_app_actor()', 'public.atlas_app_clients()', 'public.atlas_app_token_hash()', 'public.atlas_app_workspace()', 'public.atlas_connection_lifecycle()',
    'public.atlas_external_entity_system()', 'public.atlas_m365_attempt_completed_with_pointer()', 'public.atlas_m365_attribute_codes(attributes jsonb)',
    'public.atlas_m365_connection_fence(p_workspace text, p_client text, p_connection text, p_version integer)',
    'public.atlas_m365_directory_dto(resource text, dto jsonb)', 'public.atlas_m365_directory_generation()', 'public.atlas_m365_directory_object()',
    'public.atlas_m365_generation_published_with_pointer()', 'public.atlas_m365_reject_truncate()', 'public.atlas_m365_resource_budget()',
    'public.atlas_m365_resource_retry()', 'public.atlas_m365_resource_state()', 'public.atlas_m365_root_job()', 'public.atlas_m365_signin_dto(dto jsonb)',
    'public.atlas_m365_signin_evidence()', 'public.atlas_m365_signin_window()', 'public.atlas_m365_sync_request()', 'public.atlas_m365_window_attempt()',
    'public.atlas_m365_window_evidence()', 'public.atlas_m365_window_leaf()', 'public.atlas_observation_lifecycle()', 'public.atlas_protect_legacy_closure()',
    'public.atlas_reject_approval_input_mutation()', 'public.atlas_reject_audit_mutation()', 'public.atlas_reject_connection_rebinding()',
    'public.atlas_require_canonical_conflict_parent()', 'public.atlas_tool_execution_ledger()'];
  v_super BOOLEAN := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  v_routine REGPROCEDURE := to_regprocedure('public.atlas_m365_cleanup(text)');
  -- The migration owner: owner of the protected tables (and, before step 4, of the routine). The only trusted member.
  v_trusted OID := (SELECT relowner FROM pg_class WHERE oid = to_regclass('public."Connection"'));
  v_role TEXT; v_login BOOLEAN; v_password TEXT; v_owner OID; v_moved BOOLEAN; v_grantee TEXT; r RECORD;
BEGIN
  IF (SELECT count(DISTINCT n) FROM unnest(ARRAY[v_runtime, v_definer, v_runner, v_fence, current_user::text]) n) <> 5 THEN
    RAISE EXCEPTION 'roles.sql: runtime, definer, runner, fence definer and the owner must be five different roles';
  END IF;
  IF v_routine IS NULL THEN RAISE EXCEPTION 'roles.sql: run prisma migrate deploy first (cleanup routine missing)'; END IF;
  IF v_fence_fn IS NULL THEN RAISE EXCEPTION 'roles.sql: run prisma migrate deploy first (action fence function missing)'; END IF;
  IF NOT v_super AND (SELECT oid FROM pg_roles WHERE rolname = current_user) IS DISTINCT FROM v_trusted THEN
    RAISE EXCEPTION 'roles.sql: run as the migration owner (the owner of the Atlas tables) or a superuser';
  END IF;

  -- 1. Create absent roles; validate existing ones and keep their credentials.
  FOREACH v_role IN ARRAY ARRAY[v_runtime, v_definer, v_runner, v_fence] LOOP
    v_login := v_role NOT IN (v_definer, v_fence);
    v_password := CASE v_role WHEN v_runtime THEN current_setting('atlas.runtime_password') WHEN v_runner THEN current_setting('atlas.runner_password') END;
    SELECT * INTO r FROM pg_roles WHERE rolname = v_role;
    IF NOT FOUND THEN
      IF v_login AND coalesce(v_password, '') = '' THEN RAISE EXCEPTION 'roles.sql: a password is required to create role %', v_role; END IF;
      BEGIN
        EXECUTE format('CREATE ROLE %I %s NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS%s', v_role,
          CASE WHEN v_login THEN 'LOGIN' ELSE 'NOLOGIN' END, CASE WHEN v_login THEN format(' PASSWORD %L', v_password) ELSE '' END);
      EXCEPTION WHEN OTHERS THEN -- re-raised without the statement, whose text carries the password
        RAISE EXCEPTION 'roles.sql: could not create role % (SQLSTATE %)', v_role, SQLSTATE;
      END;
    ELSIF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit OR r.rolcanlogin <> v_login THEN
      RAISE EXCEPTION 'roles.sql: existing role % is not confined (SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION, INHERIT or LOGIN mismatch)', v_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.member WHERE x.rolname = v_role) THEN
      RAISE EXCEPTION 'roles.sql: role % must not be a member of any role', v_role;
    END IF;
    -- Membership in the runner or the definer (SET ROLE, inheritance) would be a path to the routine or to its privileges
    -- that the ACL does not show. The only member allowed is the migration owner: PostgreSQL 16+ links a non-superuser
    -- creator to every role it creates with ADMIN only (no SET, no INHERIT) — administration, not execution. On the definer
    -- the owner may also hold SET (step 4: transferring and re-granting the routine); on the runner it may not.
    IF v_role IN (v_runner, v_definer) AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.roleid WHERE x.rolname = v_role
         AND NOT (m.member = v_trusted AND (v_role = v_definer OR NOT (m.set_option OR m.inherit_option)))) THEN
      RAISE EXCEPTION 'roles.sql: no role may be a member of the cleanup % % (only an ADMIN-only link of the migration owner)',
        CASE WHEN v_role = v_runner THEN 'runner' ELSE 'definer' END, v_role;
    END IF;
    -- The fence definer: the migration owner's ADMIN(+SET) link only, never INHERIT; nobody else (no runtime SET path).
    IF v_role = v_fence AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.roleid WHERE x.rolname = v_role
         AND NOT (m.member = v_trusted AND NOT m.inherit_option)) THEN
      RAISE EXCEPTION 'roles.sql: no role may be a member of the fence definer % (only the migration owner, without INHERIT)', v_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner WHERE o.rolname = v_role) THEN
      RAISE EXCEPTION 'roles.sql: role % must not own any relation', v_role;
    END IF;
  END LOOP;

  -- 2. Runtime role: reset, then the Stage 1 grants, then column-limited UPDATE on the M365 tables.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', v_runtime);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_runtime);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I', v_runtime);
  EXECUTE format('REVOKE UPDATE ON "AuditEvent", "SecurityAuditEvent" FROM %I', v_runtime);
  EXECUTE format('REVOKE INSERT, UPDATE ON "Actor", "ClientMembership", "ApiToken" FROM %I', v_runtime);
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN EXECUTE format('REVOKE ALL ON "_prisma_migrations" FROM %I', v_runtime); END IF;
  EXECUTE format('REVOKE UPDATE ON "M365ResourceState", "M365DirectoryGeneration", "M365DirectoryObject", "M365SyncRequest", "M365SyncRootJob",
    "M365SignInWindow", "M365WindowAttempt", "M365WindowLeaf", "M365SignInEvidence", "M365WindowEvidence" FROM %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("latestStartedSeq", "latestRecordedSeq", "latestPublishedSeq", "activeGenerationId", "lastAttemptAt",
    "lastSuccessAt", status, "safeErrorCode", "retryAt", "attemptsUsed") ON "M365ResourceState" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE (state, "claimToken", "leaseExpiresAt", "completedAt", "rowCount", "safeErrorCode", "expiresAt")
    ON "M365DirectoryGeneration" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("externalEntityId") ON "M365DirectoryObject" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("totalLeaves", "totalStagedRows", state, "finishedAt") ON "M365SyncRequest" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("attemptsUsed", "retryAt", state, "safeErrorCode", "updatedAt") ON "M365SyncRootJob" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("latestStartedSeq", "latestRecordedSeq", "latestPublishedSeq", "publishedAttemptId", status, "safeErrorCode",
    "lastAttemptAt", "lastSuccessAt") ON "M365SignInWindow" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("claimToken", "leaseExpiresAt", state, "completedAt", "publishedAt", "safeErrorCode", "evidenceCount",
    "leafCount", "stagedRows", "expiresAt") ON "M365WindowAttempt" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE (state, "pagesRead", "rowCount", "safeErrorCode") ON "M365WindowLeaf" TO %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("lastSeenAt", "expiresAt") ON "M365SignInEvidence" TO %I', v_runtime);
  -- Stage 3 actions (S3-A): SELECT everywhere, INSERT on ActionRequest only, no UPDATE on action rows yet; the fence only
  -- through UPDATE(workspaceId), which permits SELECT ... FOR UPDATE and nothing else (its self-guard refuses any update).
  EXECUTE format('REVOKE INSERT, UPDATE ON "ActionAuthorityFence", "ActionApproval", "ActionAttempt", "ActionVerification", "ActionMockTicket" FROM %I', v_runtime);
  EXECUTE format('REVOKE UPDATE ON "ActionRequest" FROM %I', v_runtime);
  EXECUTE format('GRANT UPDATE ("workspaceId") ON "ActionAuthorityFence" TO %I', v_runtime);
  -- Tables created by later migrations get the Stage 1 grants automatically when created by this owner; the runtime
  -- self-check still refuses unlisted UPDATE on M365 and action tables until this script runs again.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO %I', v_runtime);

  -- 3. Definer and runner: reset, then exactly the privileges documented above.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I, %I', v_definer, v_runner);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I', v_definer, v_runner);
  EXECUTE format('GRANT SELECT (id, "workspaceId", "clientId", system, status, "lifecycleVersion"), UPDATE (id) ON "Connection" TO %I', v_definer);
  EXECUTE format('GRANT SELECT, DELETE ON "M365DirectoryObject", "M365DirectoryGeneration", "M365WindowEvidence", "M365WindowLeaf",
    "M365WindowAttempt", "M365SignInEvidence" TO %I', v_definer);
  EXECUTE format('GRANT SELECT, UPDATE ("activeGenerationId", status, "safeErrorCode") ON "M365ResourceState" TO %I', v_definer);
  EXECUTE format('GRANT SELECT, UPDATE ("publishedAttemptId", status, "safeErrorCode") ON "M365SignInWindow" TO %I', v_definer);
  EXECUTE format('GRANT INSERT ON "AuditEvent" TO %I', v_definer);

  -- 4. Routine ACL: reset from scratch. Every grantee other than the current owner — PUBLIC, the runtime, the runner and
  --    any role not managed here — loses its privileges (CASCADE also drops what it passed on); then the runner alone gets
  --    EXECUTE, without grant option. ACL entries move with the ownership to the definer. A non-superuser owner briefly
  --    needs SET on the definer (to act as owner after the transfer) and CREATE for it (for the transfer itself).
  SELECT proowner INTO v_owner FROM pg_proc WHERE oid = v_routine;
  v_moved := v_owner = (SELECT oid FROM pg_roles WHERE rolname = v_definer);
  IF v_moved AND NOT v_super THEN EXECUTE format('SET LOCAL ROLE %I', v_definer); END IF;
  FOR v_grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                     FROM (SELECT (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).grantee AS grantee, p.proowner
                             FROM pg_proc p WHERE p.oid = v_routine) a
                    WHERE a.grantee <> a.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.atlas_m365_cleanup(text) FROM %s CASCADE', v_grantee);
  END LOOP;
  EXECUTE format('REVOKE ALL ON FUNCTION public.atlas_m365_cleanup(text) FROM PUBLIC, %I, %I CASCADE', v_runtime, v_runner);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.atlas_m365_cleanup(text) TO %I', v_runner);
  IF v_moved AND NOT v_super THEN RESET ROLE; END IF;
  IF NOT v_moved THEN
    IF NOT v_super THEN
      EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', v_definer, current_user);
      EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', v_definer);
    END IF;
    EXECUTE format('ALTER FUNCTION public.atlas_m365_cleanup(text) OWNER TO %I', v_definer);
    IF NOT v_super THEN EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', v_definer); END IF;
  END IF;

  -- 4b. Fence definer: exact column privileges, its own policy, the trigger function's ACL and owner, then global
  --     completeness. A non-superuser owner holds SET (never INHERIT) on it for the transfer and the count only.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', v_fence);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', v_fence);
  -- Explicit routine grants to the definer (other than its own trigger function) are removed; what cannot be revoked
  -- here (a grant by another grantor) or a PUBLIC/SECURITY DEFINER routine outside the shared list fails step 5.
  FOR v_fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND left(n.nspname, 3) <> 'pg_' AND p.oid <> v_fence_fn
                 AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname = v_fence) LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM %I CASCADE', v_fn, v_fence);
  END LOOP;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_fence);
  EXECUTE format('GRANT SELECT ("workspaceId", version), INSERT ("workspaceId", version), UPDATE (version) ON "ActionAuthorityFence" TO %I', v_fence);
  DROP POLICY IF EXISTS "ActionAuthorityFence_definer" ON "ActionAuthorityFence";
  EXECUTE format('CREATE POLICY "ActionAuthorityFence_definer" ON "ActionAuthorityFence" FOR ALL TO %I USING (true) WITH CHECK (true)', v_fence);
  IF NOT v_super THEN EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', v_fence, current_user); END IF;
  SELECT proowner INTO v_owner FROM pg_proc WHERE oid = v_fence_fn;
  v_moved := v_owner = (SELECT oid FROM pg_roles WHERE rolname = v_fence);
  IF v_moved AND NOT v_super THEN EXECUTE format('SET LOCAL ROLE %I', v_fence); END IF;
  FOR v_grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                     FROM (SELECT (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).grantee AS grantee, p.proowner
                             FROM pg_proc p WHERE p.oid = v_fence_fn) a
                    WHERE a.grantee <> a.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.atlas_action_authority_fence() FROM %s CASCADE', v_grantee);
  END LOOP;
  EXECUTE format('REVOKE ALL ON FUNCTION public.atlas_action_authority_fence() FROM PUBLIC, %I, %I, %I CASCADE', v_runtime, v_runner, v_definer);
  IF v_moved AND NOT v_super THEN RESET ROLE; END IF;
  IF NOT v_moved THEN
    IF NOT v_super THEN EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', v_fence); END IF;
    EXECUTE format('ALTER FUNCTION public.atlas_action_authority_fence() OWNER TO %I', v_fence);
    IF NOT v_super THEN EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', v_fence); END IF;
  END IF;
  -- Global completeness: every Workspace (counted as the owner) has its fence (counted as the fence definer under its
  -- role-specific policy). Primary and foreign key make equal counts exact. A missing backfill fails provisioning.
  SELECT count(*) INTO v_workspaces FROM "Workspace";
  EXECUTE format('SET LOCAL ROLE %I', v_fence);
  SELECT count("workspaceId") INTO v_fences FROM public."ActionAuthorityFence";
  RESET ROLE;
  IF v_workspaces IS DISTINCT FROM v_fences THEN
    RAISE EXCEPTION 'roles.sql: action authority fence is incomplete (% workspaces, % fence rows)', v_workspaces, v_fences;
  END IF;

  -- 5. Fail closed if the result is not what the runtime self-check expects: besides the owner, exactly the runner holds
  --    EXECUTE (not grantable); nobody reaches the runner or the definer through the runtime role.
  IF has_function_privilege(v_runtime, v_routine, 'EXECUTE') OR NOT has_function_privilege(v_runner, v_routine, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_routine AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                WHERE a.grantee <> p.proowner AND (a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = v_runner) OR a.is_grantable))))
     OR has_schema_privilege(v_definer, 'public', 'CREATE') OR pg_has_role(v_runner, v_definer, 'MEMBER') OR pg_has_role(v_runtime, v_definer, 'MEMBER')
     OR pg_has_role(v_runtime, v_runner, 'MEMBER') THEN
    RAISE EXCEPTION 'roles.sql: routine privileges are not confined after provisioning';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid = v_fence_fn) IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname = v_fence)
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = v_fence_fn AND a.grantee <> p.proowner)
     OR has_schema_privilege(v_fence, 'public', 'CREATE') OR pg_has_role(v_runtime, v_fence, 'MEMBER')
     OR has_table_privilege(v_runtime, 'public."ActionAuthorityFence"', 'INSERT') OR has_column_privilege(v_runtime, 'public."ActionAuthorityFence"', 'version', 'UPDATE') THEN
    RAISE EXCEPTION 'roles.sql: action fence privileges are not confined after provisioning';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND left(n.nspname, 3) <> 'pg_' AND p.oid <> v_fence_fn
                AND has_function_privilege(v_fence, p.oid, 'EXECUTE')
                AND (p.prosecdef
                     OR (quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')') <> ALL (v_fence_shared)
                     OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a JOIN pg_roles g ON g.oid = a.grantee
                                 WHERE g.rolname = v_fence))) THEN
    RAISE EXCEPTION 'roles.sql: the fence definer % can execute an unexpected routine (a grant roles.sql cannot revoke, or a PUBLIC or SECURITY DEFINER routine outside the shared helper list)', v_fence;
  END IF;
END
$roles$;
COMMIT;
