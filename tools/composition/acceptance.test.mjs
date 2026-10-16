import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedReport } from './run.mjs';

function evidence() {
  return {
    diagnostic: false, cleanup: true, build: { builtInThisRun: true },
    browser: { expected: 7, unexpected: 0, skipped: 0, flaky: 0 },
    evidence: {
      taskCount: 1, receiptCount: 1, createAuditCount: 1, totalActivityLoggedCount: 2, providerWrites: 0,
      bodyIsNull: true, genericSubject: true, sourceTextAbsentFromTask: true, sourceTextAbsentFromAudit: true,
      privileges: { crmWebRestricted: true, crmWorkerRestricted: true, atlasRuntimeRestricted: true },
      actualScale: { clients: 40, devices: 400, employees: 3 },
    },
  };
}

test('composition acceptance needs all seven scenarios, a source build and owned cleanup', () => {
  const valid = evidence(); assert.equal(acceptedReport(valid), true);
  for (const expected of [0, 1, 6, 8]) assert.equal(acceptedReport({ ...valid, browser: { ...valid.browser, expected } }), false);
  for (const key of ['unexpected', 'skipped', 'flaky'])
    assert.equal(acceptedReport({ ...valid, browser: { ...valid.browser, [key]: 1 } }), false);
  assert.equal(acceptedReport({ ...valid, build: { builtInThisRun: false } }), false);
  assert.equal(acceptedReport({ ...valid, diagnostic: true }), false);
  assert.equal(acceptedReport({ ...valid, cleanup: false }), false);
});

test('partial, duplicate, privacy or runtime-role evidence cannot be accepted', () => {
  const valid = evidence();
  for (const key of ['taskCount', 'receiptCount', 'createAuditCount'])
    for (const count of [0, 2]) assert.equal(acceptedReport({ ...valid, evidence: { ...valid.evidence, [key]: count } }), false);
  assert.equal(acceptedReport({ ...valid, evidence: { ...valid.evidence, totalActivityLoggedCount: 3 } }), false);
  assert.equal(acceptedReport({ ...valid, evidence: { ...valid.evidence, providerWrites: 1 } }), false);
  for (const key of ['bodyIsNull', 'genericSubject', 'sourceTextAbsentFromTask', 'sourceTextAbsentFromAudit'])
    assert.equal(acceptedReport({ ...valid, evidence: { ...valid.evidence, [key]: false } }), false);
  for (const key of ['crmWebRestricted', 'crmWorkerRestricted', 'atlasRuntimeRestricted'])
    for (const value of [false, 'false', undefined]) assert.equal(acceptedReport({ ...valid, evidence: {
      ...valid.evidence, privileges: { ...valid.evidence.privileges, [key]: value },
    } }), false);
  assert.equal(acceptedReport({ ...valid, evidence: { ...valid.evidence, privileges: { one: true, two: true, three: true } } }), false);
  for (const key of ['clients', 'devices', 'employees']) assert.equal(acceptedReport({ ...valid, evidence: {
    ...valid.evidence, actualScale: { ...valid.evidence.actualScale, [key]: 0 },
  } }), false);
});
