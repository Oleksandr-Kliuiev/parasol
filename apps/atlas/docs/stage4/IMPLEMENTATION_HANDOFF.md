# Stage 4 implementation handoff obligations

Administrative handoff for approved S4-design-rc2 package
`d848b026efcc2af30c7900ef6f5325e31c04c11825d4ec089dcf6baf984873ec`.
The frozen eight normative files are unchanged. This file carries the approved Fable review's implementation clarifications;
it is not code acceptance or new LIVE admission. Every S4-A/S4-C task brief MUST include the applicable text below and its
acceptance cases. S4-B also carries publication/FK/replay cases. Independent code acceptance must verify actual behaviour.
No unresolved architecture blocker is being relabelled as code acceptance: Fable explicitly approved this exact artifact
and required these details in implementation briefs rather than a normative amendment.

## Reviewer requirements (verbatim)

1. **P2 — RLS composition on new tables is underspecified.** `docs/stage4/03_DATA_AND_CONCURRENCY.md:100-102` requires definer policies scoping all three IDs via GUCs, but PostgreSQL permissive policies are OR-ed. If the new tables also carry the usual PUBLIC `_scope` policy (workspace + client, as every existing table does), the connection-level restriction has no RLS effect for the definer. Required: state that the definer policy is `AS RESTRICTIVE` (or that the scope policy is role-targeted). Acceptance: as the definer with `app.client_ids` = client A and `app.poweroffice_connection_id` = connection X, a direct SELECT on Snapshot/Attempt/State returns zero rows of connection Y of the same client; add to C3.

2. **P2 — Purged-snapshot invariant must be one-directional.** `03:33-34` says "lastSuccessAt/published pointer cannot diverge", yet cleanup clears `snapshotId` while the EXPIRED/purged precedence row (`04:51`) needs `lastSuccessAt` retained, and the definer has no `lastSuccessAt` UPDATE grant (`03:90`). Required: state the invariant as "snapshotId non-null ⇒ lastSuccessAt equals that snapshot's publishedAt; snapshotId null with non-null lastSuccessAt is the purged state". Acceptance: publish → purge → status read returns EXPIRED/SNAPSHOT_EXPIRED/null and lastCompleted SUCCEEDED; constraint test that a non-null pointer with mismatched lastSuccessAt is refused.

3. **P3 — "Deferrable COMMIT constraints" need the mechanism named.** `03:31-32` cannot be met by CHECK or partial FKs; it requires `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` invoker functions with PUBLIC EXECUTE revoked. Acceptance: within one transaction insert an ACTIVE attempt without updating the pointer and show the COMMIT fails; same for pointer without ACTIVE row.

4. **P3 — FK row locks after the fence are a known deadlock class, not covered by the "no Connection lock after fence" wording.** INSERTs into State/Attempt/Snapshot take KEY SHARE on the Connection row and Attempt takes KEY SHARE on the Actor row (`03:5,19`). A concurrent Connection or Actor UPDATE holds an exclusive tuple lock (BEFORE ROW triggers force it) while waiting for the fence, which yields 40P01. The design's fixed DB_CONFLICT code and the publication-only known-rollback policy handle this correctly, and Stage 3 has the same exposure. Required: note it in the brief so admission does not retry and publication retries only on 40P01/40001 with the same fact. Acceptance: the existing "concurrent direct Connection UPDATE against admission/publication/cleanup" cases in 06 (B2/B4/C3) must include the victim being the Stage 4 transaction and the victim being the Connection UPDATE, each with zero partial effects.

5. **P3 — HTTP status for a read on an invalid-binding connection is ambiguous.** `02:82-83` maps binding failure to 503; `04:50` returns a DTO with status UNAVAILABLE. Required: pin one (recommended: 200 with UNAVAILABLE DTO for status/summary reads; 503 only for mode/readiness and sync admission). Acceptance: one HTTP case per 04 precedence row recording the status code, plus a non-PowerOffice connection ID under an authorised client returning 404 with synthetic:true.

6. **P4 — Identical-fact replay after `deadlineAt`.** `03:64-69` requires DB clock below `deadlineAt` for publication and separately promises a stable receipt after lost acknowledgement. State explicitly that a replay of an already SUCCEEDED attempt with identical fact returns the no-op receipt regardless of deadline, never a payload, after fresh auth/binding checks. Acceptance under B4.

7. **P4 — Seeding path for the FIXTURE PowerOffice connection.** C4 (`06:20`) starts at "seed synthetic", but no doc names the component. Connection INSERT with status FIXTURE, provenance and lifecycleVersion 1 is permitted by the installed CHECKs and triggers, and `bindConnection` correctly refuses (`packages/connections/connections.ts:23`). State that the seed is test/fixture code only.

8. **P4 — Audit key naming.** Metadata key `outcome` (`02:92-94`) mirrors the `SecurityAuditEvent.outcome` column name; harmless in JSON but worth an explicit comment to avoid confusion in the C3/C4 privacy capture.

## Concrete handoff choices within the accepted contracts

- RLS: use role-targeted policies on all three new tables, or a dedicated `AS RESTRICTIVE` three-ID definer policy in
  conjunction with the permissive workspace/client scope. Choose the latter for the task brief. Verify same-client
  connection X/Y isolation under the actual non-superuser definer; readiness checks inspect permissive/restrictive flags.
- Purged state: snapshotId non-null implies lastSuccessAt equals that snapshot's publishedAt; a cleared snapshot pointer
  preserves lastSuccessAt. Cleanup has no lastSuccessAt UPDATE grant. All lastCompleted outcome/FK retention rules remain.
- Deferred invariants: explicit invoker CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, fixed qualified relations and
  migration-time PUBLIC EXECUTE revoke. FK/trigger locks can still deadlock with direct auth/binding mutations; admission
  returns fixed conflict with no retry, publication max3 known-rollback SAMEfact transactions, no extra port call.
- HTTP: preserve02's binding503 mapping. After current read authorization, a visible PowerOffice binding/lifecycle failure
  returns HTTP503 with the strict UNAVAILABLE read DTO and null summary. Other authorized read precedence states return200.
  Mode/readiness failures return503 synthetic error envelopes; unknown/invisible/non-PowerOffice returns404 synthetic
  error; authentication401 and scope/permission403 remain. Every row is tested through actual HTTP. Fable's200 alternative
  was a recommendation, not a requirement; the selected503 interpretation preserves the accepted explicit mapping.
- Identical SUCCEEDED receipt after original deadline: fresh sync authority (the same all-of permissions as publication) and unchanged current binding still
  required; full owned fact equality, no-op receipt only, no financial payload or duplicate audit. The deadline applies
  to new publication of ACTIVE claims; no claim revival or new export. Test deadline, revocation, binding and changed fact.
- Synthetic FIXTURE seeding is trusted test/fixture code only; no CLI/onboarding/automatic binding entry is added.
- Audit JSON outcome is a local operational enum, distinct from SecurityAuditEvent.outcome; the six-key metadata limit,
  no financial/deletion counts and workspace-denial rules remain exact. sequence is only an operational ordinal.

## Operational residuals for future runbook work

Explicit cleanup can hold the workspace fence for up to10s, blocking Stage3 admissions, Stage4 reads and auth mutation;
1000 attempts with30day retention may prevent sync until eligible rows age/purge. Every successful read inserts a client
audit row. These are accepted MOCK operational limits, to document/test before UI, scheduling or LIVE. No vendor accounting
semantics, completeness or production readiness are verified. Implementation is still NOT_STARTED; start at S4-A only.
