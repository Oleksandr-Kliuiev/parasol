# Astra S2-B-rc3 — APPROVE

2026-10-08. Fresh native GPT-6 Astra (gpt-6-astra), effective xhigh; explicit native assignment confirmed by Codex,
no model/effort change or fallback requested. Native tools expose no separate upstream response-model/billing fields.
Artifact: 9fdffa82f8355ab1e4920046001a0e449a75cc7227d69dc45593bd6e00e023d1,269 payload files.
HEAD916a4d69853ff6da636e8609a2e0bd33aa787f66. Tasks2.4–2.6/S2-B plus relevantStage1/S2A regressions accepted.

## Required findings closed

- R1: directory claims durably charge eight-attempt budget; recorded transient failures persist capped backoff or exact
  accepted Retry-After. Exhaustion refuses further claims/I/O. Authorized audited reset retains last-good and fences old
  claims. Populated upgrade preserves charges/throttles; runtime requires new column grant.
- R2: initial insertion precedes locked admission. Controlled concurrent first-state regression confirms no premature
  sequence/generation/secret/upstream request while respecting persisted retryAt.
- R3: terminal root outcomes preserve COMPLETE/FAILED, stored codes/counters before maintenance; distinct HELD/NOT_DUE,
  no unintended repeat-pass I/O.
- R4: directory sync/reset and sign-in request/run/requeue append one safe workspace denial. Withdrawal stops calls/
  publication; rejected client failure transactions create no client audit. Audit-write failure is explicit.

## Independent verification

All checkout/ZIP payload hashes, aggregate,24 modified+9 new RC2 delta,accepted S2A baseline,11 normativeRC5 files,
accepted migrations and protectedStage1 report verified. Ten archived final log hashes verified. Full checkpoint:
132 unit/PGlite+240 PostgreSQL tests,zero fails/skips; schema/generate/types/build/smoke/PG17/zero drift/whitespace PASS.
Native command-exit provenance supplied by Codex inspection of actual Claude tool results.

Two independent existing-test commands:93+36=129 passed,0 fail/cancelled/skipped,exit0,7.291s+5.533s. Coverage:
adapter/activation,allfour repairs,recovery/publication,populated upgrades,PGlite budget guards,publication races,runtime
privileges and cleanup confinement. Final payload rehash matchedRC3;git diff--check passed. No implementation edits or
newly constructed probes. No new obligatory findings. Inspected legacy public shapes/Decisions privacy preserved.

## Scope and remaining gates

Synthetic transport and disposable databases only. S2-C APIs/tools/CLI/correlation/full retention service,LIVE and
deployment remain separate. Request state OPEN follows documented design; per-root outcomes authoritative. No claim of
production/live acceptance. This report accepts the exact RC3 payload.

Codex administrative note: the final status-only overlay retains all code/requirements/evidence identities.
