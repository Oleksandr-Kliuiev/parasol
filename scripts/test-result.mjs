/** A successful process alone is insufficient: skipped, flaky or globally failed browser tests fail the gate. */
export function requireBrowserPass(report, exitCode) {
  const stats = report?.stats;
  if (exitCode !== 0 || !stats || !Number.isInteger(stats.expected) || stats.expected < 1
      || stats.unexpected !== 0 || stats.skipped !== 0 || stats.flaky !== 0 || report.errors?.length) {
    throw new Error('Browser acceptance requires a complete pass with no failures, skips, flaky retries or global errors.');
  }
  return stats;
}
