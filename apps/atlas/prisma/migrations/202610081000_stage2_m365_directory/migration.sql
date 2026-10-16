-- Stage 2 task 2.2, part 1 of 3 (docs/stage2/02_CONTRACTS.md §1, §3, §6): shared M365 extensions and directory
-- generations. Additive; earlier migrations are unchanged. Database-local objects only: no CREATE ROLE and no reference to
-- a role that may not exist yet. Grants, routine ownership and EXECUTE live in prisma/roles.sql, applied after deploy.
--   1. Connection.lifecycleVersion: monotonic; every status change increments it (bind, activation, m365-disable).
--   2. Permission m365:read; typed M365 links (m365_user-PERSON, m365_device-DEVICE, manual only); M365 ExternalEntity
--      mirrors hold an opaque directory object ID and attribute codes only, on a microsoft365 connection only.
--   3. Directory generations: STAGING -> PUBLISHED | FAILED, objects immutable outside STAGING, one published pointer per
--      connection × resource in M365ResourceState, publication fenced by attempt order, ACTIVE status and lifecycleVersion.
--   4. Retention: payload rows are deleted only after their bounded expiresAt (triggers apply to every role).

-- ---------------------------------------------------------------------------------------------------------------
-- 0. Preflight: rows the new rules cannot interpret stop the migration; a person decides.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Connection" WHERE system = 'microsoft365'
             AND ("externalTenantId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  OR "externalTenantId" = '00000000-0000-0000-0000-000000000000')) THEN
    RAISE EXCEPTION 'v2.2 preflight: a microsoft365 Connection is not bound to a lower-case tenant GUID; bind it again explicitly before applying';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExternalEntity" WHERE "resourceType" LIKE 'm365%')
     OR EXISTS (SELECT 1 FROM "ExternalEntity" x JOIN "Connection" c
                ON c."workspaceId" = x."workspaceId" AND c."clientId" = x."clientId" AND c.id = x."connectionId" WHERE c.system = 'microsoft365') THEN
    RAISE EXCEPTION 'v2.2 preflight: ExternalEntity rows already exist for Microsoft 365; remove or map them explicitly before applying';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Connection lifecycle version and M365 tenant shape
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "Connection" ADD COLUMN "lifecycleVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_lifecycle_version_check" CHECK ("lifecycleVersion" >= 0);
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_m365_tenant_check"
  CHECK (system <> 'microsoft365' OR ("externalTenantId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND "externalTenantId" <> '00000000-0000-0000-0000-000000000000'));
CREATE FUNCTION atlas_connection_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."lifecycleVersion" < OLD."lifecycleVersion" THEN
    RAISE EXCEPTION 'Connection.lifecycleVersion is monotonic';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW."lifecycleVersion" <= OLD."lifecycleVersion" THEN
    RAISE EXCEPTION 'Connection status changes increment lifecycleVersion';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Connection_lifecycle_version" BEFORE UPDATE ON "Connection" FOR EACH ROW EXECUTE FUNCTION atlas_connection_lifecycle();

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Permission, typed links, ExternalEntity mirrors
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ClientMembership" DROP CONSTRAINT "ClientMembership_permissions_check";
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_permissions_check"
  CHECK (array_position(permissions, NULL) IS NULL
         AND permissions <@ ARRAY['context:read','events:ingest','mapping:review','connections:manage','observations:triage','m365:read']::TEXT[]);

ALTER TABLE "EntityLink" DROP CONSTRAINT "EntityLink_type_compat_check";
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_type_compat_check"
  CHECK (("resourceType", "entityKind") IN (('agent','DEVICE'),('contact','PERSON'),('m365_user','PERSON'),('m365_device','DEVICE')));
-- First slice: M365 identity is confirmed by a person only; no hostname/name/fixture method.
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_m365_manual_check" CHECK ("resourceType" NOT LIKE 'm365%' OR method = 'MANUAL');

-- Mirror attributes: codes only (for example userType=GUEST), never a name, UPN or vendor text.
CREATE FUNCTION atlas_m365_attribute_codes(attributes JSONB) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(attributes) = 'object' AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(attributes) a
    WHERE a.key NOT IN ('userType','accountEnabled') OR jsonb_typeof(a.value) <> 'string' OR (a.value #>> '{}') !~ '^[A-Z][A-Z0-9_]{0,31}$')
$$;
ALTER TABLE "ExternalEntity" ADD CONSTRAINT "ExternalEntity_m365_mirror_check"
  CHECK ("resourceType" <> 'm365_signin' AND ("resourceType" NOT IN ('m365_user','m365_device')
         OR ("externalId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND atlas_m365_attribute_codes(attributes))));
-- M365 resource types belong to microsoft365 connections and only those. An AFTER ROW trigger: it runs at the end of the
-- statement, after row-level security, when a connection inserted by the same statement is visible too; a connection
-- that is still not visible is refused here, never skipped in favour of the foreign key.
CREATE FUNCTION atlas_external_entity_system() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_system TEXT;
BEGIN
  SELECT system INTO v_system FROM public."Connection"
   WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND id = NEW."connectionId";
  IF NOT FOUND THEN RAISE EXCEPTION 'ExternalEntity needs its connection to exist'; END IF;
  IF (v_system = 'microsoft365') <> (NEW."resourceType" IN ('m365_user','m365_device')) THEN
    RAISE EXCEPTION 'ExternalEntity resource type does not belong to its connection system';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "ExternalEntity_connection_system" AFTER INSERT OR UPDATE OF "resourceType", "connectionId" ON "ExternalEntity"
  FOR EACH ROW EXECUTE FUNCTION atlas_external_entity_system();
-- Target of the directory-object mirror key: same connection, resource type and opaque source ID as the object.
CREATE UNIQUE INDEX "ExternalEntity_mirror_key" ON "ExternalEntity"("workspaceId", "clientId", "connectionId", "resourceType", "externalId", "id");

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Directory read state and generations
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "M365ResourceState" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "latestStartedSeq" INTEGER NOT NULL DEFAULT 0,
    "latestRecordedSeq" INTEGER NOT NULL DEFAULT 0,
    "latestPublishedSeq" INTEGER NOT NULL DEFAULT 0,
    "activeGenerationId" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "safeErrorCode" TEXT,

    CONSTRAINT "M365ResourceState_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","resourceType")
);
CREATE TABLE "M365DirectoryGeneration" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "attemptSeq" INTEGER NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'STAGING',
    "claimToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "safeErrorCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365DirectoryGeneration_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","resourceType","id")
);
CREATE TABLE "M365DirectoryObject" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "sourceObjectId" TEXT NOT NULL,
    "externalEntityId" TEXT,
    "deviceId" TEXT,
    "dto" JSONB NOT NULL,

    CONSTRAINT "M365DirectoryObject_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","resourceType","generationId","sourceObjectId")
);
CREATE UNIQUE INDEX "M365DirectoryGeneration_seq_key" ON "M365DirectoryGeneration"("workspaceId", "clientId", "connectionId", "resourceType", "attemptSeq");
-- deviceId is a lookup key for sign-in references, deliberately not unique (duplicates resolve as AMBIGUOUS).
CREATE INDEX "M365DirectoryObject_deviceId_idx" ON "M365DirectoryObject"("workspaceId", "clientId", "connectionId", "resourceType", "generationId", "deviceId");
CREATE INDEX "M365DirectoryObject_mirror_idx" ON "M365DirectoryObject"("workspaceId", "clientId", "externalEntityId");

ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_connection_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId") REFERENCES "Connection"("workspaceId", "clientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_activeGeneration_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "resourceType", "activeGenerationId")
  REFERENCES "M365DirectoryGeneration"("workspaceId", "clientId", "connectionId", "resourceType", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_state_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "resourceType")
  REFERENCES "M365ResourceState"("workspaceId", "clientId", "connectionId", "resourceType") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "M365DirectoryObject" ADD CONSTRAINT "M365DirectoryObject_generation_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "resourceType", "generationId")
  REFERENCES "M365DirectoryGeneration"("workspaceId", "clientId", "connectionId", "resourceType", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Typed mirror: the ExternalEntity of the same scope, connection, resource type and opaque source ID (NULL while staged).
ALTER TABLE "M365DirectoryObject" ADD CONSTRAINT "M365DirectoryObject_mirror_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "resourceType", "sourceObjectId", "externalEntityId")
  REFERENCES "ExternalEntity"("workspaceId", "clientId", "connectionId", "resourceType", "externalId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_resource_type_check" CHECK ("resourceType" IN ('m365_user','m365_device','m365_signin'));
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_status_check" CHECK (status IN ('PENDING','OK','ERROR','UNAVAILABLE','MISSING'));
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_seq_check"
  CHECK ("latestPublishedSeq" >= 0 AND "latestPublishedSeq" <= "latestRecordedSeq" AND "latestRecordedSeq" <= "latestStartedSeq");
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_code_check"
  CHECK ((status IN ('PENDING','OK')) = ("safeErrorCode" IS NULL) AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_pending_check"
  CHECK (status <> 'PENDING' OR ("latestRecordedSeq" = 0 AND "lastSuccessAt" IS NULL AND "activeGenerationId" IS NULL));
-- A pointer exists only after a publication and only while the last good data is shown (OK, or STALE after a failure).
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_pointer_check"
  CHECK (("activeGenerationId" IS NULL OR ("resourceType" <> 'm365_signin' AND "latestPublishedSeq" > 0 AND status IN ('OK','ERROR')))
         AND ("resourceType" = 'm365_signin' OR status <> 'OK' OR "activeGenerationId" IS NOT NULL));
ALTER TABLE "M365ResourceState" ADD CONSTRAINT "M365ResourceState_time_check"
  CHECK ("lastSuccessAt" IS NULL OR ("lastAttemptAt" IS NOT NULL AND "lastSuccessAt" <= "lastAttemptAt"));

ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_resource_type_check" CHECK ("resourceType" IN ('m365_user','m365_device'));
ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_state_check" CHECK (state IN ('STAGING','PUBLISHED','FAILED'));
ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_identity_check"
  CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND "attemptSeq" >= 1 AND "lifecycleVersion" >= 0);
-- A claim (token + lease) exists exactly while the generation is staged.
ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_claim_check"
  CHECK (("claimToken" IS NULL) = ("leaseExpiresAt" IS NULL) AND (state = 'STAGING') = ("claimToken" IS NOT NULL));
ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_outcome_check"
  CHECK ((state = 'STAGING') = ("completedAt" IS NULL) AND (state = 'FAILED') = ("safeErrorCode" IS NOT NULL)
         AND ("completedAt" IS NULL OR "completedAt" >= "startedAt")
         AND ("safeErrorCode" IS NULL OR "safeErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'));
ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_rows_check" CHECK ("rowCount" BETWEEN 0 AND 20000);
-- Payload lifetime is bounded when the row is written: staged/failed 24h from start, published 24h from completion.
ALTER TABLE "M365DirectoryGeneration" ADD CONSTRAINT "M365DirectoryGeneration_retention_check"
  CHECK ("expiresAt" > "startedAt" AND "expiresAt" <= COALESCE("completedAt", "startedAt") + interval '24 hours');

ALTER TABLE "M365DirectoryObject" ADD CONSTRAINT "M365DirectoryObject_resource_type_check" CHECK ("resourceType" IN ('m365_user','m365_device'));
-- Bounded allowlisted DTO (connectors/microsoft365/directory-dto.ts): exactly the persisted fields, every key present
-- (optional values as explicit JSON null), nothing else. TRUE only: a missing key or value can never yield SQL NULL,
-- which a CHECK would accept (`{}` and incomplete shapes are rejected).
-- Aggregate byte cap: the field limits (code points) are the contract; the cap only bounds the whole value and must admit
-- every parser output. jsonb text is `{"k": v, ...}` with raw UTF-8 and only `"`, `\` and C0 controls escaped; safeText
-- removes controls, so a code point takes at most 4 bytes (an escaped `"`/`\` only 2). Largest user DTO:
--   braces 2 + separators 4*2 + keys (52 chars + 5*4 quotes/`: `) 72 + id 38 + userType "UNKNOWN" 9 + displayName 256*4+2
--   + accountEnabled false 5 + userPrincipalName 320*4+2 = 2442 bytes (device: 1701). 4096 leaves margin for both.
CREATE FUNCTION atlas_m365_directory_dto(resource TEXT, dto JSONB) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(dto) = 'object' AND octet_length(dto::text) <= 4096
    AND (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(dto) k) = CASE resource
          WHEN 'm365_user' THEN ARRAY['accountEnabled','displayName','id','userPrincipalName','userType']
          WHEN 'm365_device' THEN ARRAY['accountEnabled','deviceId','displayName','id','operatingSystem'] END
    AND jsonb_typeof(dto->'id') = 'string' AND (dto->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(dto->'accountEnabled') IN ('boolean','null')
    AND (jsonb_typeof(dto->'displayName') = 'null' OR (jsonb_typeof(dto->'displayName') = 'string' AND char_length(dto->>'displayName') <= 256))
    AND CASE resource
          WHEN 'm365_user' THEN (jsonb_typeof(dto->'userType') = 'null' OR (dto->>'userType') IN ('MEMBER','GUEST','UNKNOWN'))
            AND (jsonb_typeof(dto->'userPrincipalName') = 'null' OR (jsonb_typeof(dto->'userPrincipalName') = 'string' AND char_length(dto->>'userPrincipalName') <= 320))
          ELSE (jsonb_typeof(dto->'operatingSystem') = 'null' OR (jsonb_typeof(dto->'operatingSystem') = 'string' AND char_length(dto->>'operatingSystem') <= 128))
            AND (jsonb_typeof(dto->'deviceId') = 'null' OR (dto->>'deviceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') END, false)
$$;
ALTER TABLE "M365DirectoryObject" ADD CONSTRAINT "M365DirectoryObject_dto_check"
  CHECK (("sourceObjectId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND dto->>'id' = "sourceObjectId"
          AND atlas_m365_directory_dto("resourceType", dto)
          AND CASE "resourceType" WHEN 'm365_device' THEN "deviceId" IS NOT DISTINCT FROM dto->>'deviceId' ELSE "deviceId" IS NULL END) IS TRUE);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Ordering, publication fence, immutability and retention (triggers apply to every role, including the owner)
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION atlas_m365_resource_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."resourceType")
       IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD."resourceType") THEN
      RAISE EXCEPTION 'M365ResourceState identity is immutable';
    END IF;
    IF NEW."latestStartedSeq" < OLD."latestStartedSeq" OR NEW."latestRecordedSeq" < OLD."latestRecordedSeq"
       OR NEW."latestPublishedSeq" < OLD."latestPublishedSeq" OR NEW."lastSuccessAt" < OLD."lastSuccessAt"
       OR (OLD."lastSuccessAt" IS NOT NULL AND NEW."lastSuccessAt" IS NULL) OR NEW."lastAttemptAt" < OLD."lastAttemptAt" THEN
      RAISE EXCEPTION 'M365ResourceState order is monotonic';
    END IF;
    IF OLD."activeGenerationId" IS NOT NULL AND NEW."activeGenerationId" IS NULL THEN
      SELECT "expiresAt" INTO g FROM public."M365DirectoryGeneration"
       WHERE "workspaceId" = OLD."workspaceId" AND "clientId" = OLD."clientId" AND "connectionId" = OLD."connectionId"
         AND "resourceType" = OLD."resourceType" AND id = OLD."activeGenerationId";
      IF g."expiresAt" IS NULL OR g."expiresAt" > now() OR NEW.status <> 'MISSING' THEN
        RAISE EXCEPTION 'an unexpired published directory generation cannot be withdrawn';
      END IF;
    END IF;
  END IF;
  IF NEW."activeGenerationId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."activeGenerationId" IS DISTINCT FROM OLD."activeGenerationId") THEN
    SELECT state, "attemptSeq", "lifecycleVersion" INTO g FROM public."M365DirectoryGeneration"
     WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
       AND "resourceType" = NEW."resourceType" AND id = NEW."activeGenerationId";
    IF g.state IS DISTINCT FROM 'PUBLISHED' OR g."attemptSeq" <> NEW."latestPublishedSeq" THEN
      RAISE EXCEPTION 'the directory pointer names the published generation of latestPublishedSeq';
    END IF;
    -- Pointer linearization (review S2-A-rc2): the pointer change itself is the publication point. It moves only to the
    -- newest started attempt (this row is locked, and latestStartedSeq never decreases) and only under the Connection
    -- fence: ACTIVE at the generation's lifecycleVersion. A retained pointer is never rechecked by unrelated updates.
    IF g."attemptSeq" IS DISTINCT FROM NEW."latestStartedSeq" THEN
      RAISE EXCEPTION 'the directory pointer moves only to the newest started attempt';
    END IF;
    PERFORM atlas_m365_connection_fence(NEW."workspaceId", NEW."clientId", NEW."connectionId", g."lifecycleVersion");
  ELSIF TG_OP = 'UPDATE' AND NEW."latestPublishedSeq" <> OLD."latestPublishedSeq" THEN
    RAISE EXCEPTION 'latestPublishedSeq advances only with a new published pointer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365ResourceState_order" BEFORE INSERT OR UPDATE ON "M365ResourceState" FOR EACH ROW EXECUTE FUNCTION atlas_m365_resource_state();

-- Concurrency (both M365 migrations). One lock order, shared with the cleanup routine:
--   Connection → resource state / sign-in root (window) → generation / attempt → leaf → objects / memberships.
-- A trigger that authorizes a write by a parent's state locks that parent: an INSERT locks its parents in this order and
-- waits (the new row is not locked yet); an UPDATE, whose own row is already locked, takes an EARLIER-ordered parent only
-- with NOWAIT and otherwise fails (55P03) instead of risking a deadlock — a caller following the order already holds it.
-- State transitions UPDATE the parent row, so they wait for every child writer that holds it and then re-read the
-- children: in READ COMMITTED each statement of these VOLATILE functions takes a fresh snapshot after the lock wait.
-- Publication (directory or sign-in) holds the Connection in SHARE mode and checks ACTIVE + lifecycleVersion under it;
-- m365-disable and cleanup take FOR NO KEY UPDATE, so a disable either waits for a running publication or wins and the
-- publication then fails. Expired-payload DELETEs (cleanup) read parents without locks: the definer holds no UPDATE
-- privilege on them, and it holds the Connection exclusively against publishers anyway.
CREATE FUNCTION atlas_m365_connection_fence(p_workspace TEXT, p_client TEXT, p_connection TEXT, p_version INTEGER) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
  BEGIN
    SELECT status, "lifecycleVersion" INTO c FROM public."Connection"
     WHERE "workspaceId" = p_workspace AND "clientId" = p_client AND id = p_connection FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'M365 publication: lock the Connection (FOR SHARE) before the state rows; it is held by a disable or cleanup' USING ERRCODE = '55P03';
  END;
  IF c.status IS DISTINCT FROM 'ACTIVE' OR c."lifecycleVersion" IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'M365 publication needs the ACTIVE connection of the claimed lifecycleVersion';
  END IF;
END $$;

CREATE FUNCTION atlas_m365_directory_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_started INTEGER; v_rows INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expiresAt" > now() THEN RAISE EXCEPTION 'directory generation is retained until its expiresAt'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The initial state is checked first and independently: a generation is never created terminal (the deferred
    -- publication check covers only the STAGING -> PUBLISHED transition). The prerequisite state row must already be
    -- visible: a later foreign-key check cannot stand in for the lifecycle checks (a parent inserted by the same
    -- statement, for example in a data-modifying CTE, is invisible here and therefore refused).
    IF NEW.state IS DISTINCT FROM 'STAGING' THEN RAISE EXCEPTION 'a directory generation starts STAGING'; END IF;
    SELECT "latestStartedSeq" INTO v_started FROM public."M365ResourceState"
     WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId" AND "resourceType" = NEW."resourceType"
       FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'a directory generation needs its resource state to exist first (committed or earlier in this transaction)'; END IF;
    IF v_started IS DISTINCT FROM NEW."attemptSeq" THEN
      RAISE EXCEPTION 'a directory generation starts STAGING with the newly allocated latestStartedSeq';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."resourceType", NEW.id, NEW."attemptSeq", NEW."lifecycleVersion", NEW."startedAt")
     IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD."resourceType", OLD.id, OLD."attemptSeq", OLD."lifecycleVersion", OLD."startedAt") THEN
    RAISE EXCEPTION 'directory generation identity is immutable';
  END IF;
  IF OLD.state <> 'STAGING' THEN RAISE EXCEPTION 'a published or failed directory generation is immutable'; END IF;
  IF NEW."expiresAt" > OLD."expiresAt" AND NEW.state <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'directory retention is extended only by publication';
  END IF;
  IF NEW.state = 'PUBLISHED' THEN
    PERFORM atlas_m365_connection_fence(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."lifecycleVersion");
    BEGIN
      SELECT "latestStartedSeq" INTO v_started FROM public."M365ResourceState"
       WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId" AND "resourceType" = NEW."resourceType"
         FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'directory publication: lock the resource state before the generation; a newer attempt is being claimed' USING ERRCODE = '55P03';
    END;
    IF v_started IS DISTINCT FROM NEW."attemptSeq" THEN RAISE EXCEPTION 'only the newest started directory attempt publishes'; END IF;
    -- Every staged-object writer holds this generation in SHARE mode: this UPDATE waited for them, and these reads see them.
    SELECT count(*) INTO v_rows FROM public."M365DirectoryObject"
     WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
       AND "resourceType" = NEW."resourceType" AND "generationId" = NEW.id;
    IF v_rows <> NEW."rowCount" THEN RAISE EXCEPTION 'published rowCount must equal the staged objects'; END IF;
    IF EXISTS (SELECT 1 FROM public."M365DirectoryObject"
                WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
                  AND "resourceType" = NEW."resourceType" AND "generationId" = NEW.id AND "externalEntityId" IS NULL) THEN
      RAISE EXCEPTION 'every published directory object needs its typed ExternalEntity mirror';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365DirectoryGeneration_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "M365DirectoryGeneration"
  FOR EACH ROW EXECUTE FUNCTION atlas_m365_directory_generation();

-- Commit atomicity (review S2-A-rc2): the STAGING -> PUBLISHED transition and the pointer that publishes it commit together
-- or not at all. A deferred constraint trigger checks at COMMIT that the resource state points at this generation. It
-- cannot be skipped: SET CONSTRAINTS ... IMMEDIATE only makes it fire earlier (and fail while no pointer exists); a
-- ROLLBACK TO SAVEPOINT that undoes the pointer leaves this event queued. Generations published before stay valid after a
-- newer pointer or cleanup replaced them: the check belongs to the publishing transaction only.
CREATE FUNCTION atlas_m365_generation_published_with_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."M365ResourceState"
                  WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
                    AND "resourceType" = NEW."resourceType" AND "activeGenerationId" = NEW.id) THEN
    RAISE EXCEPTION 'a directory generation is published only together with its pointer, in one transaction';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "M365DirectoryGeneration_published_with_pointer" AFTER UPDATE ON "M365DirectoryGeneration"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.state = 'STAGING' AND NEW.state = 'PUBLISHED')
  EXECUTE FUNCTION atlas_m365_generation_published_with_pointer();

-- Objects change only while their generation is staged, and then only by gaining their mirror. The generation is held in
-- SHARE mode for the rest of the writer's transaction, so publication (an UPDATE of that row) is serialized with it.
CREATE FUNCTION atlas_m365_directory_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "expiresAt" INTO g FROM public."M365DirectoryGeneration"
     WHERE "workspaceId" = OLD."workspaceId" AND "clientId" = OLD."clientId" AND "connectionId" = OLD."connectionId"
       AND "resourceType" = OLD."resourceType" AND id = OLD."generationId";
    IF g."expiresAt" IS NULL OR g."expiresAt" > now() THEN RAISE EXCEPTION 'directory objects are retained until their generation expires'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT state INTO g FROM public."M365DirectoryGeneration"
     WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
       AND "resourceType" = NEW."resourceType" AND id = NEW."generationId" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'a directory object needs its STAGING generation to exist first (committed or earlier in this transaction)'; END IF;
  ELSE
    BEGIN
      SELECT state INTO g FROM public."M365DirectoryGeneration"
       WHERE "workspaceId" = NEW."workspaceId" AND "clientId" = NEW."clientId" AND "connectionId" = NEW."connectionId"
         AND "resourceType" = NEW."resourceType" AND id = NEW."generationId" FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'directory object: lock its generation first; it is being published or changed' USING ERRCODE = '55P03';
    END;
  END IF;
  IF g.state IS DISTINCT FROM 'STAGING' THEN RAISE EXCEPTION 'published directory membership is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND (ROW(NEW."workspaceId", NEW."clientId", NEW."connectionId", NEW."resourceType", NEW."generationId", NEW."sourceObjectId", NEW."deviceId", NEW.dto)
       IS DISTINCT FROM ROW(OLD."workspaceId", OLD."clientId", OLD."connectionId", OLD."resourceType", OLD."generationId", OLD."sourceObjectId", OLD."deviceId", OLD.dto)
       OR OLD."externalEntityId" IS NOT NULL) THEN
    RAISE EXCEPTION 'a staged directory object only gains its mirror';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "M365DirectoryObject_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "M365DirectoryObject"
  FOR EACH ROW EXECUTE FUNCTION atlas_m365_directory_object();

CREATE FUNCTION atlas_m365_reject_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'M365 evidence is removed only by expiry (cleanup routine), never truncated'; END $$;
CREATE TRIGGER "M365DirectoryGeneration_no_truncate" BEFORE TRUNCATE ON "M365DirectoryGeneration" FOR EACH STATEMENT EXECUTE FUNCTION atlas_m365_reject_truncate();
CREATE TRIGGER "M365DirectoryObject_no_truncate" BEFORE TRUNCATE ON "M365DirectoryObject" FOR EACH STATEMENT EXECUTE FUNCTION atlas_m365_reject_truncate();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Row-level security: the same client scope as every other client table
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "M365ResourceState" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365ResourceState_scope" ON "M365ResourceState" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365DirectoryGeneration" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365DirectoryGeneration_scope" ON "M365DirectoryGeneration" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
ALTER TABLE "M365DirectoryObject" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "M365DirectoryObject_scope" ON "M365DirectoryObject" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
