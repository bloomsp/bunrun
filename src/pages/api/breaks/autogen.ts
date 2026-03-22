import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { computeShiftMinutes, generateBreakTemplate, proposeBreakTimes, rangeFor, breaksOverlap } from '../../../lib/autogen';
import { overlap, minutesRange } from '../../../lib/breaks';

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const shiftId = Number(form.get('shiftId'));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid date' });
  if (!Number.isFinite(shiftId) || shiftId <= 0) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid shift' });

  const DB = await getDB();

  const shift = (await DB.prepare(
    `SELECT id, schedule_id, member_id, home_area_key, status_key, start_time, end_time, shift_minutes
     FROM shifts WHERE id=?`
  )
    .bind(shiftId)
    .first()) as any;

  if (!shift) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Shift not found' });
  if (shift.status_key !== 'working') {
    return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Cannot auto-generate breaks for non-working status' });
  }

  // Clear existing breaks for this shift
  await DB.prepare('DELETE FROM breaks WHERE shift_id=?').bind(shiftId).run();

  const shiftMinutes = computeShiftMinutes(shift);
  const durations = generateBreakTemplate(shiftMinutes);
  const proposed = proposeBreakTimes(shift, durations);

  // Preload context for cover picking
  const shifts = (await DB.prepare(
    `SELECT id, member_id, home_area_key, status_key
     FROM shifts WHERE schedule_id=?`
  )
    .bind(shift.schedule_id)
    .all()).results as any[];

  const members = (await DB.prepare('SELECT id, all_areas FROM members').all()).results as any[];
  const memberById = new Map(members.map((m) => [m.id, m]));

  const perms = (await DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all()).results as any[];
  const permsByMember = new Map<number, Set<string>>();
  for (const p of perms) {
    const set = permsByMember.get(p.member_id) ?? new Set<string>();
    set.add(p.area_key);
    permsByMember.set(p.member_id, set);
  }

  const areas = (await DB.prepare('SELECT key, label, min_staff FROM areas').all()).results as any[];

  const staffRows = (await DB.prepare(
    `SELECT a.key AS area_key, a.min_staff, COUNT(s.id) AS count
     FROM areas a
     LEFT JOIN shifts s
       ON s.home_area_key=a.key
      AND s.schedule_id=?
      AND s.status_key='working'
     GROUP BY a.key, a.min_staff`
  )
    .bind(shift.schedule_id)
    .all()).results as any[];

  const baseCounts = new Map<string, number>(staffRows.map((r) => [r.area_key, Number(r.count)]));
  const minByArea = new Map<string, number>(areas.map((a) => [a.key, Number(a.min_staff ?? 0)]));

  // Helper: can member work covered area
  const canWork = (memberId: number, areaKey: string) => {
    const m = memberById.get(memberId);
    if (!m) return false;
    if (m.all_areas === 1) return true;
    return Boolean(permsByMember.get(memberId)?.has(areaKey));
  };

  // Insert each break and greedily assign cover
  for (const b of proposed) {
    const offRange = rangeFor(b);
    if (!offRange) continue;

    // Candidate cover shifts: working, not the same member
    const candidates = shifts
      .filter((s: any) => s.status_key === 'working')
      .filter((s: any) => s.member_id !== shift.member_id)
      .filter((s: any) => canWork(s.member_id, shift.home_area_key));

    // existing breaks (already inserted for previous proposed breaks + any other shifts)
    const existingBreaks = (await DB.prepare(
      `SELECT b.id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
              s.member_id
       FROM breaks b
       JOIN shifts s ON s.id=b.shift_id
       WHERE s.schedule_id=?`
    )
      .bind(shift.schedule_id)
      .all()).results as any[];

    const eligible: any[] = [];
    for (const c of candidates) {
      // not on break themselves
      const own = existingBreaks.filter((eb) => eb.member_id === c.member_id);
      if (own.some((eb) => {
        const r = minutesRange(eb.start_time, eb.duration_minutes);
        return r && overlap(offRange.start, offRange.end, r.start, r.end);
      })) continue;

      // not covering someone else
      const covering = existingBreaks.filter((eb) => eb.cover_member_id === c.member_id);
      if (covering.some((eb) => {
        const r = minutesRange(eb.start_time, eb.duration_minutes);
        return r && overlap(offRange.start, offRange.end, r.start, r.end);
      })) continue;

      // area mins simulation
      const counts = new Map(baseCounts);
      // off-person leaves their area
      counts.set(shift.home_area_key, (counts.get(shift.home_area_key) ?? 0) - 1);

      // cover leaves their own area if different, and moves into off area
      if (c.home_area_key !== shift.home_area_key) {
        counts.set(c.home_area_key, (counts.get(c.home_area_key) ?? 0) - 1);
        counts.set(shift.home_area_key, (counts.get(shift.home_area_key) ?? 0) + 1);
      }

      let ok = true;
      for (const [areaKey, min] of minByArea.entries()) {
        if ((counts.get(areaKey) ?? 0) < min) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      eligible.push(c);
    }

    const picked = eligible[0] ?? null;

    const res = await DB.prepare('INSERT INTO breaks (shift_id, start_time, duration_minutes, cover_member_id) VALUES (?, ?, ?, ?)')
      .bind(shiftId, b.start_time, b.duration_minutes, picked ? picked.member_id : null)
      .run();

    // update baseCounts for future breaks? (we only need mins at each time slice; keep simple for v1)
    void res;
  }

  // If any break is missing cover, show a warning
  const after = (await DB.prepare('SELECT COUNT(1) as n FROM breaks WHERE shift_id=? AND cover_member_id IS NULL')
    .bind(shiftId)
    .first()) as any;

  if (Number(after?.n ?? 0) > 0) {
    return redirectWithMessage(`/admin/schedule/${date}#breaks`, { notice: 'Breaks generated (some missing cover)' });
  }

  return redirectWithMessage(`/admin/schedule/${date}#breaks`, { notice: 'Breaks generated' });
};
