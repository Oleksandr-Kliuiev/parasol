import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewDirectory, validateOverviewQuery } from '../packages/m365/overview.ts';
import type { OverviewDirectoryState } from '../packages/m365/overview.ts';

const now = new Date('2026-10-17T12:00:00Z');
const state = (secondsAgo = 60): OverviewDirectoryState => ({ status: 'OK', safeErrorCode: null,
  activeGenerationId: 'synthetic-generation', latestStartedSeq: 1, latestPublishedSeq: 1,
  lastSuccessAt: new Date(now.getTime() - secondsAgo * 1000), activeGeneration: {
    completedAt: new Date(now.getTime() - secondsAgo * 1000), expiresAt: new Date(now.getTime() + 3600000), rowCount: 0 } });

test('M365 overview admits no caller tenant, connection, window, permissions, pagination or repeated query override', () => {
  validateOverviewQuery({});
  for (const raw of [null, [], 'tenant', { tenant: 'other' }, { connectionId: 'other' }, { from: '2026-10-17' },
    { clientId: ['other','third'] }, { permissions: ['m365:read'] }, { cursor: 'old' }]) {
    assert.throws(() => validateOverviewQuery(raw), { code: 'M365_OVERVIEW_INPUT_INVALID' });
  }
});

test('M365 overview distinguishes usable empty directory from missing, failed and expired snapshots', () => {
  const fresh = overviewDirectory('m365_user', state(), now);
  assert.deepEqual([fresh.status, fresh.count], ['OK', 0]);
  assert.deepEqual(Object.keys(fresh).sort(), ['asOf','count','lastSuccessAt','resourceType','status']);
  const missing = overviewDirectory('m365_user', null, now);
  assert.deepEqual([missing.status,missing.count,missing.asOf], ['MISSING',null,null]);
  const failure = { ...state(), status: 'ERROR', activeGenerationId: null, activeGeneration: null, safeErrorCode: 'synthetic private code' };
  assert.deepEqual([overviewDirectory('m365_user',failure,now).status, overviewDirectory('m365_user',failure,now).count], ['ERROR',null]);
  const expired = state(); expired.activeGeneration!.expiresAt = now;
  const view = overviewDirectory('m365_device', expired, now);
  assert.deepEqual([view.status, view.count, view.asOf], ['MISSING',null,null]);
  assert.ok(!JSON.stringify(view).includes('synthetic-generation'));
  assert.ok(!JSON.stringify(overviewDirectory('m365_user',failure,now)).includes('private'));
});

test('M365 overview retains stale counts without calling them fresh, including failed or pending newer attempts', () => {
  const old = state(3600); old.activeGeneration!.rowCount=12;
  assert.deepEqual([overviewDirectory('m365_device',old,now).status,overviewDirectory('m365_device',old,now).count],['STALE',12]);
  const pending = { ...state(), latestStartedSeq: 2 };
  assert.equal(overviewDirectory('m365_user',pending,now).status,'STALE');
  pending.status='ERROR'; pending.safeErrorCode='synthetic private failure';
  const view=overviewDirectory('m365_user',pending,now);
  assert.equal(view.status,'STALE'); assert.equal(view.asOf,pending.activeGeneration!.completedAt!.toISOString());
  assert.ok(!JSON.stringify(view).includes('private'));
});
