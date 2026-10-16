import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from './atlas-baseline.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = `${root}apps/atlas`;
const baseline = JSON.parse(readFileSync(`${root}docs/migration/atlas-baseline.json`));
assert.equal(Number(process.versions.node.split('.')[0]), baseline.nodeMajor, 'Use Node 24.');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
// This exception expires automatically with ANY tracked or untracked Atlas source change.
assert.equal(git('rev-parse', 'HEAD:apps/atlas'), baseline.sourceTree, 'Atlas changed: retire/review the inherited baseline before continuing.');
assert.equal(git('diff', 'HEAD', '--', 'apps/atlas'), '', 'Atlas working files changed.');
assert.equal(git('ls-files', '--others', '--exclude-standard', 'apps/atlas'), '', 'Unexpected Atlas source files.');
const files = readdirSync(`${cwd}/tests`).filter(f => f.endsWith('.test.ts')).sort().map(f => `tests/${f}`);
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test-concurrency=2',
  `--test-reporter=${root}scripts/test-events.mjs`, '--test', ...files], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
if (result.error) throw result.error;
const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const { issues, failures, summary } = evaluate(events, baseline, cwd, result.status);
if (issues.length) {
  for (const issue of issues) console.error(issue);
  process.exitCode = 1;
} else {
  const text = `Atlas: ${summary.counts.passed} passed, ${summary.counts.skipped} skipped, ${failures.length} inherited failures; no new failures.`;
  console.log(text);
  for (const failure of failures) console.log(`INHERITED: ${failure.name}`);
  if (process.env.GITHUB_ACTIONS && failures.length) console.log(`::warning title=Atlas upstream test debt::${text} See docs/migration/BASELINE.md. This is not full product test acceptance.`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Atlas import baseline\n\n${text}\n\nAll unit test files executed. Full acceptance remains blocked by upstream failures; see docs/migration/BASELINE.md.\n\n${failures.map(f => `- ${f.name}`).join('\n')}\n`);
}
