import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { isCoverAssignmentValid, type PlannerBreak } from '../../../lib/break-planner';
import { getReturnTo, getString, isISODate } from '../../../lib/http';
import { loadPlannerScheduleData } from '../../../lib/planner-data';
import { generateBestBreakPlanForBlock } from '../../../lib/break-generation';
import { ensureScheduleId } from '../../../lib/schedule';

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
  const date = getString(form, 'date');
  const mode = getString(form, 'mode', 'missing');
  const returnTo = getReturnTo(form, `/admin/schedule/${date}?panel=breaks#breaks`);

  if (!isISODate(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (mode !== 'missing' && mode !== 'overwrite') return redirectWithMessage(returnTo, { error: 'Invalid mode' });

  const DB = await getDB();
  const scheduleId = await ensureScheduleId(DB, date);

  const blocks = (await DB.prepare(
    `SELECT wb.id, wb.schedule_id, wb.member_id, wb.start_time, wb.end_time, wb.total_minutes, m.break_preference
     FROM work_blocks wb
     JOIN members m ON m.id = wb.member_id
     WHERE wb.schedule_id=?
     ORDER BY wb.start_time ASC, wb.id ASC`
  ).bind(scheduleId).all()).results as WorkBlockRow[];

  const { planner, shifts, breaks: existingBreaks } = await loadPlannerScheduleData(DB, scheduleId);

  let plannedBreaks: PlannerBreak[] = mode === 'overwrite'
    ? []
    : existingBreaks;

  const statements = mode === 'overwrite'
    ? [DB.prepare('DELETE FROM breaks WHERE work_block_id IN (SELECT id FROM work_blocks WHERE schedule_id=?)').bind(scheduleId)]
    : [];

  let generated = 0;
  for (const block of blocks) {
    if (mode === 'missing' && plannedBreaks.some((row) => row.work_block_id === block.id)) continue;

    const blockShifts = shifts
      .filter((shift) => shift.work_block_id === block.id && shift.status_key === 'working')
      .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id - b.id);
    if (blockShifts.length === 0) continue;

    const { pendingBreaks: bestPendingBreaks, assignments: bestAssignments } = generateBestBreakPlanForBlock({
      block,
      blockShifts,
      planner,
      existingBreaks: plannedBreaks,
      excludeWorkBlockId: block.id
    });

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
