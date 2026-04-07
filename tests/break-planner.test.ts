import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignBestCovers,
  buildPlannerContext,
  isCoverAssignmentValid,
  listEligibleCoverOptions,
  type PlannerBreak,
  type PlannerShift
} from '../src/lib/break-planner.ts';

function buildBaseContext(overrides?: {
  shifts?: PlannerShift[];
  members?: Array<{ id: number; all_areas: number }>;
  perms?: Array<{ member_id: number; area_key: string }>;
  minByArea?: Map<string, number>;
}) {
  return buildPlannerContext({
    shifts: overrides?.shifts ?? [
      {
        id: 1,
        member_id: 101,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 202,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'floater',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 3,
        member_id: 303,
        home_area_key: 'service-desk',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: overrides?.members ?? [
      { id: 101, all_areas: 0 },
      { id: 202, all_areas: 1 },
      { id: 303, all_areas: 0 }
    ],
    perms: overrides?.perms ?? [],
    minByArea: overrides?.minByArea ?? new Map([
      ['registers', 1],
      ['service-desk', 1]
    ])
  });
}

test('listEligibleCoverOptions prefers valid floater coverage', () => {
  const context = buildBaseContext();
  const targetBreak: PlannerBreak = {
    id: 10,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 101,
    off_shift_id: 1,
    off_area_key: 'registers'
  };

  const options = listEligibleCoverOptions(context, [], targetBreak);
  assert.equal(options[0]?.memberId, 202);
  assert.equal(isCoverAssignmentValid(context, [], targetBreak, 202), true);
});

test('cover assignment is rejected when it would violate area minimums', () => {
  const context = buildBaseContext({
    minByArea: new Map([
      ['registers', 3],
      ['service-desk', 1]
    ])
  });
  const targetBreak: PlannerBreak = {
    id: 10,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 101,
    off_shift_id: 1,
    off_area_key: 'registers'
  };

  assert.equal(isCoverAssignmentValid(context, [], targetBreak, null), false);
  assert.equal(isCoverAssignmentValid(context, [], targetBreak, 202), false);
});

test('area covered is allowed when minimum staffing remains satisfied without a named cover', () => {
  const context = buildBaseContext({
    minByArea: new Map([
      ['registers', 1],
      ['service-desk', 1]
    ])
  });
  const targetBreak: PlannerBreak = {
    id: 11,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 101,
    off_shift_id: 1,
    off_area_key: 'registers'
  };

  assert.equal(isCoverAssignmentValid(context, [], targetBreak, null), true);
  const options = listEligibleCoverOptions(context, [], targetBreak);
  assert.ok(options.some((row) => row.memberId === null));
});

test('cross-area coverage requires explicit permission when member is not all-areas', () => {
  const context = buildBaseContext({
    shifts: [
      {
        id: 1,
        member_id: 101,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 202,
        home_area_key: 'service-desk',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 101, all_areas: 0 },
      { id: 202, all_areas: 0 }
    ],
    perms: [],
    minByArea: new Map([
      ['registers', 0],
      ['service-desk', 0]
    ])
  });
  const targetBreak: PlannerBreak = {
    id: 12,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 101,
    off_shift_id: 1,
    off_area_key: 'registers'
  };

  assert.equal(isCoverAssignmentValid(context, [], targetBreak, 202), false);
  assert.ok(!listEligibleCoverOptions(context, [], targetBreak).some((row) => row.memberId === 202));
});

test('assignBestCovers does not reuse the same member for overlapping pending breaks', () => {
  const context = buildBaseContext({
    shifts: [
      {
        id: 1,
        member_id: 101,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 202,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'floater',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 3,
        member_id: 303,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 101, all_areas: 1 },
      { id: 202, all_areas: 1 },
      { id: 303, all_areas: 1 }
    ],
    perms: [],
    minByArea: new Map([
      ['registers', 1],
      ['service-desk', 0]
    ])
  });

  const pendingBreaks: PlannerBreak[] = [
    {
      id: 21,
      work_block_id: 1,
      shift_id: 1,
      start_time: '09:00',
      duration_minutes: 15,
      cover_member_id: null,
      off_member_id: 101,
      off_shift_id: 1,
      off_area_key: 'registers'
    },
    {
      id: 22,
      work_block_id: 2,
      shift_id: 3,
      start_time: '09:00',
      duration_minutes: 15,
      cover_member_id: null,
      off_member_id: 303,
      off_shift_id: 3,
      off_area_key: 'registers'
    }
  ];

  const result = assignBestCovers(context, [], pendingBreaks);
  assert.notEqual(result.get(21), result.get(22));
});

test('cross-area cover is allowed when permission exists and minimum staffing still holds', () => {
  const context = buildBaseContext({
    shifts: [
      {
        id: 1,
        member_id: 101,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 202,
        home_area_key: 'service-desk',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 3,
        member_id: 303,
        home_area_key: 'service-desk',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 101, all_areas: 1 },
      { id: 202, all_areas: 0 },
      { id: 303, all_areas: 1 }
    ],
    perms: [{ member_id: 202, area_key: 'registers' }],
    minByArea: new Map([
      ['registers', 0],
      ['service-desk', 1]
    ])
  });

  const targetBreak: PlannerBreak = {
    id: 30,
    work_block_id: 1,
    shift_id: 1,
    start_time: '09:00',
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 101,
    off_shift_id: 1,
    off_area_key: 'registers'
  };

  assert.equal(isCoverAssignmentValid(context, [], targetBreak, 202), true);
  assert.ok(listEligibleCoverOptions(context, [], targetBreak).some((row) => row.memberId === 202));
});

test('non-overlapping pending breaks may reuse the same best coverer', () => {
  const context = buildBaseContext({
    shifts: [
      {
        id: 1,
        member_id: 101,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 2,
        member_id: 202,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'floater',
        start_time: '06:00',
        end_time: '12:00'
      },
      {
        id: 3,
        member_id: 303,
        home_area_key: 'registers',
        status_key: 'working',
        shift_role: 'normal',
        start_time: '06:00',
        end_time: '12:00'
      }
    ],
    members: [
      { id: 101, all_areas: 1 },
      { id: 202, all_areas: 1 },
      { id: 303, all_areas: 1 }
    ],
    perms: [],
    minByArea: new Map([
      ['registers', 1],
      ['service-desk', 0]
    ])
  });

  const pendingBreaks: PlannerBreak[] = [
    {
      id: 41,
      work_block_id: 1,
      shift_id: 1,
      start_time: '09:00',
      duration_minutes: 15,
      cover_member_id: null,
      off_member_id: 101,
      off_shift_id: 1,
      off_area_key: 'registers'
    },
    {
      id: 42,
      work_block_id: 2,
      shift_id: 3,
      start_time: '09:30',
      duration_minutes: 15,
      cover_member_id: null,
      off_member_id: 303,
      off_shift_id: 3,
      off_area_key: 'registers'
    }
  ];

  const result = assignBestCovers(context, [], pendingBreaks);
  assert.equal(result.get(41), 202);
  assert.equal(result.get(42), 202);
});
