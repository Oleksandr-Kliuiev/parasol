import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_COMMANDS, isActionCommand, parseActionInvocation, runActionCli } from '../packages/ops/actions.ts';
import { OPERATOR_COMMANDS, parseInvocation } from '../packages/ops/commands.ts';
import { generateToken } from '../packages/auth/token.ts';

// Stage 3 S3-C CLI boundary without a database: the action commands are a separate strict parser routed before the
// unchanged Stage 1/2 parser; DISABLED (the default) and refused compositions answer with a fixed code before any
// database is opened, and nothing from argv or the environment is echoed.
const id = '11111111-2222-8333-8444-555555555555';

test('S3-C action commands: exactly the approved set, routed separately; the Stage 1/2 command list is unchanged', () => {
  assert.deepEqual([...ACTION_COMMANDS].sort(), ['action-approve', 'action-cancel', 'action-execute', 'action-get', 'action-list', 'action-preview',
    'action-recover', 'action-reject', 'action-request', 'action-revoke', 'action-verify']);
  assert.ok(ACTION_COMMANDS.every(c => isActionCommand(c) && !OPERATOR_COMMANDS.includes(c)));
  assert.equal(isActionCommand('inbox'), false);
  assert.throws(() => parseInvocation(['action-get', '--client', 'c', '--request', id]), /INVALID_ARGUMENTS/, 'the Stage 1/2 parser does not know them');
});

test('strict flags: own flags once, bounded printable values, --client required; a candidate never travels in argv', () => {
  assert.deepEqual(parseActionInvocation(['action-verify', '--client', 'c', '--request', id, '--reconciliation-file', '/tmp/x.json']).flags,
    { client: 'c', request: id, 'reconciliation-file': '/tmp/x.json' });
  for (const argv of [
    ['action-verify', '--client', 'c', '--request', id, '--candidate', 'T-1'], ['action-verify', '--client', 'c'], ['action-get', '--request', id],
    ['action-get', '--client', 'c', '--request', id, '--request', id], ['action-get', '--client', 'c', '--request'], ['action-get', '--client', 'c', '--request', '--x'],
    ['action-get', '--client', 'c', '--request', `${id}\n`], ['action-get', '--client', 'c', '--request', 'x'.repeat(1025)], ['action-unknown', '--client', 'c'],
    ['action-execute', '--client', 'c', '--request', id], ['action-approve', '--client', 'c', '--request', id, '--hash', 'h'],
  ]) assert.throws(() => parseActionInvocation(argv), /INVALID_ARGUMENTS/, argv.join(' '));
});

test('DISABLED by default and refused compositions answer before any database or credential use; nothing is echoed', async () => {
  const argv = ['action-get', '--client', 'c', '--request', id];
  const secret = 'atl_should_never_print';
  for (const [env, code] of [[{}, 'ACTION_MODE_DISABLED'], [{ ATLAS_ACTIONS_MODE: 'LIVE' }, 'ACTION_MODE_REFUSED'],
    [{ ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_ACTIONS_CALLBACK: 'https://example.invalid/cb' }, 'ACTION_MODE_REFUSED']] as const) {
    const result = await runActionCli(argv, { ...env, ATLAS_OPERATOR_TOKEN: secret, ATLAS_RUNTIME_DATABASE_URL: 'postgresql://unused.invalid/none' });
    assert.deepEqual([result.code, result.output.safeErrorCode, result.output.synthetic], [2, code, true]);
    assert.doesNotMatch(JSON.stringify(result.output), /should_never_print|unused\.invalid|example\.invalid/);
  }
  const malformed = await runActionCli(argv, { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_OPERATOR_TOKEN: 'not-a-token' });
  assert.deepEqual([malformed.code, malformed.output.safeErrorCode], [2, 'ACTION_AUTHENTICATION_FAILED']);
  const usage = await runActionCli(['action-get', '--client', 'c', '--request', id, '--secret', secret], {});
  assert.deepEqual([usage.code, usage.output.error], [2, 'INVALID_ARGUMENTS']);
  assert.doesNotMatch(JSON.stringify(usage.output), /should_never_print/);
});

test('R3: every action CLI envelope carries synthetic:true — usage and configuration failures included — with fixed, input-free errors', async () => {
  const token = generateToken();
  const usage = await runActionCli(['action-get'], {});
  assert.deepEqual([usage.code, usage.output.error, usage.output.synthetic], [2, 'INVALID_ARGUMENTS', true]);
  const unconfigured = await runActionCli(['action-get', '--client', 'c', '--request', id], { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_OPERATOR_TOKEN: token });
  assert.deepEqual([unconfigured.code, unconfigured.output.error, unconfigured.output.synthetic], [2, 'ATLAS_RUNTIME_DATABASE_URL is required', true]);
  assert.ok(!JSON.stringify(unconfigured.output).includes(token), 'the bearer is never echoed');
  const envelopes = [usage, unconfigured,
    await runActionCli(['action-get', '--client', 'c', '--request', id], {}),
    await runActionCli(['action-verify', '--client', 'c', '--request', id, '--candidate', 'T-1'], { ATLAS_ACTIONS_MODE: 'MOCK' }),
    await runActionCli(['action-list', '--client', 'c'], { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_OPERATOR_TOKEN: 'bad' })];
  for (const e of envelopes) assert.equal(Object.hasOwn(e.output, 'synthetic') && e.output.synthetic === true, true, JSON.stringify(e.output));
});
