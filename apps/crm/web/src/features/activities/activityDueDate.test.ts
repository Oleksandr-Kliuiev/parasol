import { spawnSync } from 'node:child_process';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { expect, it } from 'vitest';
import { activityDueDraft, activityDueValue } from './activityDueDate';
import source from './activityDueDate.ts?raw';

function inOslo(probe: string) {
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `${code}\n${probe}`], {
    encoding: 'utf8', env: { ...process.env, TZ: 'Europe/Oslo' },
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as unknown;
}

it('uses Oslo wall time and preserves exact winter, summer and both repeated-hour instants in an isolated timezone', () => {
  // CI may use UTC. Only this child receives TZ; the shared test process stays unchanged.
  const probe = `
    const originals = ['2025-01-15T09:15:23.456Z', '2025-07-15T09:15:23.456Z',
      '2025-10-26T00:30:45.678Z', '2025-10-26T02:30:12.345+01:00'];
    const drafts = originals.map(activityDueDraft);
    console.log(JSON.stringify({ inputs: drafts.map(d => d.input),
      unchanged: drafts.map(d => activityDueValue(d.input, d)),
      changed: activityDueValue('2025-01-16T10:00', drafts[0]),
      cleared: activityDueValue('', drafts[0]), created: activityDueValue('2025-07-16T11:00', activityDueDraft(null)) }));
  `;
  expect(inOslo(probe)).toEqual({
    inputs: ['2025-01-15T10:15', '2025-07-15T11:15', '2025-10-26T02:30', '2025-10-26T02:30'],
    unchanged: ['2025-01-15T09:15:23.456Z', '2025-07-15T09:15:23.456Z', '2025-10-26T00:30:45.678Z', '2025-10-26T02:30:12.345+01:00'],
    changed: '2025-01-16T09:00:00.000Z', cleared: null, created: '2025-07-16T09:00:00.000Z',
  });
});

it('rejects a nonexistent Oslo spring-forward minute and accepts the valid minutes on both sides', () => {
  expect(inOslo(`
    const initial = activityDueDraft('2025-01-15T09:15:23.456Z');
    let gapRejected = false;
    try { activityDueValue('2025-03-30T02:30', initial); } catch (error) { gapRejected = error instanceof RangeError; }
    console.log(JSON.stringify({ gapRejected, before: activityDueValue('2025-03-30T01:30', initial), after: activityDueValue('2025-03-30T03:30', initial) }));
  `)).toEqual({ gapRejected: true, before: '2025-03-30T00:30:00.000Z', after: '2025-03-30T01:30:00.000Z' });
});

it('rejects an invalid changed date before request construction', () => {
  expect(() => activityDueValue('not-a-date', activityDueDraft(null))).toThrow(RangeError);
});
