-- v1.1.2 — closes findings S1 and S3 of the independent review of 1.1.1. Additive to 202610071200_v1_1_contracts,
-- which is frozen; a database that applied the 1.1.0 text first runs prisma/upgrades/v1_1_0_to_v1_1_1.sql, then this.
--
-- S1: the conflict link of a redelivered event was a self foreign key on the global eventKey alone, so a row of client
--     c1 could reference the canonical event of client c2. The link is now scoped AND identity-bound: the parent must be
--     the same workspace, client, connection, resourceType, externalEventId and revision, and must itself be canonical.
-- S3: legacyClosure is a migration-only marker, but nothing stopped the runtime role from setting it to close an
--     observation without author and time. A trigger now rejects any INSERT with the flag and any false → true UPDATE;
--     clearing it (reopen) stays allowed. The backfill of 202610071200 ran before this trigger existed, by construction.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Preflight: existing conflict rows must already satisfy the stricter link (none are expected before 1.1.2)
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "RawEvent" child JOIN "RawEvent" parent ON parent."eventKey" = child."conflictOfEventKey"
    WHERE parent."workspaceId" <> child."workspaceId" OR parent."clientId" <> child."clientId" OR parent."connectionId" <> child."connectionId"
       OR parent."resourceType" <> child."resourceType" OR parent."externalEventId" <> child."externalEventId" OR parent."revision" <> child."revision"
       OR parent."conflictOfEventKey" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'v1.1.2 preflight: a RawEvent conflict link crosses scope or identity, or points at a non-canonical row; repair those rows before applying';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Scoped, identity-bound conflict link
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "RawEvent" DROP CONSTRAINT "RawEvent_conflictOfEventKey_fkey";
-- Foreign-key target: identity + key. Unique because eventKey is unique; a full (non-partial) index is required for a FK.
CREATE UNIQUE INDEX "RawEvent_identity_eventKey_key"
  ON "RawEvent"("workspaceId", "clientId", "connectionId", "resourceType", "externalEventId", "revision", "eventKey");
ALTER TABLE "RawEvent" ADD CONSTRAINT "RawEvent_conflictOf_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "resourceType", "externalEventId", "revision", "conflictOfEventKey")
  REFERENCES "RawEvent"("workspaceId", "clientId", "connectionId", "resourceType", "externalEventId", "revision", "eventKey")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The parent of a conflict row must be the canonical row (its own conflictOfEventKey IS NULL). A foreign key cannot
-- express that, so a trigger does; the parent row is read with the caller's RLS context, which the scoped FK already satisfies.
CREATE FUNCTION atlas_require_canonical_conflict_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."conflictOfEventKey" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "RawEvent" p WHERE p."eventKey" = NEW."conflictOfEventKey" AND p."conflictOfEventKey" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'RawEvent.conflictOfEventKey must reference the canonical event, not another conflict row';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "RawEvent_canonical_conflict_parent" BEFORE INSERT OR UPDATE OF "conflictOfEventKey" ON "RawEvent"
  FOR EACH ROW EXECUTE FUNCTION atlas_require_canonical_conflict_parent();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. legacyClosure is write-protected: only the v1.1 migration ever set it
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION atlas_protect_legacy_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."legacyClosure" AND (TG_OP = 'INSERT' OR NOT OLD."legacyClosure") THEN
    RAISE EXCEPTION 'Observation.legacyClosure is set only by the v1.1 migration for pre-existing closures; close observations with resolvedAt and resolvedBy';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Observation_protect_legacy_closure" BEFORE INSERT OR UPDATE OF "legacyClosure" ON "Observation"
  FOR EACH ROW EXECUTE FUNCTION atlas_protect_legacy_closure();
