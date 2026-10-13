import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actor, scope } from '../fixtures/gasta.ts';
import { runDemo } from '../fixtures/run-demo.ts';
import { AskBudget, AskDeadline } from '../packages/ask/budget.ts';
import { AskFailure } from '../packages/ask/contracts.ts';
import { fixtureAskPort } from '../packages/ask/fixture.ts';
import { AskRun, AskStopped } from '../packages/ask/service.ts';

// ASK-A rc3 R2b: the fixture port's demo dependency is awaited before every denial/completion append and before the source
// work of admission; terminal state or the original deadline reached during that await appends nothing and starts no source
// work. The deferred demo is an injected asynchronous dependency (as in the review probe), not normal HTTP scheduling: the
// production demo usually resolves before any request. Positive fixture audits and exactly-once owner settlement are kept.

const TOKEN = 'synthetic-demo-token-0123456789';
const tick = () => new Promise(resolve => setImmediate(resolve));
type Phase = 'denial' | 'publish' | 'admission';
async function scenario(phase: Phase, interrupt: 'terminal' | 'deadline' | 'none') {
  const real = await runDemo();
  let contextReads = 0; let denials = 0; let completions = 0; let reached = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const demo = {
    get context() { contextReads += 1; return real.context; },
    audit: { append: () => { completions += 1; } },
    securityAudit: { append: () => { denials += 1; } }
  };
  const port = fixtureAskPort({ demo: async () => { reached = true; await gate; return demo; }, demoToken: () => TOKEN, actor, scope });
  const budget = new AskBudget();
  const owner = budget.reserve()!;
  let now = 0;
  const run = new AskRun(owner, new AskDeadline(8000, () => now));
  assert.equal(owner.bind(scope.workspaceId, actor.id, true), 'BOUND');
  const credential = port.credential(`Bearer ${TOKEN}`)!;
  const identity = { workspaceId: scope.workspaceId, actorId: actor.id };
  let outcome = 'PENDING';
  const work = (phase === 'denial' ? port.admit(run, identity, credential, 'denied-client', null)
    : phase === 'admission' ? port.admit(run, identity, credential, scope.clientId, null)
      : port.publish(run, identity, credential, { scope, epoch: 'fixture', source: null as never }, { event: 'completed', status: 'ANSWER', itemCount: 1 }))
    .then(() => { outcome = 'SUCCESS'; }, (e: unknown) => { outcome = e instanceof AskStopped ? 'STOPPED' : e instanceof AskFailure ? e.code : 'OTHER'; });
  owner.hold(work); owner.finish();
  for (let i = 0; i < 20 && !reached; i += 1) await tick();
  assert.equal(reached, true, 'the demo await was reached');
  if (interrupt === 'terminal') run.end();
  if (interrupt === 'deadline') now = 8000;
  await tick();
  assert.equal(budget.active, 1, 'the pending demo await keeps the owner');
  release();
  await work; await tick();
  return { outcome, denials, completions, contextReads, admissions: budget.admissions(scope.workspaceId, actor.id), releases: budget.releases, active: budget.active };
}

for (const phase of ['denial', 'publish', 'admission'] as const) {
  for (const interrupt of ['terminal', 'deadline'] as const) {
    test(`R2b ${phase}: ${interrupt} during the demo await → no append, no source work; exactly one release`, async () => {
      const r = await scenario(phase, interrupt);
      assert.equal(r.outcome, interrupt === 'terminal' ? 'STOPPED' : 'ASK_DEADLINE');
      assert.equal(r.denials + r.completions, 0, 'no new memory audit after terminal/deadline');
      assert.equal(r.contextReads, 0, 'no source work');
      assert.equal(r.admissions, phase === 'admission' ? 1 : 0, 'only the admission charged, before its source await; nothing later');
      assert.deepEqual([r.releases, r.active], [1, 0]);
    });
  }
}

test('R2b positives: the same deferred demo, uninterrupted, still records one denial / one completion / one source read', async () => {
  assert.deepEqual(await scenario('denial', 'none'), { outcome: 'ASK_SCOPE_DENIED', denials: 1, completions: 0, contextReads: 0, admissions: 0, releases: 1, active: 0 });
  assert.deepEqual(await scenario('publish', 'none'), { outcome: 'SUCCESS', denials: 0, completions: 1, contextReads: 0, admissions: 0, releases: 1, active: 0 });
  assert.deepEqual(await scenario('admission', 'none'), { outcome: 'SUCCESS', denials: 0, completions: 0, contextReads: 1, admissions: 1, releases: 1, active: 0 });
});
