# R-EVAL offline tooling — context routing

OFFLINE ONLY. No live mode, key, environment input, provider call, DB, browser, schedule or network path may be added
here; a live run is a separate owner admission through the accepted V2 server path, never through this code.
Do not load the dataset files into context (`docs/stage5/ask/remote/eval/data/AGENTS.md`).

Modules (one concern each, ≤500 lines):
- `net-guard.ts` fail-closed process network guard (no allowlist/uninstall); `guard-preload.ts` side-effect import for tests.
- `cli.ts` entry: installs the guard, then dynamically imports `commands.ts` (verify, harness, rehearse, guard-selftest, all,
  write-manifest, write-review-templates).
- `dataset.ts` corpus load/validation, matrix, diversity, stable order. `evidence.ts` manifest, safe receipt scan, unverified list.
- `fixtures.ts` declarative fixtures → original rows → ACCEPTED source validators; independent reachability rules.
- `predicates.ts` independent local-truth comparator incl. full displayed fact data (type-only imports; must not import
  production code). `expected-facts.ts` expected fact data derived only from the frozen raw fixture rows.
- `provider-stub.ts` scripted in-memory upstream envelopes. `harness.ts` accepted pure pipeline per case and fixture matrix.
- `supervisor.ts` SIMULATED manual-procedure state machine (not product authority): absorbing terminal states, safety
  categories, publication/settlement distinctions, monotonic version/fence closure floor. `rehearsal.ts` simulated server/ledger
  and step driver; `scenarios.ts` scripted scenarios with plan-derived expectations.
- `adjudication.ts` human review templates/validator (HUMAN reviewers only).

Tests: `tests/ask-remote-eval-{corpus,fixtures,supervisor,offline}.test.ts`.
