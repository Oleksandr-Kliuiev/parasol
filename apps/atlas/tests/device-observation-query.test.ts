import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { parseObservationQuery } from '../apps/api/src/http-boundary.ts';
import { activeQuery, decodeCursor, encodeCursor } from '../packages/observations/query.ts';

test('device selection keeps the exact canonical ID and existing status, severity and page size', () => {
  assert.deepEqual(parseObservationQuery({ deviceId: 'pc:one/with space', status: 'RESOLVED', severity: 'HIGH', limit: '25' }, 100), {
    statuses: ['RESOLVED'], severities: ['HIGH'], limit: 25, cursor: null, deviceId: 'pc:one/with space',
  });
  assert.deepEqual(parseObservationQuery({}, 100), activeQuery(100), 'the unfiltered query keeps its original shape');
});

test('device selection refuses repeated, empty, control-bearing, non-text and oversized IDs', () => {
  for (const deviceId of ['', '  ', ['one', 'two'], 42, null, 'one\n', 'one\u007f', 'one\u0085', 'pc-\ud800', 'pc-\udc00', 'x'.repeat(257)]) {
    assert.throws(() => parseObservationQuery({ deviceId }, 100), BadRequestException);
  }
  assert.equal(parseObservationQuery({ deviceId: 'x'.repeat(256) }, 100).deviceId?.length, 256);
});

test('a page cursor cannot move to another device or the complete customer queue', () => {
  const query = { ...activeQuery(25), deviceId: 'pc-one' };
  const row = { severityRank: 4, createdAt: new Date('2026-10-17T12:00:00.000Z'), id: 'observation-one' };
  const cursor = encodeCursor(row, query);
  assert.deepEqual(decodeCursor(cursor, query), row);
  assert.throws(() => decodeCursor(cursor, { ...query, deviceId: 'pc-two' }), /INVALID_CURSOR/);
  assert.throws(() => decodeCursor(cursor, activeQuery(25)), /INVALID_CURSOR/);
  assert.throws(() => decodeCursor(encodeCursor(row, activeQuery(25)), query), /INVALID_CURSOR/);
});
