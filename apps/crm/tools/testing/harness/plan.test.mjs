import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINER_LABEL, assertOwnedContainerLabel, assertOwnedContainerNetwork } from './plan.mjs';

test('container guards refuse foreign, relabelled and publicly or differently bound SQL containers', () => {
  const state = { runId: '0123456789ab', sqlContainer: 'parasol-harness-0123456789ab-sql', ports: { sql: 15433 } };
  assert.doesNotThrow(() => assertOwnedContainerLabel(state, state.sqlContainer, state.runId));
  assert.throws(() => assertOwnedContainerLabel(state, state.sqlContainer, 'foreign-run'));
  assert.throws(() => assertOwnedContainerLabel(state, 'user-sql-container', state.runId));
  assert.throws(() => assertOwnedContainerLabel({ ...state, sqlContainer: 'user-sql-container' }, 'user-sql-container', state.runId));
  const info = { Config: { Labels: { [CONTAINER_LABEL]: state.runId } }, NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '127.0.0.1', HostPort: '15433' }] } } };
  assert.doesNotThrow(() => assertOwnedContainerNetwork(state, state.sqlContainer, info));
  assert.throws(() => assertOwnedContainerNetwork(state, state.sqlContainer, { ...info, Config: { Labels: { [CONTAINER_LABEL]: 'foreign-run' } } }));
  assert.throws(() => assertOwnedContainerNetwork(state, state.sqlContainer, { ...info, NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '0.0.0.0', HostPort: '15433' }] } } }));
  assert.throws(() => assertOwnedContainerNetwork(state, state.sqlContainer, { ...info, NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '127.0.0.1', HostPort: '15434' }] } } }));
  assert.throws(() => assertOwnedContainerNetwork(state, state.sqlContainer, { ...info, NetworkSettings: { Ports: { '1433/tcp': [
    { HostIp: '127.0.0.1', HostPort: '15433' }, { HostIp: '127.0.0.1', HostPort: '15434' }] } } }));
});
