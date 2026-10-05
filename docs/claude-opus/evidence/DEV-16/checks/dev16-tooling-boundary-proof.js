// Native k6 1.3 boundary accounting proof. No HTTP, filesystem writes, service or database access.
// FORCE_INTERRUPT=1 intentionally overruns grace and must exit99; otherwise deadline drain must exit0.
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Gauge, Trend } from 'k6/metrics';
const force = __ENV.FORCE_INTERRUPT === '1';
const active = new Gauge('crm_active_iteration');
const starts = new Counter('crm_iterations_started');
const finishes = new Counter('crm_iterations_finished');
const attempted = new Counter('business_requests_started');
const recorded = new Counter('business_responses_recorded');
const latency = new Trend('business_latency_ms');
const boundary = {};
export const options = {
  scenarios: { boundary: { executor: 'constant-vus', vus: 1, duration: '1s', gracefulStop: force ? '0.1s' : '2s' } },
  thresholds: { 'crm_active_iteration{phase:measure,client_id:1}': ['value==0'], business_responses_recorded: ['count>0'], checks: ['rate==1'] },
};
export default function () {
  const tags = { phase: 'measure', client_id: String(exec.vu.idInTest) };
  const deadline = exec.scenario.startTime + 1000;
  const beforeRequest = () => { if (Date.now() >= deadline) throw boundary; };
  starts.add(1); active.add(1, tags);
  try {
    beforeRequest(); attempted.add(1); recorded.add(1); latency.add(1);
    check(true, { 'initial response recorded': Boolean });
    sleep(0.8);
    beforeRequest(); attempted.add(1);
    const started = Date.now();
    sleep(force ? 2 : 0.5); // Models a currently awaited native operation across the phase boundary.
    recorded.add(1); latency.add(Date.now() - started);
    beforeRequest();
    check(false, { 'no request may start after the deadline': Boolean });
  } catch (error) { if (error !== boundary) throw error; }
  finally { active.add(0, tags); finishes.add(1); }
}
export function handleSummary(data) {
  return { stdout: JSON.stringify({ kind: 'native-k6-boundary-proof', forceInterruption: force,
    operations: { attempted: data.metrics.business_requests_started.values.count, recorded: data.metrics.business_responses_recorded.values.count },
    interruptedIterations: data.metrics.crm_iterations_started.values.count - (data.metrics.crm_iterations_finished?.values.count ?? 0),
    active: data.metrics['crm_active_iteration{phase:measure,client_id:1}'], checks: data.metrics.checks,
    thresholdsPassed: Object.values(data.metrics).every((metric) => !metric.thresholds || Object.values(metric.thresholds).every((threshold) => threshold.ok)) }, null, 2) + '\n' };
}
