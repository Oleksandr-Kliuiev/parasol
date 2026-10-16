-- Stage 1 task 1.5: scoped snapshot persistence for live resources. docs/02 asks to choose one path and record it; the
-- chosen path is a normalized ResourceSnapshot per connection × resource type:
--   * it is replaced only after a COMPLETE read of every page, in the same transaction as the SyncState success;
--   * a failed read leaves the previous snapshot in place and never advances lastSuccessAt (the context then shows the
--     old snapshot as STALE with the failure code, or ERROR when there never was a complete read);
--   * items are a bounded projection (at most 100) with the source total, never an unbounded copy of vendor records.
-- Additive; earlier migrations are frozen.

-- ---------------------------------------------------------------------------------------------------------------
-- 0. Preflight: SyncState values the new vocabulary cannot interpret stop the migration; a person decides.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SyncState" WHERE status NOT IN ('OK','ERROR','UNAVAILABLE')
             OR "resourceType" NOT IN ('alert','ticket','incident','agent','contact')) THEN
    RAISE EXCEPTION 'v1.5 preflight: SyncState has a status outside OK/ERROR/UNAVAILABLE or an unknown resource type; map them explicitly before applying';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. SyncState: vocabulary and the success/attempt order
-- ---------------------------------------------------------------------------------------------------------------
-- OK: the last attempt read everything. ERROR: the last attempt failed (code required). UNAVAILABLE: the source offers
-- no tenant-scoped read for this resource, so Atlas does not read it at all (code required, e.g. a missing filter).
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_status_check" CHECK (status IN ('OK','ERROR','UNAVAILABLE'));
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_resource_type_check" CHECK ("resourceType" IN ('alert','ticket','incident','agent','contact'));
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_error_code_check" CHECK (status = 'OK' OR "safeErrorCode" IS NOT NULL);
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_success_order_check"
  CHECK ("lastSuccessAt" IS NULL OR ("lastSyncAt" IS NOT NULL AND "lastSuccessAt" <= "lastSyncAt"));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. ResourceSnapshot
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ResourceSnapshot" (
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "items" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL,
    "contractVersion" TEXT NOT NULL,

    CONSTRAINT "ResourceSnapshot_pkey" PRIMARY KEY ("workspaceId","clientId","connectionId","resourceType")
);
-- The snapshot belongs to the sync state of the same scope, connection and resource (composite key carries the scope).
ALTER TABLE "ResourceSnapshot" ADD CONSTRAINT "ResourceSnapshot_syncState_fkey"
  FOREIGN KEY ("workspaceId", "clientId", "connectionId", "resourceType")
  REFERENCES "SyncState"("workspaceId", "clientId", "connectionId", "resourceType") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResourceSnapshot" ADD CONSTRAINT "ResourceSnapshot_resource_type_check" CHECK ("resourceType" IN ('alert','ticket','incident'));
ALTER TABLE "ResourceSnapshot" ADD CONSTRAINT "ResourceSnapshot_items_check"
  CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 100 AND "itemCount" >= jsonb_array_length(items)
         AND truncated = ("itemCount" > jsonb_array_length(items)));

ALTER TABLE "ResourceSnapshot" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ResourceSnapshot_scope" ON "ResourceSnapshot" FOR ALL
  USING ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()))
  WITH CHECK ("workspaceId" = atlas_app_workspace() AND "clientId" = ANY(atlas_app_clients()));
