# S4-B RC1 orchestration evidence

Actual source B1–B5 only; independent acceptance PENDING. No S4-C or LIVE.
Native implementer returned sole checkout write ownership to Codex after exit0, session
31d86f05-6b73-4a5e-ab01-03ce82245c2a, actual assistant.model claude-opus-5-5, explicit high,
native claude.ai Max firstParty, extra usage disabled/no provider overrides/no fallback credits.
Elapsed3276.1s. Raw stream/brief/receipts/focused failed and passing runs/final11checks preserved
under ~/.codex/atlas-evidence/stage4/S4B_RC1/. Raw SHA is in OPUS_EXECUTION receipt.
numTurns/rawUsage in that receipt describe the final SDK segment after background continuation,
not the entire execution. API dollar estimate and cache counts are not subscription quota.
Attributable subscription usage remains unknown.

Final required suite:208 unit/PGlite and507 PG, all11commands passed on unchanged source inventory.
The implementer's prose says34 new PG tests; its own categories total32 (8+5+7+6+4+2), matching
507 minus accepted A's475. Preserve report verbatim; canonical final counts are208 and507.

FK evidence qualification: four real Connection-vs-Stage4 deadlock victim cases use an owner
transaction holding SELECT FOR UPDATE, followed by the direct non-key lifecycleVersion UPDATE.
They cover each victim at both admission/publication with real PG40P01 and no partial effects.
A separate plain non-key UPDATE case serializes rather than deadlocks; an Actor FOR UPDATE case
also covers the FK residual. Per-owner-session deadlock_timeout chooses deterministic victims.
No Stage4 Connection tuple lock added. The frozen handoff's implication that every BEFORE-trigger
UPDATE gets an exclusive tuple lock is overbroad; actual evidence above must control the claim.
Astra independently assesses this coverage against the mandatory B2/B4 contract.

Failed builtin/composition/sync test expectations, privacy stdout-protocol hang and publication
victim flake are retained. Privacy was redesigned to real child stdout/stderr capture and an
observing socket/fetch trap with a local synthetic positive control. No vendor/tenant I/O.
Two killed-run disposable databases and roles belonging to this implementation were cleaned;
two older unrelated atlas_it databases were left untouched. No universal zero-leftover claim.
Shared/global/builtin/host-capable ACL probes are rollback-only. Existing disposable DB-local
synthetic PUBLIC fixtures may commit with finally repair/drop; no universal no-PUBLIC-commit claim.
No persistent DB/pilot/binding/account/deployment changes, financial writes or schedules.

Astra should inspect actual private module/capability boundaries and complete immutable fact
provenance, replay/retry/deadline semantics, fresh page authority, failure/recovery and privacy.
Internal exports/test seams must not become operator-selectable authority at S4-C integration.
