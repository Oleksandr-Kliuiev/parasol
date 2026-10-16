# R-EVAL RS-A entries routing

Production entries only (brief `docs/stage5/ask/remote/reval-server/rs-a/IMPLEMENTATION_BRIEF.md` §2a):
`owner.ts` (O, the owner's terminal), `controller.ts` (C, spawned by O only), `owner-exec.ts` (E, spawned by C only),
`build-peer.ts` (fixed clang build of `native/reval-peer/peer.c`). They wire `productionDeps()` and accept no DI flag,
environment or config field selecting TCP or relaxing TTY/peer checks. Test entries live under `tests/support/reval-test-*`.
RS-B adds `maintain.ts` (offline owner maintenance: probe/register/install, unix deps only) and `fixture-verifier.ts` (V, spawned by
C only, empty env). Brief: `docs/stage5/ask/remote/reval-server/rs-b/IMPLEMENTATION_BRIEF.md`.
RS-C-A adds no production entry: S stays `dist/apps/api/src/main.js` (bridge composition in `apps/api/src/reval/evaluation.ts`); the
test instrument `tests/support/reval-test-instrument.ts` is test-only until the RS-C-B instrument revision.
