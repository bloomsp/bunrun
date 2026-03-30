import { overlap, minutesRange } from './breaks';
import { countWorkingShiftsByAreaInRange, firstActiveShiftInRange } from './shifts';

export type PlannerShift = {
  id: number;
  member_id: number;
  home_area_key: string;
  status_key: string;
  start_time: string;
  end_time: string | null;
};

export type PlannerBreak = {
  id: number;
  shift_id: number;
  start_time: string;
  duration_minutes: number;
  cover_member_id: number | null;
  off_member_id: number;
  off_area_key: string;
};

export type PlannerMember = {
  id: number;
  all_areas: number;
};

export type PlannerContext = {
  shifts: PlannerShift[];
  shiftsByMember: Map<number, PlannerShift[]>;
  memberById: Map<number, PlannerMember>;
  permsByMember: Map<number, Set<string>>;
  minByArea: Map<string, number>;
  preferredRankByShiftId: Map<number, Map<number, number>>;
};

type CoverOption = {
  memberId: number | null;
  score: number;
};

export function buildPlannerContext(input: {
  shifts: PlannerShift[];
  members: PlannerMember[];
  perms: Array<{ member_id: number; area_key: string }>;
  minByArea: Map<string, number>;
  preferredRankByShiftId?: Map<number, Map<number, number>>;
}): PlannerContext {
  const shiftsByMember = new Map<number, PlannerShift[]>();
  for (const shift of input.shifts) {
    const rows = shiftsByMember.get(shift.member_id) ?? [];
    rows.push(shift);
    shiftsByMember.set(shift.member_id, rows);
  }

  const memberById = new Map(input.members.map((member) => [member.id, member]));
  const permsByMember = new Map<number, Set<string>>();
  for (const perm of input.perms) {
    const rows = permsByMember.get(perm.member_id) ?? new Set<string>();
    rows.add(perm.area_key);
    permsByMember.set(perm.member_id, rows);
  }

  return {
    shifts: input.shifts,
    shiftsByMember,
    memberById,
    permsByMember,
    minByArea: input.minByArea,
    preferredRankByShiftId: input.preferredRankByShiftId ?? new Map()
  };
}

export function breakTargetRange(row: Pick<PlannerBreak, 'start_time' | 'duration_minutes'>) {
  return minutesRange(row.start_time, Number(row.duration_minutes));
}

export function canMemberWorkArea(context: PlannerContext, memberId: number, areaKey: string) {
  const member = context.memberById.get(memberId);
  if (!member) return false;
  if (Number(member.all_areas) === 1) return true;
  return Boolean(context.permsByMember.get(memberId)?.has(areaKey));
}

export function activeWorkingShiftForMember(
  context: PlannerContext,
  memberId: number,
  target: { start: number; end: number }
) {
  return firstActiveShiftInRange(context.shiftsByMember.get(memberId) ?? [], target, { workingOnly: true }) as PlannerShift | null;
}

export function hasCoverConflict(
  breaks: PlannerBreak[],
  memberId: number,
  target: { start: number; end: number },
  excludeBreakId?: number
) {
  for (const row of breaks) {
    if (excludeBreakId != null && row.id === excludeBreakId) continue;
    const range = breakTargetRange(row);
    if (!range) continue;
    if (row.cover_member_id === memberId && overlap(target.start, target.end, range.start, range.end)) return true;
    if (row.off_member_id === memberId && overlap(target.start, target.end, range.start, range.end)) return true;
  }
  return false;
}

export function violatesAreaMinimums(
  context: PlannerContext,
  targetBreak: Pick<PlannerBreak, 'off_area_key'>,
  coverShift: Pick<PlannerShift, 'home_area_key'>,
  target: { start: number; end: number }
) {
  const counts = countWorkingShiftsByAreaInRange(context.shifts, target);
  counts.set(targetBreak.off_area_key, (counts.get(targetBreak.off_area_key) ?? 0) - 1);

  if (coverShift.home_area_key !== targetBreak.off_area_key) {
    counts.set(coverShift.home_area_key, (counts.get(coverShift.home_area_key) ?? 0) - 1);
    counts.set(targetBreak.off_area_key, (counts.get(targetBreak.off_area_key) ?? 0) + 1);
  }

  for (const [areaKey, activeCount] of counts.entries()) {
    if (activeCount <= 0) continue;
    const minStaff = context.minByArea.get(areaKey) ?? 0;
    if ((counts.get(areaKey) ?? 0) < minStaff) return true;
  }
  return false;
}

function coverOptionScore(
  context: PlannerContext,
  targetBreak: PlannerBreak,
  coverShift: PlannerShift
) {
  const preferredRanks = context.preferredRankByShiftId.get(targetBreak.shift_id) ?? new Map<number, number>();
  const preferredRank = preferredRanks.get(coverShift.member_id);
  let score = 0;

  if (preferredRank == null) {
    score += 40;
  } else {
    score += preferredRank * 4;
  }

  if (coverShift.home_area_key !== targetBreak.off_area_key) score += 12;

  return score + coverShift.member_id / 10000;
}

export function listEligibleCoverOptions(
  context: PlannerContext,
  breaks: PlannerBreak[],
  targetBreak: PlannerBreak
): CoverOption[] {
  const target = breakTargetRange(targetBreak);
  if (!target) return [{ memberId: null, score: 1000 }];

  const options: CoverOption[] = [];

  for (const shift of context.shifts) {
    if (shift.status_key !== 'working') continue;
    if (shift.member_id === targetBreak.off_member_id) continue;
    if (activeWorkingShiftForMember(context, shift.member_id, target)?.id !== shift.id) continue;
    if (shift.home_area_key !== targetBreak.off_area_key && !canMemberWorkArea(context, shift.member_id, targetBreak.off_area_key)) continue;
    if (hasCoverConflict(breaks, shift.member_id, target, targetBreak.id)) continue;
    if (violatesAreaMinimums(context, targetBreak, shift, target)) continue;

    options.push({
      memberId: shift.member_id,
      score: coverOptionScore(context, targetBreak, shift)
    });
  }

  options.sort((a, b) => a.score - b.score);
  options.push({ memberId: null, score: 1000 });
  return options;
}

export function isCoverAssignmentValid(
  context: PlannerContext,
  breaks: PlannerBreak[],
  targetBreak: PlannerBreak,
  coverMemberId: number | null
) {
  if (coverMemberId == null) return false;
  const target = breakTargetRange(targetBreak);
  if (!target) return false;
  const coverShift = activeWorkingShiftForMember(context, coverMemberId, target);
  if (!coverShift) return false;
  if (coverShift.home_area_key !== targetBreak.off_area_key && !canMemberWorkArea(context, coverMemberId, targetBreak.off_area_key)) {
    return false;
  }
  if (hasCoverConflict(breaks, coverMemberId, target, targetBreak.id)) return false;
  if (violatesAreaMinimums(context, targetBreak, coverShift, target)) return false;
  return true;
}

export function assignBestCovers(
  context: PlannerContext,
  lockedBreaks: PlannerBreak[],
  pendingBreaks: PlannerBreak[]
): Map<number, number | null> {
  const assignments = new Map<number, number | null>();
  if (pendingBreaks.length === 0) return assignments;

  const pendingById = new Map(pendingBreaks.map((row) => [row.id, row]));
  let bestScore = Number.POSITIVE_INFINITY;
  let bestAssignments = new Map<number, number | null>();

  const search = (currentBreaks: PlannerBreak[], remainingIds: number[], runningScore: number) => {
    if (runningScore >= bestScore) return;
    if (remainingIds.length === 0) {
      bestScore = runningScore;
      bestAssignments = new Map(assignments);
      return;
    }

    let nextId = remainingIds[0]!;
    let nextOptions: CoverOption[] | null = null;

    for (const breakId of remainingIds) {
      const row = pendingById.get(breakId);
      if (!row) continue;
      const options = listEligibleCoverOptions(context, currentBreaks, row);
      if (!nextOptions || options.length < nextOptions.length) {
        nextId = breakId;
        nextOptions = options;
      }
    }

    const row = pendingById.get(nextId);
    if (!row || !nextOptions) return;

    const remainingAfter = remainingIds.filter((id) => id !== nextId);
    for (const option of nextOptions) {
      assignments.set(nextId, option.memberId);
      const nextBreaks = currentBreaks.map((item) =>
        item.id === nextId ? { ...item, cover_member_id: option.memberId } : item
      );
      search(nextBreaks, remainingAfter, runningScore + option.score);
    }
    assignments.delete(nextId);
  };

  search([...lockedBreaks, ...pendingBreaks], pendingBreaks.map((row) => row.id), 0);
  return bestAssignments;
}
