import test from 'node:test';
import assert from 'node:assert/strict';

import { assignBestCovers, buildPlannerContext, listEligibleCoverOptions, type PlannerBreak } from '../src/lib/break-planner.ts';

test('preferred coverer outranks other non-floater valid coverers', () => {
  const context = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 10,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 20,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 3,
        member_id: 30,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 10, all_areas: 1 },
      { id: 20, all_areas: 1 },
      { id: 30, all_areas: 1 }
    ],
    perms: [],
    minByArea: new Map([['registers', 1]]),
    preferredRankByShiftId: new Map([[1, new Map([[30, 0], [20, 1]])]])
  });

  const targetBreak: PlannerBreak = {
    id: 99,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 10,
    off_shift_id: 1,
    off_area_key: 'registers'
  };

  const options = listEligibleCoverOptions(context, [], targetBreak).filter((row) => row.memberId != null);
  assert.equal(options[0]?.memberId, 30);
  assert.equal(options[1]?.memberId, 20);
});

test('sick shifts are not eligible as preferred coverers', () => {
  const context = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 10,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 20,
        home_area_key: 'registers',
        status_key: 'sick',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 3,
        member_id: 30,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 10, all_areas: 1 },
      { id: 20, all_areas: 1 },
      { id: 30, all_areas: 1 }
    ],
    perms: [],
    minByArea: new Map([['registers', 1]]),
    preferredRankByShiftId: new Map([[1, new Map([[20, 0], [30, 1]])]])
  });

  const targetBreak: PlannerBreak = {
    id: 98,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 10,
    off_shift_id: 1,
    off_area_key: 'registers'
  };

  const options = listEligibleCoverOptions(context, [], targetBreak).filter((row) => row.memberId != null);
  assert.equal(options[0]?.memberId, 30);
  assert.ok(!options.some((row) => row.memberId === 20));
});

test('existing conflicting cover assignment blocks a preferred coverer', () => {
  const context = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 10,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 20,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 3,
        member_id: 30,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 10, all_areas: 1 },
      { id: 20, all_areas: 1 },
      { id: 30, all_areas: 1 }
    ],
    perms: [],
    minByArea: new Map([['registers', 1]]),
    preferredRankByShiftId: new Map([[1, new Map([[20, 0]])]])
  });

  const existingBreaks: PlannerBreak[] = [{
    id: 50,
    work_block_id: 2,
    shift_id: 3,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: 20,
    off_member_id: 30,
    off_shift_id: 3,
    off_area_key: 'registers'
  }];

  const pendingBreaks: PlannerBreak[] = [{
    id: 99,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 10,
    off_shift_id: 1,
    off_area_key: 'registers'
  }];

  const assignments = assignBestCovers(context, existingBreaks, pendingBreaks);
  assert.equal(assignments.get(99), null);
});
