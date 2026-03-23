import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { copyScheduleDay, isISODate } from '../../../lib/schedule';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const sourceDate = (form.get('sourceDate') || '').toString();
  const targetDate = (form.get('targetDate') || '').toString();
  const targetPath = isISODate(targetDate) ? `/admin/schedule/${targetDate}` : '/admin/schedule';

  if (!isISODate(sourceDate) || !isISODate(targetDate)) {
    return redirectWithMessage(targetPath, { error: 'Enter valid source and target dates.' });
  }

  try {
    const DB = await getDB();
    const result = await copyScheduleDay(DB, sourceDate, targetDate);
    return redirectWithMessage(targetPath, {
      notice: `Copied ${result.shiftCount} shift${result.shiftCount === 1 ? '' : 's'} and ${result.breakCount} break${result.breakCount === 1 ? '' : 's'} from ${sourceDate}.`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to copy day';
    return redirectWithMessage(targetPath, { error: message });
  }
};
