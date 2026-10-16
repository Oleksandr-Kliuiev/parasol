/** A successful process alone is insufficient: skipped, todo or cancelled tests fail the gate. */
export function requireCompletePass(events, exitCode) {
  const summary = events.findLast(e => e.type === 'test:summary' && !e.file);
  if (exitCode !== 0) throw new Error(`Test process failed (exit ${exitCode}).`);
  if (!summary?.counts || !Number.isInteger(summary.counts.tests) || summary.counts.tests < 1) throw new Error('Missing or empty test summary.');
  const counts = summary.counts;
  for (const key of ['failed', 'cancelled', 'skipped', 'todo']) {
    if (counts[key] !== 0) throw new Error(`Incomplete test acceptance: ${key}=${counts[key]}.`);
  }
  if (counts.passed !== counts.tests || events.some(e => e.type === 'test:fail')) throw new Error('Inconsistent test results.');
  return counts;
}

export function requireBrowserPass(report, exitCode) {
  const stats = report?.stats;
  if (exitCode !== 0 || !stats || !Number.isInteger(stats.expected) || stats.expected < 1
      || stats.unexpected !== 0 || stats.skipped !== 0 || stats.flaky !== 0 || report.errors?.length) {
    throw new Error('Browser acceptance requires a complete pass with no failures, skips, flaky retries or global errors.');
  }
  return stats;
}
