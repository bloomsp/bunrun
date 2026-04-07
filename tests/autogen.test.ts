import test from 'node:test';
import assert from 'node:assert/strict';

import { generateBreakTemplate, proposeBreakTimes } from '../src/lib/autogen.ts';

test('generateBreakTemplate follows entitlement thresholds', () => {
  assert.deepEqual(generateBreakTemplate(3 * 60 + 59), []);
  assert.deepEqual(generateBreakTemplate(4 * 60), [15]);
  assert.deepEqual(generateBreakTemplate(6 * 60), [15, 30]);
  assert.deepEqual(generateBreakTemplate(8 * 60), [15, 30, 15]);
  assert.deepEqual(generateBreakTemplate(10 * 60), [15, 30, 15, 30]);
});

test('generateBreakTemplate respects member ordering preference', () => {
  assert.deepEqual(generateBreakTemplate(6 * 60, '30+15'), [30, 15]);
  assert.deepEqual(generateBreakTemplate(10 * 60, '30+30'), [30, 15, 30, 15]);
});

test('proposeBreakTimes staggers around existing breaks and stays within shift bounds', () => {
  const result = proposeBreakTimes(
    {
      id: 1,
      member_id: 1,
      home_area_key: 'service-desk',
      status_key: 'working',
      start_time: '06:00',
      end_time: '14:00',
      shift_minutes: 480
    },
    [15, 30],
    {
      existingBreaks: [{ start_time: '08:30', duration_minutes: 15 }]
    }
  );

  assert.equal(result.length, 2);
  assert.equal(result[0]?.start_time, '08:15');
  assert.equal(result[1]?.start_time, '10:45');
  assert.ok(result.every((row) => row.start_time >= '08:00'));
});
