// TEST-ONLY preload for tests/pilot-process.test.ts: proves that an injected `--import` module DID load and that the pilot
// driver still refuses the process before any output file, database or network access. It touches nothing but a marker file.
import { writeFileSync } from 'node:fs';

const marker = process.env.PILOT_PRELOAD_MARKER;
if (marker) writeFileSync(marker, 'loaded');
