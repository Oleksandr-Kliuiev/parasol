import { describe, expect, it } from 'vitest';
import { connectionGaps, connectionStatus } from '../../test/connectionStatus';
import { parseConnectionStatus, refusingNow, type ConnectionStatusView } from './connectionStatusContract';

describe('the closed connection status of the CRM', () => {
  it.each([['a complete picture', connectionStatus], ['a picture with gaps', connectionGaps]])('accepts %s as it is', (_, make) => {
    const value = make(); expect(parseConnectionStatus(value)).toEqual(value);
  });

  it('accepts an unreadable state only without figures, worker or gaps', () => {
    const value = connectionStatus(); value.status = 'Unavailable';
    expect(parseConnectionStatus(value)).toBeNull();
    value.worker = null; for (const integration of value.integrations) integration.state = null;
    // M44: nor what a webhook did.
    expect(parseConnectionStatus(value)).toBeNull();
    for (const integration of value.integrations) integration.webhook = null;
    expect(parseConnectionStatus(value)).toEqual(value);
    value.gaps = [{ kind: 'Never', system: 'atera', job: 'atera-alerts', component: null, count: null }];
    expect(parseConnectionStatus(value)).toBeNull();
  });

  it.each([
    ['an unknown field', (v: ConnectionStatusView) => { Object.assign(v, { token: 'synthetic-private' }); }],
    ['a provider address', (v: ConnectionStatusView) => { Object.assign(v.integrations[0]!, { baseUrl: 'https://private.invalid' }); }],
    ['a sentence where a job name belongs', (v: ConnectionStatusView) => { v.integrations[0]!.state!.jobs[0]!.job = 'Synthetic private text'; }],
    ['an unknown status', (v: ConnectionStatusView) => { Object.assign(v, { status: 'CONNECTED' }); }],
    ['an invalid date', (v: ConnectionStatusView) => { v.checkedAt = 'yesterday'; }],
    ['a negative count', (v: ConnectionStatusView) => { v.integrations[0]!.state!.failedOutbound = -1; }],
    ['an unsafe integer', (v: ConnectionStatusView) => { v.integrations[0]!.state!.jobs[0]!.thresholdMinutes = Number.MAX_SAFE_INTEGER + 1; }],
    ['a missing worker beside read integrations', (v: ConnectionStatusView) => { v.worker = null; }],
    ['green beside a stale job', (v: ConnectionStatusView) => { v.integrations[0]!.state!.jobs[0]!.freshness = 'Stale'; }],
    ['green beside a run that failed after the last read', (v: ConnectionStatusView) => { v.integrations[0]!.state!.jobs[0]!.lastFailedAt = '2026-10-16T09:59:00Z'; }],
    ['green beside unsent changes', (v: ConnectionStatusView) => { v.integrations[0]!.state!.failedOutbound = 1; }],
    ['green beside a pause', (v: ConnectionStatusView) => { v.integrations[2]!.state!.paused = true; }],
    ['green beside a late worker part', (v: ConnectionStatusView) => { v.worker!.components[0]!.state = 'Late'; }],
    ['green beside a listed gap', (v: ConnectionStatusView) => { v.gaps = [{ kind: 'Paused', system: 'brreg', job: null, component: null, count: null }]; }],
    ['gaps without any listed', (v: ConnectionStatusView) => { v.status = 'Gaps'; }],
    ['a switched-off system said to be waiting for a read', (v: ConnectionStatusView) => { v.integrations[1]!.state!.jobs[0]!.freshness = 'Never'; }],
    ['a sentence where a webhook event belongs', (v: ConnectionStatusView) => { v.integrations[0]!.webhook!.lastEventType = 'Ticket from Ola Nordmann'; }],
    ['an unknown webhook refusal', (v: ConnectionStatusView) => { Object.assign(v.integrations[0]!.webhook!, { lastRefusal: 'Forged by 10.0.0.1' }); }],
    ['a webhook secret', (v: ConnectionStatusView) => { Object.assign(v.integrations[0]!.webhook!, { secret: 'whsec_synthetic' }); }],
    ['a missing webhook field', (v: ConnectionStatusView) => { delete (v.integrations[0] as Partial<ConnectionStatusView['integrations'][number]>).webhook; }],
  ])('rejects the whole reply for %s', (_, mutate) => {
    const value = connectionStatus(); mutate(value); expect(parseConnectionStatus(value)).toBeNull();
  });

  it('keeps a failure a later read recovered from out of the gaps', () => {
    const value = connectionStatus(); value.integrations[0]!.state!.jobs[0]!.lastFailedAt = '2026-10-16T09:00:00Z';
    expect(parseConnectionStatus(value)?.status).toBe('Ready');
  });

  it('keeps a refused webhook delivery out of the gaps: the scheduled reads go on (M44)', () => {
    const value = connectionStatus();
    Object.assign(value.integrations[0]!.webhook!, { lastRefusedAt: '2026-10-16T09:58:00Z', lastRefusal: 'BadSignature' });
    expect(parseConnectionStatus(value)?.status).toBe('Ready');
  });

  it('calls a webhook refusing only while no delivery was accepted after the refusal', () => {
    const webhook = connectionStatus().integrations[0]!.webhook!;
    expect(refusingNow(webhook)).toBe(false);
    expect(refusingNow({ ...webhook, lastRefusedAt: '2026-10-16T09:58:00Z', lastRefusal: 'BadSignature' })).toBe(true);
    expect(refusingNow({ ...webhook, lastRefusedAt: '2026-10-16T09:50:00Z', lastRefusal: 'Stale' })).toBe(false);
    expect(refusingNow({ ...webhook, lastReceivedAt: null, lastRefusedAt: '2026-10-16T09:50:00Z', lastRefusal: 'Unsigned' })).toBe(true);
  });
});
