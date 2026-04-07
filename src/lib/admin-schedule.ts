import {
  activeWorkingShiftForMember,
  breakTargetRange,
  listEligibleCoverOptions,
  type PlannerBreak,
  type PlannerContext
} from './break-planner';
import { parseHHMM } from './time';

export type WeekSummaryRow = {
  date: string;
  shift_count: number;
  working_count: number;
};

export async function loadWeekSummaryByDate(DB: D1Database, weekStart: string, weekEnd: string) {
  const rows = (
    await DB.prepare(
      `SELECT sc.date,
              COUNT(sh.id) AS shift_count,
              SUM(CASE WHEN sh.status_key='working' THEN 1 ELSE 0 END) AS working_count
       FROM schedules sc
       LEFT JOIN shifts sh ON sh.schedule_id = sc.id
       WHERE sc.date >= ? AND sc.date <= ?
       GROUP BY sc.date`
    )
      .bind(weekStart, weekEnd)
      .all()
  ).results as WeekSummaryRow[];

  return new Map(
    rows.map((row) => [
      row.date,
      {
        shiftCount: Number(row.shift_count ?? 0),
        workingCount: Number(row.working_count ?? 0)
      }
    ])
  );
}

export function warningsForShift(
  start: string,
  end: string,
  minutes: number,
  operatingHours?: { open: number; close: number } | null
): string[] {
  const out: string[] = [];
  if (minutes > 9 * 60) out.push('Long shift (> 9h)');
  if (minutes > 10 * 60) out.push('Shift exceeds 10h max');
  if (operatingHours) {
    const s = parseHHMM(start);
    const e = parseHHMM(end);
    if (s != null && e != null && (s < operatingHours.open || e > operatingHours.close)) {
      out.push('Outside operating hours');
    }
  }
  return out;
}

export function coverCandidatesForBreak<TMember extends { id: number; name: string }, TShift extends { id: number; home_area_key: string }>(input: {
  planner: PlannerContext;
  plannerBreaks: PlannerBreak[];
  preferredRankByShiftId: Map<number, Map<number, number>>;
  members: TMember[];
  workingShifts: Array<{ member_id: number; home_area_key: string }>;
  offShift: TShift;
  targetBreakId: number;
}) {
  const plannerBreak = input.plannerBreaks.find((row) => row.id === input.targetBreakId);
  if (!plannerBreak) return [];

  const validIds = new Set(
    listEligibleCoverOptions(input.planner, input.plannerBreaks, plannerBreak)
      .map((row) => row.memberId)
      .filter((value): value is number => value != null)
  );

  return input.members
    .filter((member) => validIds.has(member.id))
    .sort((a, b) => {
      const ranks = input.preferredRankByShiftId.get(input.offShift.id) ?? new Map<number, number>();
      const aRank = ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bRank = ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      const targetRange = breakTargetRange(plannerBreak);
      const aFloater = targetRange
        ? activeWorkingShiftForMember(input.planner, a.id, targetRange)?.shift_role === 'floater'
        : false;
      const bFloater = targetRange
        ? activeWorkingShiftForMember(input.planner, b.id, targetRange)?.shift_role === 'floater'
        : false;
      if (aFloater !== bFloater) return aFloater ? -1 : 1;
      if (aRank !== bRank) return aRank - bRank;
      const aSameArea = input.workingShifts.some((shift) => shift.member_id === a.id && shift.home_area_key === input.offShift.home_area_key);
      const bSameArea = input.workingShifts.some((shift) => shift.member_id === b.id && shift.home_area_key === input.offShift.home_area_key);
      if (aSameArea !== bSameArea) return aSameArea ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
