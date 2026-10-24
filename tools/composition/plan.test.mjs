import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixturePlan, visibleClients, ROLES, parseArgs, sourceKey, assertPrivateState, assertOwnedContainerLabel, assertOwnedContainerNetwork } from './plan.mjs';

test('scale and membership fixtures are exact, distinct and restricted', () => {
  const plan = fixturePlan();
  assert.equal(plan.clients.length, 40); assert.equal(new Set(plan.clients.flatMap(c => c.deviceIds)).size, 400);
  assert.equal(visibleClients(ROLES[0], plan.clients).length, 40);
  assert.deepEqual(visibleClients(ROLES[1], plan.clients), plan.clients.slice(0, 20).map(c => c.atlasClientId));
  assert.equal(visibleClients(ROLES[2], plan.clients).includes(plan.clients[0].atlasClientId), false);
  assert.equal(visibleClients(ROLES[2], plan.clients).includes(plan.clients[1].atlasClientId), false);
  assert.equal(visibleClients(ROLES[2], plan.clients).includes(plan.clients[20].atlasClientId), true);
  assert.equal(Object.values(plan.target.severityCounts).reduce((a, b) => a + b), plan.target.activeTotal);
  assert.notEqual(sourceKey(plan.clients[0].atlasClientId, 'observation-one'), sourceKey(plan.clients[1].atlasClientId, 'observation-one'));
  assert.notEqual(sourceKey(plan.clients[0].atlasClientId, 'observation-one'), sourceKey(plan.clients[0].atlasClientId, 'Observation-one'));
});
test('launcher refuses missing or unknown options rather than reusing user state', () => {
  assert.throws(() => parseArgs([])); assert.throws(() => parseArgs(['--directory', '/tmp/example', '--reuse']));
  assert.deepEqual(parseArgs(['--directory', '/tmp/example', '--skip-build']), { directory: '/tmp/example', skipBuild: true, skipBrowser: false });
});
test('control channel refuses unrecognized, remote and non-fixture databases', () => {
  const state = { format: 1, kind: 'parasol-local-composition', runId: '0123456789ab', sqlDatabase: 'crm_e2e_composition_0123456789ab',
    ports: { sql: 15433, pg: 5432 }, sqlContainer: 'parasol-composition-0123456789ab-sql', pgContainer: 'parasol-composition-0123456789ab-pg',
    atlasOwnerUrl: 'postgresql://test:test@127.0.0.1:5432/atlas_it_01234567', atlasRuntimeUrl: 'postgresql://test:test@127.0.0.1:5432/atlas_it_01234567' };
  state.sqlConnections = Object.fromEntries([['owner', 'sa'], ['web', 'composition_web'], ['worker', 'composition_worker']].map(([key, user]) =>
    [key, `Server=127.0.0.1,15433;Database=${state.sqlDatabase};User ID=${user};Password=${'a'.repeat(40)};Encrypt=True;TrustServerCertificate=True`]));
  assert.doesNotThrow(() => assertPrivateState(state));
  assert.throws(() => assertPrivateState({ ...state, sqlDatabase: 'Crm' }));
  assert.throws(() => assertPrivateState({ ...state, atlasOwnerUrl: 'postgresql://test:test@working-db.invalid:5432/atlas_it_01234567' }));
  assert.throws(() => assertPrivateState({ ...state, sqlConnections: { ...state.sqlConnections, owner: state.sqlConnections.owner.replace('127.0.0.1', 'working-db.invalid') } }));
  assert.throws(() => assertPrivateState({ ...state, sqlConnections: { ...state.sqlConnections, web: state.sqlConnections.web.replace(state.sqlDatabase, 'Crm') } }));
  assert.throws(() => assertPrivateState({ ...state, sqlContainer: 'user-sql-container' }));
  assert.doesNotThrow(() => assertOwnedContainerLabel(state, state.sqlContainer, state.runId));
  assert.throws(() => assertOwnedContainerLabel(state, state.sqlContainer, 'foreign-run'));
  assert.throws(() => assertOwnedContainerLabel(state, 'user-sql-container', state.runId));
  const info = { Config: { Labels: { 'parasol.composition.run': state.runId } }, NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '127.0.0.1', HostPort: '15433' }] } } };
  assert.doesNotThrow(() => assertOwnedContainerNetwork(state, state.sqlContainer, info));
  assert.throws(() => assertOwnedContainerNetwork(state, state.sqlContainer, { ...info, NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '0.0.0.0', HostPort: '15433' }] } } }));
  assert.throws(() => assertOwnedContainerNetwork(state, state.sqlContainer, { ...info, NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '127.0.0.1', HostPort: '15434' }] } } }));
  assert.throws(() => assertPrivateState({ ...state, atlasRuntimeUrl: state.atlasRuntimeUrl + '?host=working-db.invalid' }));
});
