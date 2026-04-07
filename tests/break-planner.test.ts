import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
