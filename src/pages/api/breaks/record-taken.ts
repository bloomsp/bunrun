import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { getPositiveInt, getReturnTo, getString, isISODate } from '../../../lib/http';
import { redirectWithMessage } from '../../../lib/redirect';
import { toHHMM } from '../../../lib/time';

function nowInBrisbaneHHMM() {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const hh = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const mm = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = getString(form, 'date');
  const breakId = getPositiveInt(form, 'breakId');
  const returnTo = getReturnTo(form, `/admin/schedule/${date}?panel=breaks#breaks`);
  const clear = getString(form, 'clear') === '1';
  const takenNow = getString(form, 'takenNow') === '1';

  if (!isISODate(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (breakId == null) return redirectWithMessage(returnTo, { error: 'Invalid break' });

  const DB = await getDB();
  const target = await DB.prepare(
    `SELECT b.id
     FROM breaks b
     JOIN shifts s ON s.id = b.shift_id
     JOIN schedules sc ON sc.id = s.schedule_id
     WHERE b.id=? AND sc.date=?`
  ).bind(breakId, date).first();

  if (!target) return redirectWithMessage(returnTo, { error: 'Break not found' });

  if (clear) {
    await DB.prepare('UPDATE breaks SET actual_start_time=NULL, actual_start_source=NULL WHERE id=?').bind(breakId).run();
    return redirectWithMessage(returnTo, { notice: 'Actual break time cleared' });
  }

  const actualStartTime = takenNow
    ? nowInBrisbaneHHMM()
    : (() => {
        const hh = Number(form.get('hh'));
        const mm = Number(form.get('mm'));
        if (!Number.isFinite(hh) || hh < 0 || hh > 23) return null;
        if (!Number.isFinite(mm) || mm < 0 || mm > 59) return null;
        return toHHMM(hh * 60 + mm);
      })();

  if (actualStartTime == null) {
    const hh = Number(form.get('hh'));
    const mm = Number(form.get('mm'));
    if (!Number.isFinite(hh) || hh < 0 || hh > 23) return redirectWithMessage(returnTo, { error: 'Invalid hour' });
    if (!Number.isFinite(mm) || mm < 0 || mm > 59) return redirectWithMessage(returnTo, { error: 'Invalid minutes' });
    return redirectWithMessage(returnTo, { error: 'Invalid time' });
  }

  await DB.prepare('UPDATE breaks SET actual_start_time=?, actual_start_source=? WHERE id=?')
    .bind(actualStartTime, takenNow ? 'live' : 'manual', breakId)
    .run();

  return redirectWithMessage(returnTo, { notice: takenNow ? 'Actual break time set to now' : 'Actual break time recorded' });
};
