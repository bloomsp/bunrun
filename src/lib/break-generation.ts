import { candidateOffsets, generateBreakTemplate, proposeBreakTimes } from './autogen';
import { assignBestCovers, isCoverAssignmentValid, type PlannerBreak, type PlannerContext } from './break-planner';
import { activeShiftAtTime, type WorkBlockShift } from './work-blocks';
import type { BreakPreference } from './member-config';

export type BreakGenerationBlock = {
  id: number;
  member_id: number;
  total_minutes: number;
  break_preference?: BreakPreference | string;
};

export type BreakGenerationResult = {
  pendingBreaks: PlannerBreak[];
  assignments: Map<number, number | null>;
  generatedCount: number;
  missingCount: number;
  requestedBreakCount: number;
};

export function generateBestBreakPlanForBlock(input: {
  block: BreakGenerationBlock;
  blockShifts: WorkBlockShift[];
  planner: PlannerContext;
  existingBreaks: PlannerBreak[];
  excludeWorkBlockId?: number;
}): BreakGenerationResult {
  const { block, blockShifts, planner, existingBreaks, excludeWorkBlockId = block.id } = input;
  const durations = generateBreakTemplate(Number(block.total_minutes ?? 0), (block.break_preference as BreakPreference | undefined) ?? '15+30');
  const blockAreaKeys = new Set(blockShifts.map((shift) => shift.home_area_key));
  const lockedBreaks = existingBreaks.filter((row) => row.work_block_id !== excludeWorkBlockId);

  let bestPendingBreaks: PlannerBreak[] = [];
  let bestAssignments = new Map<number, number | null>();
  let bestMissingCount = Number.POSITIVE_INFINITY;
  let bestGeneratedCount = -1;

  for (const offset of candidateOffsets(0)) {
    const areaBreaks = lockedBreaks
      .filter((row) => blockAreaKeys.has(row.off_area_key))
      .map((row) => ({ start_time: row.start_time, duration_minutes: row.duration_minutes }));

    const proposed = proposeBreakTimes(block as any, durations, { offsetMinutes: offset, existingBreaks: areaBreaks });
    const pendingBreaks: PlannerBreak[] = proposed.flatMap((row, index) => {
      const activeShift = activeShiftAtTime(blockShifts, block.member_id, row.start_time);
      if (!activeShift) return [];
      return [{
        id: -(block.id * 10 + index + 1),
        work_block_id: block.id,
        shift_id: activeShift.id,
        start_time: row.start_time,
        duration_minutes: row.duration_minutes,
        cover_member_id: null,
        off_member_id: block.member_id,
        off_shift_id: activeShift.id,
        off_area_key: activeShift.home_area_key
      }];
    });

    const assignments = assignBestCovers(planner, lockedBreaks, pendingBreaks);
    const candidateBreaks = pendingBreaks.map((row) => ({
      ...row,
      cover_member_id: assignments.get(row.id) ?? null
    }));
    const missingCount = (durations.length - pendingBreaks.length) + candidateBreaks.reduce(
      (count, row) => count + (isCoverAssignmentValid(planner, [...lockedBreaks, ...candidateBreaks], row, row.cover_member_id) ? 0 : 1),
      0
    );

    if (
      pendingBreaks.length > bestGeneratedCount ||
      (pendingBreaks.length === bestGeneratedCount && missingCount < bestMissingCount)
    ) {
      bestPendingBreaks = pendingBreaks;
      bestAssignments = assignments;
      bestMissingCount = missingCount;
      bestGeneratedCount = pendingBreaks.length;
      if (pendingBreaks.length === durations.length && missingCount === 0) break;
    }
  }

  return {
    pendingBreaks: bestPendingBreaks,
    assignments: bestAssignments,
    generatedCount: bestGeneratedCount,
    missingCount: bestMissingCount,
    requestedBreakCount: durations.length
  };
}
