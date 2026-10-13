-- Stage 5 ASK-REMOTE R-A (docs/stage5/ask/remote/04_AUTHORITY_AND_BILLING.md "Policy and permission"): the ask:remote
-- permission. Additive; every earlier migration is frozen. The latest ClientMembership vocabulary (202610091200) is kept
-- exactly and extended by one value. Existing memberships are unchanged and nothing is granted: remote Ask needs an explicit
-- context:read + ask:remote on the same membership, assigned only by a separate owner decision. The Stage 3 fence trigger
-- on ClientMembership is untouched (a CHECK change rewrites no row).
ALTER TABLE "ClientMembership" DROP CONSTRAINT "ClientMembership_permissions_check";
ALTER TABLE "ClientMembership" ADD CONSTRAINT "ClientMembership_permissions_check"
  CHECK (array_position(permissions, NULL) IS NULL
         AND permissions <@ ARRAY['context:read','events:ingest','mapping:review','connections:manage','observations:triage','m365:read',
                                  'actions:read','actions:request','actions:approve','actions:execute',
                                  'poweroffice:read','poweroffice:sync','poweroffice:maintain','ask:remote']::TEXT[]);
