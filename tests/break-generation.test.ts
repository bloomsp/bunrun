import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlannerContext } from '../src/lib/break-planner.ts';
import { generateBestBreakPlanForBlock } from '../src/lib/break-generation.ts';

test('generateBestBreakPlanForBlock maps breaks onto the active shift within a multi-shift work block', () => {
  const planner = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 100,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '09:00'
      },
      {
        id: 2,
        member_id: 100,
        home_area_key: 'service-desk',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '09:00',
        end_time: '13:00'
      },
      {
        id: 3,
        member_id: 200,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'floater',
        start_time: '06:00',
        end_time: '13:00'
      }
    ],
    members: [
      { id: 100, all_areas: 1 },
      { id: 200, all_areas: 1 }
    ],
    perms: [],
    minByArea: new Map([
      ['registers', 1],
      ['service-desk', 0]
    ])
  });

  const result = generateBestBreakPlanForBlock({
    block: {
      id: 10,
      member_id: 100,
      start_time: '06:00',
      end_time: '13:00',
      total_minutes: 420,
      break_preference: '15+30'
    },
    blockShifts: [
      {
        id: 1,
        schedule_id: 1,
        member_id: 100,
        status_key: 'working',
        home_area_key: 'registers',
        start_time: '06:00',
        end_time: '09:00',
        shift_minutes: 180,
        work_block_id: 10
      },
      {
        id: 2,
        schedule_id: 1,
        member_id: 100,
        status_key: 'working',
        home_area_key: 'service-desk',
        start_time: '09:00',
        end_time: '13:00',
        shift_minutes: 240,
        work_block_id: 10
      }
    ],
    planner,
    existingBreaks: []
  });

  assert.equal(result.pendingBreaks.length, 2);
  assert.equal(result.pendingBreaks[0]?.shift_id, 1);
  assert.equal(result.pendingBreaks[1]?.shift_id, 2);
});

test('generateBestBreakPlanForBlock prefers floater coverage when valid', () => {
  const planner = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 100,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 200,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'floater',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 100, all_areas: 1 },
      { id: 200, all_areas: 1 }
    ],
    perms: [],
    minByArea: new Map([['registers', 1]])
  });

  const result = generateBestBreakPlanForBlock({
    block: {
      id: 11,
      member_id: 100,
      start_time: '06:00',
      end_time: '12:00',
      total_minutes: 360,
      break_preference: '15+30'
    },
    blockShifts: [
      {
        id: 1,
        schedule_id: 1,
        member_id: 100,
        status_key: 'working',
        home_area_key: 'registers',
        start_time: '06:00',
        end_time: '12:00',
        shift_minutes: 360,
        work_block_id: 11
      }
    ],
    planner,
    existingBreaks: []
  });

  assert.ok(result.pendingBreaks.length > 0);
  assert.equal(result.assignments.get(result.pendingBreaks[0]!.id), 200);
});
