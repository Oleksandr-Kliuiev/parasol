import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// S5-A browser E2E (npm run test:ui, after api:build): the real built console served by the compiled API with its CSP.
// No trace, video, HAR or failure screenshot is ever captured (tokens must not reach artifacts); output stays outside the
// repository. Visual screenshots are written only by console-visual.spec.ts, only when ATLAS_UI_VISUAL_DIR is set.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: join(tmpdir(), 'atlas-operator-ui-output'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    bypassCSP: false,
    serviceWorkers: 'block',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    acceptDownloads: false
  }
});
