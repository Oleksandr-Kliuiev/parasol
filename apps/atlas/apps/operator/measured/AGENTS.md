# Measured evaluation console (R-EVAL RS-C-C) routing

Brief: `docs/stage5/ask/remote/reval-server/rs-c/IMPLEMENTATION_BRIEF_C.md` §3. This is a SEPARATE sealed build (`scripts/operator-measured-build.ts`
→ `dist/operator-measured/`) served ONLY by the measured bridge server (`apps/api/src/reval/evaluation.ts`). The ordinary console (`../src`,
`dist/operator`) never contains these modules and stays byte-identical. Never import these modules from `../src`.
- `eval-contracts.ts` browser copies of the handoff DTOs/token/caps (parity: `tests/operator-eval-contracts.test.ts`).
- `credential-measured.ts` the measured holder: accepted operations + PAIR, evaluation Ask (session header), RESPONSE; bearer and session token only here.
- `eval-transport.ts` bounded exchanges (accepted transport/validators); keeps the exact parsed body/correlation/receipt for the handoff only.
- `eval-state.ts` / `eval-controller.ts` the 04 transition table (generations, capture-then-clear, stale completions, external invalidations).
- `view-eval.ts`, `index.html`, `main-measured.ts` DOM (createElement/textContent only) and composition (accepted Ask form masked OFF).
Same rules as `../AGENTS.md`: no innerHTML/inline script/storage/URL/log of secrets; fixed codes only; no retry; no automatic pair/choice/consent/submit.
Tests: `tests/operator-eval-{contracts,controller,errors}.test.ts`, `tests/reval-measured-build.test.ts`, `tests/ui/eval-{pane,artifact,200}.spec.ts` (200 paths need `ATLAS_REVAL_E2E_200=1`, paced ≥ 20 min),
`tests/pg/reval-eval-console.pg.test.ts`.
