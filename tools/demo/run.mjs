import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runComposition } from '../composition/run.mjs';
import { jsonFile } from '../composition/runtime.mjs';
import { demoDescriptor, parseDemoArgs, waitForDemoStop } from './session.mjs';

export async function runDemo(options) {
  // Validate direct module callers as strictly as the CLI; no image/source/credential overrides.
  const validated = parseDemoArgs(['--directory', options.directory, '--minutes', String(options.minutes ?? 30)]);
  let descriptor;
  try {
    const report = await runComposition({ directory: validated.directory, skipBuild: false, skipBrowser: true }, {
      onReady: async (fixture, signal) => {
        descriptor = demoDescriptor(fixture, validated.minutes);
        await jsonFile(join(validated.directory, 'demo.json'), descriptor);
        console.log(`Local Parasol demo: ${descriptor.baseUrl}`);
        console.log(`Synthetic data only; stops at ${descriptor.expiresAt} or Ctrl+C.`);
        for (const login of descriptor.logins) console.log(`${login.role}: ${login.url}`);
        console.log(`Walkthrough: docs/testing/LOCAL-DEMO.md. Session: ${join(validated.directory, 'demo.json')}`);
        return waitForDemoStop(signal, validated.minutes * 60_000);
      },
    });
    await jsonFile(join(validated.directory, 'demo.json'), { ...descriptor, status: 'stopped',
      stoppedAt: new Date().toISOString(), stopReason: report.demo.stopReason, cleanup: report.cleanup, acceptanceRun: false });
    return report;
  } catch (error) {
    // An existing/foreign directory is never written: descriptor exists only after this run owns the fresh fixture.
    if (descriptor) {
      const report = await readFile(join(validated.directory, 'report.json'), 'utf8').then(JSON.parse).catch(() => null);
      await jsonFile(join(validated.directory, 'demo.json'), { ...descriptor, status: 'failed',
        stoppedAt: new Date().toISOString(), cleanup: report?.cleanup === true, acceptanceRun: false });
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runDemo(parseDemoArgs(process.argv.slice(2))); }
  catch {
    console.error('Local demo did not complete. Inspect its bounded report when created.');
    console.error('Usage: npm run demo:local -- --directory <new absolute path> --minutes <1..120>');
    process.exitCode = 1;
  }
}
