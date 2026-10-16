import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditText, sanitizeAuditMetadata, pickAuditMetadata, AUDIT_TEXT_LIMIT } from '../packages/audit/sanitize.ts';
import { MemoryAudit, MemorySecurityAudit } from '../packages/audit/memory.ts';
import { stage1Tools, TOOL_NAME_PATTERN } from '../packages/tools/registry.ts';
import { memorySinks, runTool } from './support/tool-fixtures.ts';
import { scope, actor } from '../fixtures/gasta.ts';

// Review R1: untrusted strings must reach an audit row as text PostgreSQL can store, without losing what was requested.
const hasLoneSurrogate = (s: string) => /\p{Cs}/u.test(s);

test('auditText escapes what PostgreSQL text/jsonb cannot store, and the representation stays unambiguous', () => {
  assert.equal(auditText('ghost\u0000client'), 'ghost\\u0000client');
  assert.equal(auditText('ghost\\u0000client'), 'ghost\\\\u0000client', 'a literal backslash stays distinguishable from a NUL');
  assert.equal(auditText('unknown\ud800tool'), 'unknown\\ud800tool');
  assert.equal(auditText('x\udc00y'), 'x\\udc00y');
  assert.equal(auditText('tab\tline\nend\u007f'), 'tab\\u0009line\\u000aend\\u007f');
  assert.equal(auditText('Kari 😀 Ærø demo-gasta'), 'Kari 😀 Ærø demo-gasta', 'valid text, including surrogate pairs, is unchanged');
  for (const input of ['\u0000', '\ud800\ud800', '\udfff\ud800', 'a\u0000\ud83d', '😀\udc00']) {
    const out = auditText(input);
    assert.ok(!out.includes('\u0000') && !hasLoneSurrogate(out), JSON.stringify(input));
  }
});

test('auditText bounds the length without splitting an escape sequence or a surrogate pair', () => {
  const nuls = auditText('\u0000'.repeat(128));
  assert.equal(nuls, '\\u0000'.repeat(33), '33 complete escapes = 198 characters');
  const pairs = auditText('😀'.repeat(150));
  assert.equal(pairs.length, AUDIT_TEXT_LIMIT); assert.ok(!hasLoneSurrogate(pairs));
  assert.equal(auditText('x'.repeat(500)).length, AUDIT_TEXT_LIMIT);
  assert.equal(auditText('a😀b', 2), 'a', 'a pair that does not fit is dropped whole');
});

test('metadata keeps the allowlist; values are escaped once on write and returned unchanged on read', () => {
  const written = sanitizeAuditMetadata({ tool: 'unknown\u0000tool', summary: 'payload', email: 'kari@example.invalid' });
  assert.deepEqual(written, { tool: 'unknown\\u0000tool' });
  assert.deepEqual(pickAuditMetadata({ ...written, summary: 'payload' }), written);
});

test('every registry tool name matches the tool-name syntax; malformed names do not', () => {
  for (const tool of stage1Tools) assert.match(tool.name, TOOL_NAME_PATTERN);
  for (const name of ['unknown\u0000tool', 'unknown\ud800tool', 'Atera.alert.list', 'atera', 'atera..list', 'atera.alert.list\n', '']) {
    assert.doesNotMatch(name, TOOL_NAME_PATTERN, JSON.stringify(name));
  }
});

test('gateway with in-memory sinks: a malformed client or tool is a recorded denial with an escaped value and no read', async () => {
  const audit = new MemoryAudit(); const securityAudit = new MemorySecurityAudit();
  let reads = 0;
  const read = async () => { reads++; throw new Error('must not read'); };
  await assert.rejects(runTool(actor, { ...scope, clientId: 'ghost\u0000client' }, 'atera.alert.list', read, memorySinks(audit, securityAudit)), /SCOPE_DENIED/);
  assert.deepEqual(securityAudit.list(scope.workspaceId).map(r => [r.requestedClientId, r.reasonCode, r.metadata.tool]),
    [['ghost\\u0000client', 'SCOPE_DENIED', 'atera.alert.list']]);
  for (const name of ['unknown\u0000tool', 'unknown\ud800tool']) {
    await assert.rejects(runTool(actor, scope, name, read, memorySinks(audit, securityAudit)), /TOOL_DENIED/);
  }
  assert.deepEqual(audit.list(scope).map(r => [r.eventType, r.metadata.tool, r.metadata.safeErrorCode]), [
    ['tool.denied', 'unknown\\u0000tool', 'INVALID_TOOL_NAME'], ['tool.denied', 'unknown\\ud800tool', 'INVALID_TOOL_NAME']]);
  assert.equal(reads, 0);
});
