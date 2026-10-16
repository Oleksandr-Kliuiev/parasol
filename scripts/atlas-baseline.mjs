import { relative, resolve } from 'node:path';
export function evaluate(events, baseline, cwd, exitCode) {
  const summary = events.findLast(e => e.type === 'test:summary' && !e.file);
  const failures = events.filter(e => e.type === 'test:fail');
  const issues = [];
  if (!summary || summary.counts.tests < baseline.minimumTests || summary.counts.cancelled > 0) issues.push('Incomplete test run');
  if (summary && summary.counts.failed !== failures.length) issues.push('Failure count does not match reporter');
  if (exitCode !== (failures.length ? 1 : 0)) issues.push('Unexpected test runner exit');
  const observed = new Set();
  for (const failure of failures) {
    const file = relative(cwd, failure.file).replaceAll('\\', '/');
    const expected = baseline.failures.find(e => e.file === file && e.name === failure.name);
    const key = `${file}:${failure.name}`;
    const diagnostics = events.filter(e => ['test:stderr', 'test:stdout'].includes(e.type)
      && resolve(cwd, e.entryFile ?? e.file) === failure.file).map(e => e.message).join('');
    if (!expected || observed.has(key) || !failure.error?.message.includes(expected.messageIncludes)
        || (expected.diagnosticIncludes && !diagnostics.includes(expected.diagnosticIncludes))) {
      issues.push(`Unexpected failure: ${key} — ${failure.error?.message ?? 'no error'}`);
    }
    observed.add(key);
  }
  return { issues, failures, summary };
}
