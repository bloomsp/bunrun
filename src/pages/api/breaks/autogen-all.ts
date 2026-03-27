import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { computeShiftMinutes, generateBreakTemplate, proposeBreakTimes, rangeFor } from '../../../lib/autogen';
import { overlap, minutesRange } from '../../../lib/breaks';
import { countWorkingShiftsByAreaInRange, firstActiveShiftInRange } from '../../../lib/shifts';

type ShiftRow = {
  id: number;
  schedule_id: number;
  member_id: number;
  home_area_key: string;
  status_key: string;
  start_time: string;
  end_time: string | null;
  shift_minutes: number;
};

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const mode = (form.get('mode') || 'missing').toString(); // missing|overwrite
  const returnTo = (form.get('returnTo') || `/admin/schedule/${date}?panel=breaks#breaks`).toString();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(returnTo, { error: 'Invalid date' });
  if (mode !== 'missing' && mode !== 'overwrite') return redirectWithMessage(returnTo, { error: 'Invalid mode' });

  const DB = await getDB();

  const sched = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as any;
  if (!sched) return redirectWithMessage(returnTo, { error: 'Schedule not found' });

  const scheduleId = sched.id as number;

  const shifts = (await DB.prepare(
    `SELECT id, schedule_id, member_id, home_area_key, status_key, start_time, end_time, shift_minutes
     FROM shifts
     WHERE schedule_id=? AND status_key <> 'sick'`
  )
    .bind(scheduleId)
    .all()).results as ShiftRow[];

  if (mode === 'overwrite') {
    await DB.prepare(
      `DELETE FROM breaks WHERE shift_id IN (SELECT id FROM shifts WHERE schedule_id=? AND status_key <> 'sick')`
    )
      .bind(scheduleId)
      .run();
  }

  // Context for cover picking
  const allShifts = (await DB.prepare(
    `SELECT id, member_id, home_area_key, status_key, start_time, end_time
     FROM shifts WHERE schedule_id=?`
  )
    .bind(scheduleId)
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

  const areas = (await DB.prepare('SELECT key, min_staff FROM areas').all()).results as any[];
  const minByArea = new Map<string, number>(areas.map((a) => [a.key, Number(a.min_staff ?? 0)]));

  const canWork = (memberId: number, areaKey: string) => {
    const m = memberById.get(memberId);
    if (!m) return false;
    if (m.all_areas === 1) return true;
    return Boolean(permsByMember.get(memberId)?.has(areaKey));
  };

  const existingBreaks = async () => {
    return (await DB.prepare(
      `SELECT b.id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
              s.member_id
       FROM breaks b
       JOIN shifts s ON s.id=b.shift_id
       WHERE s.schedule_id=?`
    )
      .bind(scheduleId)
      .all()).results as any[];
  };

  let generated = 0;
  const workingShiftsByArea = new Map<string, ShiftRow[]>();
  for (const shift of shifts) {
    if (shift.status_key !== 'working') continue;
    const rows = workingShiftsByArea.get(shift.home_area_key) ?? [];
    rows.push(shift);
    workingShiftsByArea.set(shift.home_area_key, rows);
  }
  for (const rows of workingShiftsByArea.values()) {
    rows.sort((a, b) =>
      a.start_time.localeCompare(b.start_time) ||
      (a.end_time ?? '').localeCompare(b.end_time ?? '') ||
      a.member_id - b.member_id
    );
  }

  for (const shift of shifts) {
    // Generate for working/training/crc/stocking, but not sick
    if (shift.status_key === 'sick') continue;

    if (mode === 'missing') {
      const n = (await DB.prepare('SELECT COUNT(1) as n FROM breaks WHERE shift_id=?').bind(shift.id).first()) as any;
      if (Number(n?.n ?? 0) > 0) continue;
    }

    // Clear existing for this shift if overwrite
    if (mode === 'overwrite') {
      await DB.prepare('DELETE FROM breaks WHERE shift_id=?').bind(shift.id).run();
    }

    const shiftMinutes = computeShiftMinutes(shift);
    const durations = generateBreakTemplate(shiftMinutes);
    const areaPeers = workingShiftsByArea.get(shift.home_area_key) ?? [];
    const shiftIndexInArea = Math.max(0, areaPeers.findIndex((row) => row.id === shift.id));
    const staggerOffset = (shiftIndexInArea % 4) * 15;
    const proposed = proposeBreakTimes(shift, durations, { offsetMinutes: staggerOffset });

    for (const b of proposed) {
      const offRange = rangeFor({ shift_id: shift.id, ...b, cover_member_id: null });
      if (!offRange) continue;

      const eb = await existingBreaks();

      const candidates = allShifts
        .filter((s: any) => s.status_key === 'working')
        .filter((s: any) => s.member_id !== shift.member_id)
        .filter((s: any) => firstActiveShiftInRange(allShifts.filter((x: any) => x.member_id === s.member_id), offRange, { workingOnly: true })?.id === s.id)
        .filter((s: any) => s.home_area_key === shift.home_area_key || canWork(s.member_id, shift.home_area_key));

      let picked: any = null;

      for (const c of candidates) {
        // not on break themselves
        const own = eb.filter((x) => x.member_id === c.member_id);
        if (own.some((x) => {
          const r = minutesRange(x.start_time, x.duration_minutes);
          return r && overlap(offRange.start, offRange.end, r.start, r.end);
        })) continue;

        // not covering someone else
        const covering = eb.filter((x) => x.cover_member_id === c.member_id);
        if (covering.some((x) => {
          const r = minutesRange(x.start_time, x.duration_minutes);
          return r && overlap(offRange.start, offRange.end, r.start, r.end);
        })) continue;

        // area min check
        const counts = countWorkingShiftsByAreaInRange(allShifts, offRange);
        // A same-area cover keeps staffing unchanged. A cross-area cover only reduces the
        // cover member's original area because they move into the covered area.
        if (c.home_area_key !== shift.home_area_key) {
          counts.set(c.home_area_key, (counts.get(c.home_area_key) ?? 0) - 1);
        }

        let ok = true;
        for (const [areaKey, min] of minByArea.entries()) {
          if ((counts.get(areaKey) ?? 0) < min) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;

        picked = c;
        break;
      }

      await DB.prepare('INSERT INTO breaks (shift_id, start_time, duration_minutes, cover_member_id) VALUES (?, ?, ?, ?)')
        .bind(shift.id, b.start_time, b.duration_minutes, picked ? picked.member_id : null)
        .run();
    }

    generated++;
  }

  const missing = (await DB.prepare(
    `SELECT COUNT(1) as n
     FROM breaks b
     JOIN shifts s ON s.id=b.shift_id
     WHERE s.schedule_id=? AND s.status_key='working' AND b.cover_member_id IS NULL`
  )
    .bind(scheduleId)
    .first()) as any;

  const tail = Number(missing?.n ?? 0) > 0 ? ' (some missing cover)' : '';
  const label = mode === 'overwrite' ? 'Breaks generated (overwrite)' : 'Breaks generated (missing only)';

  return redirectWithMessage(returnTo, { notice: `${label}${tail}` });
};
