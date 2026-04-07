import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { isCoverAssignmentValid } from '../../../lib/break-planner';
import { getPositiveInt, getReturnTo, getString, isISODate } from '../../../lib/http';
import { loadPlannerScheduleData } from '../../../lib/planner-data';
import { generateBestBreakPlanForBlock } from '../../../lib/break-generation';
import { loadWorkBlockById, loadShiftsForWorkBlock } from '../../../lib/repositories';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = getString(form, 'date');
  const workBlockId = getPositiveInt(form, 'workBlockId');
  const returnTo = getReturnTo(form, `/admin/schedule/${date}?panel=breaks#breaks`);

  if (!isISODate(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (workBlockId == null) return redirectWithMessage(returnTo, { error: 'Invalid work block' });

  const DB = await getDB();

  const block = await loadWorkBlockById(DB, workBlockId);
  if (!block) return redirectWithMessage(returnTo, { error: 'Work block not found' });

  const { planner, breaks: existingBreaks } = await loadPlannerScheduleData(DB, block.schedule_id!, {
    preferredCoverersFor: { workBlockId }
  });

  const blockShifts = (await loadShiftsForWorkBlock(DB, workBlockId))
    .filter((shift) => shift.status_key === 'working')
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id - b.id);
  if (blockShifts.length === 0) return redirectWithMessage(returnTo, { error: 'No working shifts found for this work block' });

  const { pendingBreaks: bestPendingBreaks, assignments: bestAssignments } = generateBestBreakPlanForBlock({
    block,
    blockShifts,
    planner,
    existingBreaks,
    excludeWorkBlockId: workBlockId
  });

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
