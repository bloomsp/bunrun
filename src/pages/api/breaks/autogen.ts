import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { candidateOffsets, generateBreakTemplate, proposeBreakTimes } from '../../../lib/autogen';
import { assignBestCovers, buildPlannerContext, isCoverAssignmentValid, type PlannerBreak } from '../../../lib/break-planner';
import { activeShiftAtTime } from '../../../lib/work-blocks';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const workBlockId = Number(form.get('workBlockId'));
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (!Number.isFinite(workBlockId) || workBlockId <= 0) return redirectWithMessage(returnTo, { error: 'Invalid work block' });

  const DB = await getDB();

  const block = (await DB.prepare(
    `SELECT wb.id, wb.schedule_id, wb.member_id, wb.start_time, wb.end_time, wb.total_minutes, m.break_preference
     FROM work_blocks wb
     JOIN members m ON m.id = wb.member_id
     WHERE wb.id=?`
  ).bind(workBlockId).first()) as any;
  if (!block) return redirectWithMessage(returnTo, { error: 'Work block not found' });

  const shifts = (await DB.prepare(
    `SELECT id, work_block_id, member_id, home_area_key, status_key, shift_role, start_time, end_time, shift_minutes
     FROM shifts
     WHERE schedule_id=?`
  ).bind(block.schedule_id).all()).results as any[];

  const blockShifts = shifts
    .filter((shift: any) => shift.work_block_id === workBlockId && shift.status_key === 'working')
    .sort((a: any, b: any) => a.start_time.localeCompare(b.start_time) || a.id - b.id);
  if (blockShifts.length === 0) return redirectWithMessage(returnTo, { error: 'No working shifts found for this work block' });
  const blockAreaKeys = new Set(blockShifts.map((shift: any) => shift.home_area_key));

  const members = (await DB.prepare('SELECT id, all_areas FROM members').all()).results as any[];
  const perms = (await DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all()).results as any[];
  const areas = (await DB.prepare('SELECT key, min_staff FROM areas').all()).results as any[];
  const minByArea = new Map<string, number>(areas.map((a) => [a.key, Number(a.min_staff ?? 0)]));
  const preferredCovererRows = (
    await DB.prepare(
      'SELECT shift_id, member_id, priority FROM shift_cover_priorities WHERE shift_id IN (SELECT id FROM shifts WHERE work_block_id=?) ORDER BY shift_id ASC, priority ASC'
    ).bind(workBlockId).all()
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

  const existingBreaks = (await DB.prepare(
    `SELECT b.id, b.work_block_id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
            s.member_id AS off_member_id, s.home_area_key AS off_area_key
     FROM breaks b
     JOIN shifts s ON s.id = b.shift_id
     WHERE s.schedule_id=?`
  ).bind(block.schedule_id).all()).results as PlannerBreak[];

  const durations = generateBreakTemplate(Number(block.total_minutes ?? 0), block.break_preference);
  let bestPendingBreaks: PlannerBreak[] = [];
  let bestAssignments = new Map<number, number | null>();
  let bestMissingCount = Number.POSITIVE_INFINITY;
  let bestGeneratedCount = -1;

  for (const offset of candidateOffsets(0)) {
    const areaBreaks = existingBreaks
      .filter((row) => row.work_block_id !== workBlockId && blockAreaKeys.has(row.off_area_key))
      .map((row) => ({ start_time: row.start_time, duration_minutes: row.duration_minutes }));
    const proposed = proposeBreakTimes(block, durations, { offsetMinutes: offset, existingBreaks: areaBreaks });
    const pendingBreaks: PlannerBreak[] = proposed.flatMap((row, index) => {
      const activeShift = activeShiftAtTime(blockShifts, block.member_id, row.start_time);
      if (!activeShift) return [];
      return [{
        id: -1 - index,
        work_block_id: workBlockId,
        shift_id: activeShift.id,
        start_time: row.start_time,
        duration_minutes: row.duration_minutes,
        cover_member_id: null,
        off_member_id: block.member_id,
        off_shift_id: activeShift.id,
        off_area_key: activeShift.home_area_key
      }];
    });

    const assignments = assignBestCovers(planner, existingBreaks.filter((row) => row.work_block_id !== workBlockId), pendingBreaks);
    const candidateBreaks = pendingBreaks.map((row) => ({
      ...row,
      cover_member_id: assignments.get(row.id) ?? null
    }));
    const missingCount = (durations.length - pendingBreaks.length) + candidateBreaks.reduce(
      (count, row) => count + (isCoverAssignmentValid(planner, [...existingBreaks.filter((item) => item.work_block_id !== workBlockId), ...candidateBreaks], row, row.cover_member_id) ? 0 : 1),
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

  const statements = [DB.prepare('DELETE FROM breaks WHERE work_block_id=?').bind(workBlockId)];
  for (const row of bestPendingBreaks) {
    const coverMemberId = bestAssignments.get(row.id) ?? null;
    statements.push(
      DB.prepare('INSERT INTO breaks (work_block_id, shift_id, start_time, duration_minutes, cover_member_id) VALUES (?, ?, ?, ?, ?)')
        .bind(workBlockId, row.shift_id, row.start_time, row.duration_minutes, coverMemberId)
    );
  }

  await DB.batch(statements);

  const generatedBreaks = bestPendingBreaks.map((row) => ({
    ...row,
    cover_member_id: bestAssignments.get(row.id) ?? null
  }));
  const actualMissingCount = generatedBreaks.filter((row) => !isCoverAssignmentValid(planner, generatedBreaks, row, row.cover_member_id)).length;

  if (actualMissingCount > 0) {
    return redirectWithMessage(returnTo, { notice: 'Breaks generated (some missing cover)' });
  }

  return redirectWithMessage(returnTo, { notice: 'Breaks generated' });
};
