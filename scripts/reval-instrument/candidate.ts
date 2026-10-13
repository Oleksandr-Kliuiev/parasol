// The RS-D-C candidate layer of the chained identity (rs-d/IMPLEMENTATION_BRIEF_C.md §1). These are EXACTLY the files the RS-D-C
// package changes inside the accepted chain or adds as code (plus the sealed build inventory). They are RECORDED (one digest folded
// into the RC5-compatible identity), not pinned, because a package cannot pin its own manifest. Every other chain-pinned path must
// still match exactly. Once the RS-D-C seal exists, its `candidateSha256` must equal the recorded digest, so after acceptance only the
// accepted bytes run. Changing this list changes the revision (`instrumentRevisionSha256`).
export const CANDIDATE_ID = 'RS-D-C';
export const CANDIDATE_SEAL = 'verification/stage5/S5ASKREMOTE_REVAL_RSDC_APPROVED.json';
export const CANDIDATE_SEAL_STATUS = /^ACCEPTED_RS_D_C_RC[1-9][0-9]?$/;
export const CANDIDATE_PATHS: readonly string[] = Object.freeze([
  // accepted chain files changed by RS-D-C
  'apps/api/src/reval/evaluation.ts', 'docs/stage5/ask/remote/reval-server/rs-c/INSTRUMENT_RUNBOOK.md',
  'docs/stage5/ask/remote/reval-server/rs-d/AGENTS.md', 'docs/stage5/ask/remote/reval-server/rs-d/REVAL_RUNBOOK.md',
  'packages/reval/AGENTS.md', 'packages/reval/controller.ts', 'packages/reval/deps.ts', 'packages/reval/eval-journal.ts',
  'packages/reval/platform.ts', 'packages/reval/privacy-scan.ts', 'packages/reval/proof-payloads.ts', 'packages/reval/server-link.ts',
  'scripts/reval-instrument/AGENTS.md', 'scripts/reval-instrument/candidate.ts', 'scripts/reval-instrument/identity.ts',
  'scripts/reval-instrument/operator.ts', 'scripts/reval-instrument/receipt.ts', 'scripts/reval-instrument/run.ts',
  'tests/pg/reval-census.pg.test.ts', 'tests/pg/reval-eval-console.pg.test.ts', 'tests/pg/reval-instrument-e2e.pg.test.ts',
  'tests/pg/reval-launch.pg.test.ts', 'tests/pg/reval-native-instrument.pg.test.ts', 'tests/pg/reval-nb7-rehearsal.pg.test.ts',
  'tests/pg/reval-segments.pg.test.ts', 'tests/reval-handshake.test.ts', 'tests/reval-instrument-census.test.ts',
  'tests/reval-instrument-identity.test.ts', 'tests/reval-instrument-run.test.ts', 'tests/reval-platform.test.ts',
  'tests/support/reval-instrument-driver.ts', 'tests/support/reval-nb7-entry.ts', 'tests/support/reval-segment-entry.ts',
  'tests/support/reval-test-controller-entry.ts',
  // code added by RS-D-C
  'scripts/reval-instrument/build-inventory.ts', 'tests/pg/reval-rehearsal.pg.test.ts', 'tests/reval-fsync.test.ts',
  'tests/support/reval-segment-harness.ts', 'verification/stage5/S5ASKREMOTE_REVAL_RSD_BUILD_INVENTORY.json',
]);
