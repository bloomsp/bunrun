import test from 'node:test';
import assert from 'node:assert/strict';

import { activeShiftAtTime, buildPendingWorkBlocks, shiftContainsTime } from '../src/lib/work-blocks.ts';

test('buildPendingWorkBlocks merges touching working shifts for the same member', () => {
  const blocks = buildPendingWorkBlocks([
    {
      id: 1,
      schedule_id: 1,
      member_id: 10,
      status_key: 'working',
      home_area_key: 'registers',
      start_time: '06:00',
      end_time: '09:00',
      shift_minutes: 180
    },
    {
      id: 2,
      schedule_id: 1,
      member_id: 10,
      status_key: 'working',
      home_area_key: 'tool-shop',
      start_time: '09:00',
      end_time: '12:00',
      shift_minutes: 180
    },
    {
      id: 3,
      schedule_id: 1,
      member_id: 10,
      status_key: 'working',
      home_area_key: 'tool-shop',
      start_time: '12:30',
      end_time: '14:00',
      shift_minutes: 90
    }
  ]);

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    member_id: 10,
    start_time: '06:00',
    end_time: '12:00',
    total_minutes: 360,
    shiftIds: [1, 2]
  });
  assert.deepEqual(blocks[1]?.shiftIds, [3]);
});

test('activeShiftAtTime returns the shift containing the requested minute', () => {
  const shifts = [
    {
      id: 1,
      schedule_id: 1,
      member_id: 5,
      status_key: 'working',
      home_area_key: 'registers',
      start_time: '06:00',
      end_time: '09:00',
      shift_minutes: 180
    },
    {
      id: 2,
      schedule_id: 1,
      member_id: 5,
      status_key: 'working',
      home_area_key: 'service-desk',
      start_time: '09:00',
      end_time: '12:00',
      shift_minutes: 180
    }
  ];

  assert.equal(activeShiftAtTime(shifts, 5, '08:45')?.id, 1);
  assert.equal(activeShiftAtTime(shifts, 5, '09:00')?.id, 2);
  assert.equal(activeShiftAtTime(shifts, 5, '12:00'), null);
  assert.equal(shiftContainsTime(shifts[0]!, '09:00'), false);
});
