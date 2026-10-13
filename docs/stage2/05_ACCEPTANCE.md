# Stage 2 — acceptance matrix

These are required future tests, not recorded passing results. Columns name suggested focused test files.
S2-ARCH approves the design only; S2-A/B/C approve executed implementation evidence.

| ID / gate | Required behavior | Test / evidence |
|---|---|---|
| A1 / A | Every table denies missing scope and another client in same workspace; pooled connection does not inherit scope; no owner/BYPASSRLS runtime | tests/pg/m365-scope.pg.test.ts + db:check:pg17 |
| A2 / A | Composite FK blocks wrong client, connection, generation, window, typed identity; same vendor ID in two tenants remains distinct | tests/pg/m365-schema.pg.test.ts; real generated Prisma client |
| A3 / A | Caller with context:read only sees no M365 IDs/DTOs through context, tools, mapping queue, CLI, audit or errors; M365 reviewer needs both permissions | tests/pg/m365-permissions.pg.test.ts; fixture counterpart |
| A3a / A | Each single permission denied; both on one client allowed; split permissions across two clients never combine; GET /tools obeys all-of; existing public tool DTOs unchanged | tests/tool-gateway.test.ts + tests/pg/m365-permissions.pg.test.ts |
| A4 / A | Existing mapping and permissions continue working; explicit migration extends CHECKs; pinned Prisma validates/generates; old DB migrates without edits to prior SQL | db:check:drift + tests/pg/m365-upgrade.pg.test.ts |
| A4a / A | Two test:pg runs on one cluster use independent runtime/definer/runner roles; shadow/PGlite DDL needs no pre-created roles; PUBLIC cannot execute cleanup; fresh/existing-role provisioning preserves credentials; definer is not owner/BYPASSRLS and has only the specified Connection lock grants | test:pg twice + db:check:drift + tests/database.test.ts + db:check:pg17 |
| A5 / A | Real m365-disable service/CLI requires connections:manage, confines client/system, locks Connection and atomically sets DISABLED, increments version and audits even when already disabled; no upstream writes or vendor IDs | tests/pg/m365-permissions.pg.test.ts + CLI integration |
| B1 / B | Credential for tenant B bound to A cannot trigger users/devices/signIns; no token cache reuse across scope; changed/revoked connection prevents publication | tests/m365-auth.test.ts + tests/pg/m365-activation.pg.test.ts |
| B1a / B | Newly bound DISABLED connection activates only through versioned one-use capability; wrong tenant, FIXTURE, revocation during probe and replay never publish/read ordinarily | tests/pg/m365-activation.pg.test.ts |
| B1b / B | m365-disable during probe/publication invalidates the old capability and cross-process cached token version; old publisher loses the fence, retained pointer unchanged; reactivation requires a newly issued capability | tests/pg/m365-activation.pg.test.ts + tests/pg/m365-window-publication.pg.test.ts |
| B2 / B | NextLink to attacker/sibling collection/beta/http/userinfo/redirect rejected before token transmission; repeated page links bounded; auth POST restricted | tests/m365-http.test.ts using captured mock requests |
| B3 / B | Directory second-page failure/cap/malformed DTO retains last complete generation as STALE; no success before final page; no silent deletion from partial data | tests/pg/m365-directory.pg.test.ts |
| B4 / B | Overlapping first syncs and later syncs, both finish orders, success/error, equal timestamps: newest published attempt wins; lost claim cannot mutate successor | tests/pg/m365-order.pg.test.ts |
| B5 / B | Crash after page staging / before final commit / after commit; two workers; persisted retry; expired claims count; no partial readable window; immutable duplicate/conflict versions | tests/pg/m365-window-recovery.pg.test.ts |
| B5a / B | Publish hour, refresh/crash, then split refresh with failed half; retain exact old STALE membership/time; race old/new attempts; only complete root swaps pointer; independent roots may yield PARTIAL | tests/pg/m365-window-publication.pg.test.ts |
| B5b / B | SQL CHECK rejects non-hour-aligned roots/rootTo != rootFrom+1h; publication rejects zero/overlapping/gapped leaf partitions, including after restart | tests/pg/m365-window-publication.pg.test.ts |
| B6 / B | 429 honors Retry-After above ordinary cap; bounded 401 refresh; directory/sign-in 403 distinguished from zero; split to 1m still capped → gap; ge/le query excludes exact upper-bound rows locally; other out-of-window rows rejected | tests/m365-adapter.test.ts + tests/pg/m365-windows.pg.test.ts |
| C1 / C | Positive chain: confirmed Huntress→DEVICE→M365 device.deviceId→sign-in; userId→M365 user.id→PERSON; includes exact proof fields | tests/pg/correlation.pg.test.ts |
| C2 / C | Directory device.id deliberately differs from deviceId; hostname/UPN-only, same name across tenants, guest, empty device ID, two mappings, rejected link, disappeared identity never falsely resolve | tests/pg/correlation-negative.pg.test.ts |
| C2a / C | Huntress reference absent/invalid → UNRESOLVED with no historical entityId fallback; re-confirmed agent mapping after ingest uses current DEVICE; same opaque directory ID reappears, rejected links do not revive | tests/pg/correlation-negative.pg.test.ts |
| C2b / C | Existing confirmed link at 61m resolves with STALE/DIRECTORY_STALE; at completedAt+24h it is UNRESOLVED/DIRECTORY_EXPIRED with no DTO; absent active object is NOT_CURRENT; stale generation cannot accept new confirmations | tests/pg/correlation-negative.pg.test.ts + tests/pg/m365-permissions.pg.test.ts |
| C3 / C | Assigned-person activity with other/absent device is labelled separately; conflicting sign-in versions not silently trusted; source CRITICAL/route/triage remain unchanged | tests/pg/correlation-provenance.pg.test.ts |
| C4 / C | Coverage gap / stale / unsupported source class / no capability never means all-clear; complete empty vs unavailable distinct; cursor refuses changed publication/mapping; permissions rechecked on later page | tests/pg/correlation-pages.pg.test.ts |
| C5 / C | DTO projection drops canary IP/location/UPN-in-signin/token/nextLink/free text from DB/audit/logs/provider; expired payload unreadable before cleanup; scoped maintenance can delete only new expired payload | tests/pg/m365-privacy-retention.pg.test.ts + synthetic captured provider/CLI |
| C5a / C | Real EXECUTE-only maintenance runner atomically clears expired active pointer, deletes payload and inserts audit; rollback restores all; Connection lock contention waits; ACTIVE/DISABLED cleanup never changes Connection binding/status/version; runner cannot directly SELECT/UPDATE Connection or SET ROLE; fresh publication race/fresh rows/other scope protected; runtime cannot purge | tests/pg/m365-privacy-retention.pg.test.ts |
| C4a / C | Freshness/retention expires between pages without pointer changes → cursor expires; narrower refresh cannot remove still-retained coverage; historical conflicts retain their original retrieval time | tests/pg/correlation-pages.pg.test.ts |
| C4b / C | Fully traversed retained historical interval after 15m: COMPLETE, traversalComplete=true, gaps=[], freshness=STALE; actual uncovered interval is PARTIAL with gap; zero coverage is UNAVAILABLE; none implies all-clear | tests/pg/correlation-pages.pg.test.ts |
| C5b / C | Disable/revoke selected M365 connection prevents ordinary correlation/publication but still permits scoped expired-payload cleanup; disabled historical Huntress source remains evidence with explicit code | tests/pg/m365-privacy-retention.pg.test.ts + tests/pg/correlation-negative.pg.test.ts |
| C6 / C | Synthetic Gasta journey through actual CLI/API/tools, PostgreSQL runtime role and mock Graph auth; review/revoke mapping then reread; no vendor write; tool ledger/audit persisted | tests/pg/m365-e2e.pg.test.ts + verification/stage2/ (synthetic only) |
| R1 / A,C | Existing Stage 1 C1 lifecycle race, C2 independent baseline/shadow and C3 configured versions remain passing | Existing lifecycle-race, operator-passes, decision-config tests |
| R2 / A,C | ClientContextV1 response and existing tools preserve public shape/semantics; no m365 fields added; source urgency and Decisions allowlist unchanged | Existing tests + explicit compatibility regression |

## S2-LIVE, performed only against an authorized tenant

| ID | Evidence without credentials/personal data |
|---|---|
| L1 | Bound tenant verified by /organization; permissions/consent recorded as names only; users/devices and sign-in capability checks return real statuses; account license prerequisite checked by owner |
| L2 | Read bounded user/device collections and a sign-in window; paging, counts, safe errors and freshness recorded; no mock substitution; limits may produce an explicit gap |
| L3 | Human confirms one device/person mapping using actual source evidence; correlation contains source references and labels; empty device/missing sign-ins documented without invented matches |
| L4 | Stage 1 Atera/Huntress live gate also passed for the end-to-end claim; prove no write endpoints called and no M365 data sent to Decisions |

Live pass requires genuine nonempty evidence for the claimed positive correlation; empty data may prove access,
but L3 then remains NOT_EXERCISED. Sign-ins unavailable due to account capability → directory-only validated,
S2-LIVE partial, not full pass. Missing credentials → BLOCKED_EXTERNAL; complete all independent mock/PostgreSQL work.

## Review verdict rules

APPROVE only for named scope/version with no obligatory findings. REQUEST_CHANGES for architecture defects or
missing required evidence within the claimed gate. PENDING/BLOCKED means no approval was obtained.
Each finding names file/section, concrete failure scenario, consequence, necessary correction and test.
Every review distinguishes design, implementation, live integration and production readiness.
