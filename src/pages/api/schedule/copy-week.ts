import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { copyScheduleWeek, isISODate, startOfWeek } from '../../../lib/schedule';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const sourceWeekDate = (form.get('sourceWeekDate') || '').toString();
  const targetWeekDate = (form.get('targetWeekDate') || '').toString();
  const fallbackDate = isISODate(targetWeekDate) ? startOfWeek(targetWeekDate) : '';
  const targetPath = fallbackDate ? `/admin/schedule/${fallbackDate}` : '/admin/schedule';

  if (!isISODate(sourceWeekDate) || !isISODate(targetWeekDate)) {
    return redirectWithMessage(targetPath, { error: 'Enter valid source and target week dates.' });
  }

  try {
    const DB = await getDB();
    const result = await copyScheduleWeek(DB, sourceWeekDate, targetWeekDate);
    return redirectWithMessage(targetPath, {
      notice: `Copied ${result.shiftCount} shift${result.shiftCount === 1 ? '' : 's'} and ${result.breakCount} break${result.breakCount === 1 ? '' : 's'} into the week of ${result.targetWeekStart}.`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to copy week';
    return redirectWithMessage(targetPath, { error: message });
  }
};
