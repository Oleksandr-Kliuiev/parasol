-- R-EVAL server RS-A roles (docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md §8), included by
-- prisma/roles.sql (its psql include line) inside ITS transaction, after its main block. Same rules: run as the migration
-- owner (or a superuser); a password is used only when its role does not exist yet; grants are reapplied from scratch.
--   evidence definer (atlas_reval_evidence_definer) NOLOGIN NOINHERIT owner of public.atlas_reval_snapshot() only: exact
--            column SELECTs on the remote metadata, the fence version and both Reval tables; its own SELECT policy on the
--            registration (lookup by login OID). No write, no other routine, no membership.
--   evidence reader (atlas_reval_reader) LOGIN NOINHERIT with its own credential: EXECUTE on the snapshot and nothing else.
-- Both: complete effective capability postcondition (packages/graph/reval-role.ts mirrors it at runtime startup). The
-- runtime holds exactly the RS-B column SELECTs on the Reval tables (rs-b brief B10; reval-role.ts REVAL_RUNTIME_COLUMNS) and
-- nothing else there. The accepted PUBLIC SECURITY INVOKER helpers stay as they are; the
-- list below is byte-equal to roles.sql v_fence_shared and packages/graph/fence-role.ts FENCE_SHARED_INVOKER_ROUTINES.
SELECT set_config('atlas.reval_definer_role', 'atlas_reval_evidence_definer', true) IS NOT NULL AS reval_definer_role_set,
       set_config('atlas.reval_reader_role', 'atlas_reval_reader', true) IS NOT NULL AS reval_reader_role_set,
       set_config('atlas.reval_reader_password', :'atlas_reval_reader_password', true) <> '' AS reval_reader_password_given;
DO $reval$
DECLARE
  v_runtime TEXT := current_setting('atlas.runtime_role');
  v_others TEXT[] := ARRAY[current_setting('atlas.runtime_role'), current_setting('atlas.definer_role'), current_setting('atlas.runner_role'),
    current_setting('atlas.fence_role'), current_setting('atlas.po_definer_role'), current_setting('atlas.po_runner_role'),
    current_setting('atlas.remote_role'), current_user::text];
  v_def TEXT := current_setting('atlas.reval_definer_role');
  v_rdr TEXT := current_setting('atlas.reval_reader_role');
  v_snap REGPROCEDURE := to_regprocedure('public.atlas_reval_snapshot()');
  v_guard REGPROCEDURE := to_regprocedure('public.atlas_reval_guard()');
  v_super BOOLEAN := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  v_trusted OID := (SELECT relowner FROM pg_class WHERE oid = to_regclass('public."Connection"'));
  -- RS-B: the runtime's exact Reval column allowlist (packages/graph/reval-role.ts REVAL_RUNTIME_COLUMNS).
  v_rt_column TEXT[] := ARRAY['RevalSandboxRegistration:registrationId', 'RevalSandboxRegistration:databaseInstanceId',
    'RevalSandboxRegistration:workspaceId', 'RevalSandboxRegistration:clientId', 'RevalSandboxRegistration:actorId',
    'RevalSandboxRegistration:admissionId', 'RevalSandboxRegistration:datasetManifestSha256', 'RevalSandboxRegistration:syntheticOnly',
    'RevalFixtureBinding:registrationId', 'RevalFixtureBinding:workspaceId', 'RevalFixtureBinding:clientId', 'RevalFixtureBinding:fixtureId',
    'RevalFixtureBinding:generation', 'RevalFixtureBinding:syntheticFreshnessAt', 'RevalFixtureBinding:datasetManifestSha256'];
  -- The evidence definer's exact column allowlist (packages/graph/reval-role.ts REVAL_DEFINER_COLUMNS).
  v_def_column TEXT[] := ARRAY['RemoteAskPolicy:workspaceId', 'RemoteAskPolicy:admissionId', 'RemoteAskPolicy:projectIdentity',
    'RemoteAskPolicy:policyVersion', 'RemoteAskPolicy:state', 'RemoteAskPolicy:profile', 'RemoteAskPolicy:priceRevision',
    'RemoteAskPolicy:reserveMicroUsd', 'RemoteAskPolicy:dayCapMicroUsd', 'RemoteAskPolicy:monthCapMicroUsd', 'RemoteAskPolicy:expiresAt',
    'RemoteAskClientAdmission:workspaceId', 'RemoteAskClientAdmission:admissionId', 'RemoteAskClientAdmission:clientId', 'RemoteAskClientAdmission:state',
    'RemoteAskPeriodCounter:workspaceId', 'RemoteAskPeriodCounter:projectIdentity', 'RemoteAskPeriodCounter:kind', 'RemoteAskPeriodCounter:periodStart',
    'RemoteAskPeriodCounter:chargedMicroUsd',
    'RemoteAskAttempt:workspaceId', 'RemoteAskAttempt:id', 'RemoteAskAttempt:clientId', 'RemoteAskAttempt:actorId', 'RemoteAskAttempt:admissionId',
    'RemoteAskAttempt:projectIdentity', 'RemoteAskAttempt:policyVersion', 'RemoteAskAttempt:profile', 'RemoteAskAttempt:priceRevision',
    'RemoteAskAttempt:promptRate', 'RemoteAskAttempt:completionRate', 'RemoteAskAttempt:correlationId', 'RemoteAskAttempt:dayStart',
    'RemoteAskAttempt:monthStart', 'RemoteAskAttempt:reservedMicroUsd', 'RemoteAskAttempt:accountedMicroUsd', 'RemoteAskAttempt:state',
    'RemoteAskAttempt:outcome', 'RemoteAskAttempt:createdAt', 'RemoteAskAttempt:settledAt',
    'ActionAuthorityFence:workspaceId', 'ActionAuthorityFence:version',
    'RevalSandboxRegistration:registrationId', 'RevalSandboxRegistration:databaseInstanceId', 'RevalSandboxRegistration:workspaceId',
    'RevalSandboxRegistration:clientId', 'RevalSandboxRegistration:actorId', 'RevalSandboxRegistration:admissionId',
    'RevalSandboxRegistration:evidenceReaderRoleOid', 'RevalSandboxRegistration:datasetManifestSha256',
    'RevalSandboxRegistration:buildManifestSha256', 'RevalSandboxRegistration:syntheticOnly', 'RevalSandboxRegistration:createdAt',
    'RevalFixtureBinding:registrationId', 'RevalFixtureBinding:workspaceId', 'RevalFixtureBinding:clientId', 'RevalFixtureBinding:fixtureId',
    'RevalFixtureBinding:generation', 'RevalFixtureBinding:syntheticFreshnessAt', 'RevalFixtureBinding:datasetManifestSha256',
    'RevalFixtureBinding:installedAt'];
  v_reval_shared TEXT[] := ARRAY[
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
  v_role TEXT; v_login BOOLEAN; v_password TEXT; v_moved BOOLEAN; v_grantee TEXT; v_fn OID; v_col TEXT; r RECORD;
BEGIN
  IF v_def IS NULL OR v_rdr IS NULL OR v_def = v_rdr OR v_def = ANY (v_others) OR v_rdr = ANY (v_others) THEN
    RAISE EXCEPTION 'roles.sql: the evidence definer and evidence reader must differ from each other and from the eight other roles (ten distinct principals)';
  END IF;
  IF NOT v_super AND (SELECT oid FROM pg_roles WHERE rolname = current_user) IS DISTINCT FROM v_trusted THEN
    RAISE EXCEPTION 'roles.sql: run as the migration owner (the owner of the Atlas tables) or a superuser';
  END IF;
  IF v_snap IS NULL OR v_guard IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'atlas\_reval\_%') <> 2
     OR to_regclass('public."RevalSandboxRegistration"') IS NULL OR to_regclass('public."RevalFixtureBinding"') IS NULL THEN
    RAISE EXCEPTION 'roles.sql: run prisma migrate deploy first (R-EVAL RS-A objects missing or unexpected)';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid = v_guard) IS DISTINCT FROM v_trusted
     OR (SELECT relowner FROM pg_class WHERE oid = to_regclass('public."RevalSandboxRegistration"')) IS DISTINCT FROM v_trusted
     OR (SELECT relowner FROM pg_class WHERE oid = to_regclass('public."RevalFixtureBinding"')) IS DISTINCT FROM v_trusted THEN
    RAISE EXCEPTION 'roles.sql: the Reval tables and their guard must be owned by the migration owner';
  END IF;

  -- 1. Create absent roles; validate existing ones and keep their credentials.
  FOREACH v_role IN ARRAY ARRAY[v_def, v_rdr] LOOP
    v_login := v_role = v_rdr;
    v_password := CASE WHEN v_login THEN current_setting('atlas.reval_reader_password') END;
    SELECT * INTO r FROM pg_roles WHERE rolname = v_role;
    IF NOT FOUND THEN
      IF v_login AND coalesce(v_password, '') = '' THEN RAISE EXCEPTION 'roles.sql: a password is required to create role %', v_role; END IF;
      BEGIN
        EXECUTE format('CREATE ROLE %I %s NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS%s', v_role,
          CASE WHEN v_login THEN 'LOGIN' ELSE 'NOLOGIN' END, CASE WHEN v_login THEN format(' PASSWORD %L', v_password) ELSE '' END);
      EXCEPTION WHEN OTHERS THEN -- re-raised without the statement, whose text carries the password
        RAISE EXCEPTION 'roles.sql: could not create role % (SQLSTATE %)', v_role, SQLSTATE;
      END;
    ELSIF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit OR r.rolcanlogin <> v_login
          OR r.rolconfig IS NOT NULL THEN
      RAISE EXCEPTION 'roles.sql: existing role % is not confined (attributes, LOGIN mismatch or per-role settings)', v_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.member WHERE x.rolname = v_role) THEN
      RAISE EXCEPTION 'roles.sql: role % must not be a member of any role', v_role;
    END IF;
    -- Members: only the migration owner's ADMIN link; SET (never INHERIT) on the definer for the ownership transfer.
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.roleid WHERE x.rolname = v_role
                AND NOT (m.member = v_trusted AND NOT m.inherit_option AND (v_role = v_def OR NOT m.set_option))) THEN
      RAISE EXCEPTION 'roles.sql: no role may be a member of % (only an ADMIN link of the migration owner)', v_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner WHERE o.rolname = v_role) THEN
      RAISE EXCEPTION 'roles.sql: role % must not own any relation', v_role;
    END IF;
  END LOOP;

  -- 2. Reset, then exactly the allowlists. The runtime keeps only its RS-B column SELECTs on the Reval tables (after the
  --    generic grants; the table-level REVOKE ALL also revokes every column privilege).
  EXECUTE format('REVOKE ALL ON "RevalSandboxRegistration", "RevalFixtureBinding" FROM %I', v_runtime);
  FOREACH v_col IN ARRAY v_rt_column LOOP
    EXECUTE format('GRANT SELECT (%I) ON public.%I TO %I', split_part(v_col, ':', 2), split_part(v_col, ':', 1), v_runtime);
  END LOOP;
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I, %I', v_def, v_rdr);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I, %I', v_def, v_rdr);
  FOR v_fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND left(n.nspname, 3) <> 'pg_' AND p.oid <> v_snap
                 AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a JOIN pg_roles g ON g.oid = a.grantee WHERE g.rolname IN (v_def, v_rdr)) LOOP
    EXECUTE format('REVOKE ALL ON ROUTINE %s FROM %I, %I CASCADE', v_fn::regprocedure, v_def, v_rdr);
  END LOOP;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I, %I', v_def, v_rdr);
  FOREACH v_col IN ARRAY v_def_column LOOP
    EXECUTE format('GRANT SELECT (%I) ON public.%I TO %I', split_part(v_col, ':', 2), split_part(v_col, ':', 1), v_def);
  END LOOP;
  EXECUTE 'DROP POLICY IF EXISTS "RevalSandboxRegistration_evidence" ON "RevalSandboxRegistration"';
  EXECUTE format('CREATE POLICY "RevalSandboxRegistration_evidence" ON "RevalSandboxRegistration" FOR SELECT TO %I'
    || ' USING ("evidenceReaderRoleOid" = (SELECT r.oid::bigint FROM pg_catalog.pg_roles r WHERE r.rolname = session_user))', v_def);

  -- 3. The guard keeps its owner (the table owner) with an ACL reset; the snapshot moves to the definer with an ACL reset
  --    from scratch (PUBLIC and every other grantee, CASCADE), then EXECUTE for the reader alone, without grant option.
  FOR v_grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                     FROM (SELECT (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).grantee AS grantee, p.proowner
                             FROM pg_proc p WHERE p.oid = v_guard) a WHERE a.grantee <> a.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s CASCADE', v_guard, v_grantee);
  END LOOP;
  IF NOT v_super THEN EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', v_def, current_user); END IF;
  v_moved := (SELECT proowner FROM pg_proc WHERE oid = v_snap) = (SELECT oid FROM pg_roles WHERE rolname = v_def);
  IF v_moved AND NOT v_super THEN EXECUTE format('SET LOCAL ROLE %I', v_def); END IF;
  FOR v_grantee IN SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                     FROM (SELECT (aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))).grantee AS grantee, p.proowner
                             FROM pg_proc p WHERE p.oid = v_snap) a WHERE a.grantee <> a.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s CASCADE', v_snap, v_grantee);
  END LOOP;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE', v_snap);
  IF v_moved AND NOT v_super THEN RESET ROLE; END IF;
  IF NOT v_moved THEN
    IF NOT v_super THEN EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', v_def); END IF;
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', v_snap, v_def);
    IF NOT v_super THEN EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', v_def); END IF;
  END IF;
  IF NOT v_super THEN EXECUTE format('SET LOCAL ROLE %I', v_def); END IF;
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_snap, v_rdr);
  IF NOT v_super THEN RESET ROLE; END IF;

  -- 4. Postconditions (fail closed): routines, ACLs, runtime absence, no membership path, triggers ALWAYS, and the complete
  --    effective capability surface of both roles on every object (the same rules as the remote definer's in roles.sql).
  IF (SELECT proowner FROM pg_proc WHERE oid = v_snap) IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname = v_def)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_snap) OR (SELECT prosecdef FROM pg_proc WHERE oid = v_guard)
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_snap AND a.grantee <> p.proowner
                   AND (a.is_grantable OR a.privilege_type <> 'EXECUTE' OR a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = v_rdr)))
     OR NOT has_function_privilege(v_rdr, v_snap, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = v_guard AND a.grantee <> p.proowner)
     OR has_function_privilege(v_runtime, v_snap, 'EXECUTE') OR has_function_privilege(v_runtime, v_guard, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['RevalSandboxRegistration', 'RevalFixtureBinding']) t,
                  (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(p)
                WHERE has_table_privilege(v_runtime, format('public.%I', t), v.p)
                   OR (v.p IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(v_runtime, format('public.%I', t), v.p)))
     OR EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                 WHERE c.oid IN (to_regclass('public."RevalSandboxRegistration"'), to_regclass('public."RevalFixtureBinding"')) AND a.attnum > 0
                   AND NOT a.attisdropped
                   AND has_column_privilege(v_runtime, c.oid, a.attnum, 'SELECT') <> (format('%s:%s', c.relname, a.attname) = ANY(v_rt_column)))
     OR EXISTS (SELECT 1 FROM unnest(v_others) x, unnest(ARRAY[v_def, v_rdr]) y
                 WHERE x <> current_user::text AND (pg_has_role(x, y, 'MEMBER') OR pg_has_role(y, x, 'MEMBER')))
     OR pg_has_role(v_rdr, v_def, 'MEMBER') OR pg_has_role(v_def, v_rdr, 'MEMBER')
     OR EXISTS (SELECT 1 FROM unnest(v_def_column) e WHERE NOT has_column_privilege(v_def, format('public.%I', split_part(e, ':', 1)), split_part(e, ':', 2), 'SELECT'))
     OR (SELECT count(*) FROM pg_policy x WHERE x.polrelid = to_regclass('public."RevalSandboxRegistration"')) <> 2
     OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid IN (to_regclass('public."RevalSandboxRegistration"'), to_regclass('public."RevalFixtureBinding"'))
           AND NOT t.tgisinternal AND t.tgfoid = v_guard AND t.tgenabled = 'A') <> 4 THEN
    RAISE EXCEPTION 'roles.sql: R-EVAL evidence routine, table or membership privileges are not confined after provisioning';
  END IF;
  FOR r IN SELECT g.oid, g.rolname, g.rolname = v_def AS definer FROM pg_roles g WHERE g.rolname IN (v_def, v_rdr) LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                 (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(p)
                WHERE c.oid >= 16384 AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(r.oid, c.oid, v.p))
       OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
                    AND NOT a.attisdropped AND a.attacl IS NOT NULL, (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(p)
                   WHERE c.oid >= 16384 AND c.relkind IN ('r','p','v','m','f') AND has_column_privilege(r.oid, c.oid, a.attnum, v.p)
                     AND NOT (r.definer AND n.nspname = 'public' AND v.p = 'SELECT' AND c.relname || ':' || a.attname = ANY (v_def_column)))
       OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid >= 16384 AND (c.relowner = r.oid
                   OR CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END))
       OR EXISTS (SELECT 1 FROM pg_type t WHERE t.oid >= 16384 AND t.typowner = r.oid)
       OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid >= 16384 AND p.oid <> v_snap
                   AND (p.proowner = r.oid OR (has_function_privilege(r.oid, p.oid, 'EXECUTE')
                        AND (p.prosecdef OR (quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')') <> ALL (v_reval_shared)
                             OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = r.oid)))))
       OR (r.definer AND NOT has_function_privilege(r.oid, v_snap, 'EXECUTE'))
       OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid
                   OR (n.oid IS DISTINCT FROM pg_my_temp_schema() AND has_schema_privilege(r.oid, n.oid, 'CREATE'))
                   OR EXISTS (SELECT 1 FROM aclexplode(n.nspacl) a WHERE (a.grantee = r.oid AND n.nspname <> 'public')
                                OR (n.oid = pg_my_temp_schema() AND a.grantee = 0 AND a.privilege_type = 'CREATE')))
       OR EXISTS (SELECT 1 FROM (SELECT a.grantee, a.is_grantable FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid >= 16384
                   UNION ALL SELECT a.grantee, a.is_grantable FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a WHERE c.oid >= 16384
                   UNION ALL SELECT a.grantee, a.is_grantable FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid >= 16384 AND p.proowner <> r.oid
                   UNION ALL SELECT a.grantee, a.is_grantable FROM pg_namespace n, aclexplode(n.nspacl) a) g WHERE g.grantee = r.oid AND g.is_grantable)
       OR EXISTS (SELECT 1 FROM pg_proc p LEFT JOIN pg_init_privs i ON i.objoid = p.oid AND i.classoid = 'pg_proc'::regclass AND i.objsubid = 0
                   WHERE p.oid < 16384 AND (EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = r.oid)
                     OR (i.objoid IS NOT NULL AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
                         AND NOT EXISTS (SELECT 1 FROM aclexplode(i.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))))
       OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_init_privs i ON i.objoid = c.oid AND i.classoid = 'pg_class'::regclass AND i.objsubid = 0,
                    (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(p)
                   WHERE c.oid < 16384 AND c.relkind IN ('r','p','v','m','f','S') AND (c.relacl IS NOT NULL OR EXISTS (SELECT 1 FROM pg_attribute t WHERE t.attrelid = c.oid AND t.attacl IS NOT NULL))
                     AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = r.oid)
                       OR EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a WHERE t.attrelid = c.oid AND a.grantee = r.oid)
                       OR (has_table_privilege(r.oid, c.oid, v.p) AND NOT CASE WHEN i.objoid IS NOT NULL
                             THEN EXISTS (SELECT 1 FROM aclexplode(i.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = v.p)
                             ELSE n.nspname = 'information_schema' AND v.p = 'SELECT' AND c.relname NOT LIKE '\_pg\_%'
                                  AND c.relname NOT IN ('sql_parts', 'transforms') END)))
       OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped AND t.attacl IS NOT NULL
                    LEFT JOIN pg_init_privs ci ON ci.objoid = c.oid AND ci.classoid = 'pg_class'::regclass AND ci.objsubid = t.attnum,
                    (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(p)
                   WHERE c.oid < 16384 AND c.relkind IN ('r','p','v','m','f','S') AND has_column_privilege(r.oid, c.oid, t.attnum, v.p)
                     AND NOT has_table_privilege(r.oid, c.oid, v.p)
                     AND NOT EXISTS (SELECT 1 FROM aclexplode(ci.initprivs) a WHERE a.grantee = 0 AND a.privilege_type = v.p))
       OR has_database_privilege(r.oid, current_database(), 'CREATE')
       OR EXISTS (SELECT 1 FROM pg_parameter_acl pa, aclexplode(pa.paracl) a WHERE a.grantee IN (r.oid, 0))
       OR EXISTS (SELECT 1 FROM pg_language l, aclexplode(l.lanacl) a WHERE a.grantee = r.oid)
       OR EXISTS (SELECT 1 FROM pg_type t, aclexplode(t.typacl) a WHERE a.grantee = r.oid)
       OR EXISTS (SELECT 1 FROM pg_largeobject_metadata l WHERE l.lomowner = r.oid OR EXISTS (SELECT 1 FROM aclexplode(l.lomacl) a WHERE a.grantee IN (r.oid, 0)))
       OR (current_setting('lo_compat_privileges') = 'on' AND EXISTS (SELECT 1 FROM pg_largeobject_metadata))
       OR EXISTS (SELECT 1 FROM pg_foreign_data_wrapper w WHERE w.fdwowner = r.oid OR has_foreign_data_wrapper_privilege(r.oid, w.oid, 'USAGE'))
       OR EXISTS (SELECT 1 FROM pg_foreign_server fs WHERE fs.srvowner = r.oid OR has_server_privilege(r.oid, fs.oid, 'USAGE'))
       OR EXISTS (SELECT 1 FROM pg_user_mappings um WHERE um.umuser = r.oid)
       OR EXISTS (SELECT 1 FROM pg_default_acl da WHERE da.defaclrole = r.oid OR EXISTS (SELECT 1 FROM aclexplode(da.defaclacl) a WHERE a.grantee = r.oid))
       OR EXISTS (SELECT 1 FROM pg_shdepend sd WHERE sd.dbid = 0 AND sd.refclassid = 'pg_authid'::regclass AND sd.refobjid = r.oid AND sd.deptype IN ('a', 'o'))
       OR EXISTS (SELECT 1 FROM pg_tablespace ts WHERE ts.spcowner = r.oid OR has_tablespace_privilege(r.oid, ts.oid, 'CREATE')) THEN
      RAISE EXCEPTION 'roles.sql: R-EVAL role % holds a capability outside its exact allowlist (a grant roles.sql cannot revoke, PUBLIC or inherited access, a SECURITY DEFINER or temporary routine, schema CREATE/USAGE/ownership or object ownership)', r.rolname;
    END IF;
  END LOOP;
END
$reval$;
