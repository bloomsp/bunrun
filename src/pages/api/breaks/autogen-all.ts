import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { candidateOffsets, generateBreakTemplate, proposeBreakTimes } from '../../../lib/autogen';
import { assignBestCovers, buildPlannerContext, isCoverAssignmentValid, type PlannerBreak } from '../../../lib/break-planner';
import { activeShiftAtTime } from '../../../lib/work-blocks';

type WorkBlockRow = {
  id: number;
  schedule_id: number;
  member_id: number;
  start_time: string;
  end_time: string;
  total_minutes: number;
  break_preference?: string;
};

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const mode = (form.get('mode') || 'missing').toString();
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (mode !== 'missing' && mode !== 'overwrite') return redirectWithMessage(returnTo, { error: 'Invalid mode' });

  const DB = await getDB();
  const sched = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as any;
  if (!sched) return redirectWithMessage(returnTo, { error: 'Schedule not found' });
  const scheduleId = sched.id as number;

  const blocks = (await DB.prepare(
    `SELECT wb.id, wb.schedule_id, wb.member_id, wb.start_time, wb.end_time, wb.total_minutes, m.break_preference
     FROM work_blocks wb
     JOIN members m ON m.id = wb.member_id
     WHERE wb.schedule_id=?
     ORDER BY wb.start_time ASC, wb.id ASC`
  ).bind(scheduleId).all()).results as WorkBlockRow[];

  const shifts = (await DB.prepare(
    `SELECT id, work_block_id, member_id, home_area_key, status_key, shift_role, start_time, end_time, shift_minutes
     FROM shifts
     WHERE schedule_id=?`
  ).bind(scheduleId).all()).results as any[];

  const members = (await DB.prepare('SELECT id, all_areas FROM members').all()).results as any[];
  const perms = (await DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all()).results as any[];
  const areas = (await DB.prepare('SELECT key, min_staff FROM areas').all()).results as any[];
  const minByArea = new Map<string, number>(areas.map((a) => [a.key, Number(a.min_staff ?? 0)]));
  const preferredCovererRows = (
    await DB.prepare('SELECT shift_id, member_id, priority FROM shift_cover_priorities ORDER BY shift_id ASC, priority ASC').all()
  ).results as Array<{ shift_id: number; member_id: number; priority: number }>;
  const preferredRankByShiftId = new Map<number, Map<number, number>>();
  for (const row of preferredCovererRows) {
    const ranks = preferredRankByShiftId.get(row.shift_id) ?? new Map<number, number>();
    ranks.set(row.member_id, ranks.size);
    preferredRankByShiftId.set(row.shift_id, ranks);
  }

  const planner = buildPlannerContext({
    shifts,
    members,
    perms,
    minByArea,
    preferredRankByShiftId
  });

  let plannedBreaks: PlannerBreak[] = mode === 'overwrite'
    ? []
    : ((await DB.prepare(
      `SELECT b.id, b.work_block_id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
              s.member_id AS off_member_id, s.home_area_key AS off_area_key
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?`
    ).bind(scheduleId).all()).results as PlannerBreak[]);

  const statements = mode === 'overwrite'
    ? [DB.prepare('DELETE FROM breaks WHERE work_block_id IN (SELECT id FROM work_blocks WHERE schedule_id=?)').bind(scheduleId)]
    : [];

  let generated = 0;
  for (const block of blocks) {
    if (mode === 'missing' && plannedBreaks.some((row) => row.work_block_id === block.id)) continue;

    const blockShifts = shifts
      .filter((shift: any) => shift.work_block_id === block.id && shift.status_key === 'working')
      .sort((a: any, b: any) => a.start_time.localeCompare(b.start_time) || a.id - b.id);
    if (blockShifts.length === 0) continue;

    const durations = generateBreakTemplate(Number(block.total_minutes ?? 0), (block.break_preference as any) ?? '15+30');
    let bestPendingBreaks: PlannerBreak[] = [];
    let bestAssignments = new Map<number, number | null>();
    let bestMissingCount = Number.POSITIVE_INFINITY;

    for (const offset of candidateOffsets(0)) {
      const proposed = proposeBreakTimes(block as any, durations, { offsetMinutes: offset, existingBreaks: [] });
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

      const assignments = assignBestCovers(
        planner,
        plannedBreaks.filter((row) => row.work_block_id !== block.id),
        pendingBreaks
      );
      const candidateBreaks = pendingBreaks.map((row) => ({
        ...row,
        cover_member_id: assignments.get(row.id) ?? null
      }));
      const missingCount = candidateBreaks.reduce(
        (count, row) => count + (isCoverAssignmentValid(planner, [...plannedBreaks.filter((item) => item.work_block_id !== block.id), ...candidateBreaks], row, row.cover_member_id) ? 0 : 1),
        0
      );
      if (missingCount < bestMissingCount) {
        bestPendingBreaks = pendingBreaks;
        bestAssignments = assignments;
        bestMissingCount = missingCount;
        if (missingCount === 0) break;
      }
    }

    for (const row of bestPendingBreaks) {
      const coverMemberId = bestAssignments.get(row.id) ?? null;
      statements.push(
        DB.prepare('INSERT INTO breaks (work_block_id, shift_id, start_time, duration_minutes, cover_member_id) VALUES (?, ?, ?, ?, ?)')
          .bind(block.id, row.shift_id, row.start_time, row.duration_minutes, coverMemberId)
      );
      plannedBreaks.push({ ...row, cover_member_id: coverMemberId });
    }

    generated++;
  }

  if (statements.length > 0) {
    await DB.batch(statements);
  }

  const missingCount = plannedBreaks.filter((row) => !isCoverAssignmentValid(planner, plannedBreaks, row, row.cover_member_id)).length;
  const tail = missingCount > 0 ? ' (some missing cover)' : '';
  const label = mode === 'overwrite' ? 'Breaks generated (overwrite)' : 'Breaks generated (missing only)';
  return redirectWithMessage(returnTo, { notice: `${label}${tail}` });
};
