# Independent RS-A brief review — RC1

**Verdict: CHANGES_REQUIRED.** Five required findings below prevent approving this exact implementation brief. They are bounded repairs within the accepted RC4 architecture. This review does not require a new architecture gate merely because RS-A is a new checkpoint. A proposal to relax physical binding, resident-credential separation, financial semantics or exported contracts would require fresh Astra/Fable agreement instead.

## Identity, independence and limits

- Reviewed artifact: `S5ASKREMOTE-REVAL-RSA-BRIEF-rc1`.
- Package SHA-256: `059cb977895fcc2cfc110afc3108ac1e6cb58fb2cb8bef007a5cb64b112036e2`.
- Brief: `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md`, 491 lines, file SHA-256 `2b9626467a694cab6e1b692e8f5385e4c74af09dff5037f84d8bf840ab396333`.
- ZIP SHA-256: `409dd0d11dcd4145bf078b14cba72985d5cb535cf8e5245998aca976652be0b7`.
- Parent: `S5ASKREMOTE-REVAL-SERVER-DESIGN-rc4`, package SHA-256 `9fa16222d6c32c18d4d193b6666e078fd3624a4bdb2ccb8ab9fbd68113b08163`.
- Baseline: HEAD `916a4d69853ff6da636e8609a2e0bd33aa787f66`, branch `codex/reval-server-contracts-20261011`, baseline file SHA-256 `62328bcb05ee38d1784a111da72fbacc68ca4faca07fde6b68561d86bec64347`.
- Assignment: NEW CLEAN native Codex reviewer, explicitly `gpt-6.1-sol` / `xhigh`, separate from orchestration and implementation. The explicit native launch assignment is launcher evidence. Independent backend response-model/effort telemetry, attributable usage, billing/quota attribution and precise elapsed telemetry are unavailable; none is inferred from self-identification.
- Read active workflow lines 1–85, current root/routing instructions, the entire bounded brief, relevant RC4 contracts 01/02/05/06 and narrow current schema/role/API/harness entry points. No other brief reviewer verdict, author conversation or historical review report was read.
- Read-only review: no repository writes, DB connections/mutations, provider/network calls, helper execution, activation or implementation. The only written artifact is this report. Runtime/helper/PG claims in the draft remain proposed verification obligations, not observations made by this review.

## Identity checks performed

Recomputed compact, path-sorted JSON hash of all 43 manifest entries; it equals the stated package hash. Every current manifest file and every ZIP member matches its listed SHA-256; the ZIP has exactly those 43 members. All 1540 baseline entries match current files. Recomputed the RC4 package identity; its seal's manifest/checks/ZIP hashes match, and its normative reval-server files are unchanged. All 120 execution RC5 manifest files are unchanged. Existing dirty work is therefore preserved at this review boundary. The supplied checks honestly claim hashes/structure only, with no runtime proof.

## Required findings

### R1 — P1: Bind S's actual runtime database, not only C's reader database

**Location:** brief lines 82–97, 121–133, 221–231; RC4 `01_CONTROL_AND_IDENTITY.md` local registration and loaded-identity requirements.

C checks the reader connection against `config.physical`, but S independently resolves another runtime URL from its secret file. The launch handshake verifies S's PID/incarnation and echoes an environment-supplied `databaseInstanceId`; the brief explicitly treats S's inner IDENTITY as echo/mix-up detection only. Nothing requires the database actually opened by S to be the registered local database. A valid runtime secret for another database can satisfy existing `connectRuntimeDatabase` readiness while C continues exporting the first database's identity/census. The production transport restriction currently applies to C's config, not explicitly to S's resolved URL. The owner-executor request likewise needs an exact source for the expected physical identity it is instructed to verify.

**Required repair:** define how each independently opened resident runtime/reader and short-lived owner connection is restricted to the same approved local UNIX_SOCKET endpoint and compared to the registered physical identity before S listens or the executor performs owner effects. C must retain no runtime/owner credential value. Pin the closed internal expected-identity inputs/acknowledgement and all supported server modes; no attachment/absent-server mode may fabricate a bound S identity. A caller-supplied UUID or server echo is insufficient. Full immutable-image MEASURED proof can still remain deferred to RS-D.

**Acceptance checks:** give the reader the correct DB but S another otherwise-ready DB/runtime secret, then require refusal before listening/successful IDENTITY; cover TCP runtime URLs in production, copied registration/instance UUIDs and wrong owner-executor DB. The Docker DI seam may exercise these comparisons as UNVERIFIED regression evidence, with production Unix binding still explicitly pending.

### R2 — P1: Specify and test the owner executor's hard lifetime and orphan cleanup

**Location:** brief lines 98–106, 143–146, 295–315, 329.

The draft calls the executor short-lived and gives SQL statement/lock timeouts, but its termination rules cover only S. The outer two-second deadline closes the command channel and latches uncertainty; it does not say who terminates an executor blocked in connection establishment, secret resolution, IPC or COMMIT, nor what happens if O/C disappears. SQL timeouts alone do not bound those phases. An orphan can retain an owner-authenticated handle after the explicitly owner-initiated operation has failed, contrary to RC4's operation-scoped owner-handle contract.

**Required repair:** pin one monotonic operation deadline including spawn/connect/transaction/result, executor parent-channel-loss behavior, bounded termination/reaping on all timeout/error/owner/controller shutdown paths, and connection/transaction cleanup in `finally` or process termination. Preserve COMMIT_UNKNOWN, no fresh closure and no automatic retry when commit may have been sent; terminating a process must never be reported as proof of rollback.

**Acceptance checks:** actual child blocked before connect/result, parent EOF/death and deadline during/after COMMIT. Assert no surviving executor/owner session after the cleanup bound, one spawn, uncertainty latch and no closure. Define separately any cleanup grace after the two-second response deadline.

### R3 — P2: Make the pricing tuple executable under the exact column grants

**Location:** brief lines 197–202 and 240–242; current `prisma/askremote.prisma` lines 11–40 and 71–93.

The snapshot must inspect DISTINCT `(profile, priceRevision, reserve, promptRate, completionRate)` over the policy and every project attempt. The exact definer grant list omits `RemoteAskAttempt.promptRate` and `completionRate`. The policy has neither rate column, and attempts call the reservation field `reservedMicroUsd`, not `reserveMicroUsd`. As written, implementing that check either fails privileges/SQL or silently departs from the supposedly exact allowlist.

**Required repair:** explicitly define the policy tuple using the accepted fixed rate constants, the attempt tuple using its actual immutable rate/reservation columns, and add exactly the two required attempt SELECT columns to provisioning/readiness specifications. Keep those internal rates out of the exported payload. Do not weaken the all-project profile/price comparison into a current-policy-to-itself check.

**Acceptance checks:** positive snapshot as the actual confined evidence definer, exact grant/readiness parity including both rates, wrong policy expectation, historical attempt price mismatch and mixed tuples. No change to the accepted pricing CHECKs or financial routines is needed.

### R4 — P2: Reconcile effective reader EXECUTE confinement with existing PUBLIC helpers

**Location:** brief lines 210–214; current `prisma/roles.sql` lines 103 onward and `packages/graph/fence-role.ts` `FENCE_SHARED_INVOKER_ROUTINES`.

“Reader ... user-routine EXECUTE is the snapshot only” cannot hold literally with the unchanged accepted database: shared SECURITY INVOKER functions such as `public.atlas_app_workspace()` are callable through PUBLIC. Existing complete-surface checks explicitly allow a fixed schema-qualified helper set via PUBLIC. A new role cannot revoke its individual share of a PUBLIC privilege. Applying the draft literally either rejects every correctly provisioned reader or requires forbidden changes to ancestor grants.

**Required repair:** distinguish the reader's single explicitly granted export/SECURITY DEFINER capability from unavoidable accepted PUBLIC invoker helpers. Pin the exact schema-qualified shared helper exception, require SECURITY INVOKER, deny explicit grants/grant options and every other user routine, and apply matching provisioning/readiness checks to both new roles. Preserve all ancestor ACLs and the exact remote-nine/reval-two counts.

**Acceptance checks:** a stock migrated database provisions successfully; a new PUBLIC user function, SECURITY DEFINER helper substitution, same-name function in another schema or explicit unexpected routine grant fails closed. The snapshot remains the only new reader export capability.

### R5 — P2: Include the Prisma files that must contain inverse relations

**Location:** brief lines 155–164, 177, 363–375; current `prisma/askremote.prisma`.

The new registration model references `RemoteAskPolicy` and `RemoteAskClientAdmission`, whose model declarations are in `prisma/askremote.prisma`. Prisma requires inverse relation fields on those models. The brief permits bounded edits only to `prisma/schema.prisma`, so the stated models plus successful schema validation/drift cannot be implemented within the exact allowed-file list.

**Required repair:** authorize minimal inverse-relation additions in `prisma/askremote.prisma` (or state another valid schema organization that leaves accepted models intact), add that path's baseline/new identity to the checkpoint delta, and explicitly prohibit changes to existing fields/constraints/financial behavior. This is schema wiring within the already accepted registration design, not a new architecture concern.

**Acceptance checks:** `schema:validate`, Prisma generation as needed by the harness, drift validation and populated upgrade tests; existing remote model semantics/data unchanged.

## A1–A9 classification

| Choice | Classification in this review |
|---|---|
| A1 inherited O→C socketpair | Within NB5's concrete local launch/topology work: private inherited AF_UNIX connection, direct-parent incarnation proof and explicit O launch preserve authority/isolation. It does not authorize changing I's later filesystem socket or dropping peer proof. |
| A2 internal executor/wrapper frames | Within implementation, provided closed shapes remain private and exported 01/02/06 schemas are byte-contract compatible. R1/R2 require additional precise internal binding/lifetime rules. |
| A3 register/population deferred | Consistent with RS-B's isolated fixture/source-maintenance boundary; RS-A creates schema and synthetic test rows only. No real registration/readiness claim is admitted. |
| A4 no runtime Reval privileges yet | Conservative phased implementation; later exact read grants and readiness changes remain separately reviewed. It does not excuse R1's actual runtime endpoint binding. |
| A5 Ask OFF bridge | Conservative required admission boundary until RS-C's lifetime ingress gate; no remote/mock activation. |
| A6 bridge-only secret-file runtime input | A bounded credential resolver choice consistent with RC4, subject to R1's endpoint restriction and ordinary API behavior remaining unchanged. No credential value enters C or metadata. |
| A7 uncertainty latch | Conservative implementation of unknown-commit/no-retry rules, with R2 needed to finish handle cleanup. |
| A8 fixed constants plus protected price expectation | Within the existing requirement to compare against an approved policy expectation, if kept as separate owner-local administrative configuration, never an exported identity-record/schema extension or a substitute for future owner price/data/budget admission. R3 makes the check executable. |
| A9 unsupported platform refusal / test-only TCP | Preserves fail-closed platform/physical-binding rules. Existing owner tools remain outside RS-A closure claims. No production TCP alternative is approved. |

None of those choices, with the stated limits and required repairs, needs a fresh Astra/Fable gate. This is not approval of exceptions to RC4's critical invariants.

## Nonblocking implementation notes

- PostgreSQL permissive policies OR together: the PUBLIC workspace policy and role-specific reader-OID policy do not by themselves form an AND. Implement “find by session_user OID” as an explicit immutable predicate and verify the selected row against the captured login; test stale/foreign `app.*` GUCs, removed/recreated reader OID and multiple registrations. Do not rely on the added policy alone as the selector.
- Pin the missing-referenced-counter result. Returning `CENSUS_UNAVAILABLE` is a valid integrity refusal; an inconsistent payload must not zero-fill or present a partial census as complete. Test this separately from a true missing current-period zero and from a present counter/sum mismatch.
- The native helper intentionally receives fd 4, so qualify “children only 0–3” to exclude that bounded helper invocation and account for its descriptors. Include real owner UPDATE/DELETE/TRUNCATE guard and binding-generation/FK negatives in the focused PG tests. Spell out a test-only launch entrypoint/DI topology that exercises real Darwin peer proof without exposing TCP selection through production scripts/config.

## Preserved scope and remaining acceptance

RC2_MINOR's exact reread equality rule is clear: any intervening policy/fence change refuses a fresh closure. Strict floors, no-op semantics, four-key boolean closure, unknown-commit/no-retry, full project count, foreign-scope count without IDs, original periods and liability semantics are retained. The proposed suite is broad and relevant; actual results belong to code acceptance and must be tied to its new source/build/dirty-file manifest. Both independent code reviewers must accept that same identity before dependent checkpoint work.

Actual Darwin peer/PID-incarnation proof is mandatory before DB or owner effects. Full `loadedBinding` stays UNVERIFIED until RS-D; the untested host-local PostgreSQL physical-binding path cannot be called measured by Docker tests. No manufactured verified zeros or live readiness. RS-B/RS-C/RS-D, human/account/key/data/budget admissions, provider calls, policy activation, real customer use and deployment remain outside this brief acceptance. Paid product calls made by this review: 0.
