import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { redirectWithMessage } from '../../../lib/redirect';
import { overlap, minutesRange } from '../../../lib/breaks';

type BreakRow = {
  id: number;
  shift_id: number;
  start_time: string;
  duration_minutes: number;
  cover_member_id: number | null;
  off_member_id: number;
  off_area_key: string;
  schedule_id: number;
};

type ShiftRow = {
  id: number;
  member_id: number;
  home_area_key: string;
  status_key: string;
};

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid date' });

  const DB = await getDB();
  const sched = (await DB.prepare('SELECT id FROM schedules WHERE date=?').bind(date).first()) as any;
  if (!sched) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Schedule not found' });
  const scheduleId = sched.id as number;

  const shifts = (await DB.prepare(
    'SELECT id, member_id, home_area_key, status_key FROM shifts WHERE schedule_id=?'
  )
    .bind(scheduleId)
    .all()).results as ShiftRow[];

  const memberShift = new Map<number, ShiftRow>();
  for (const s of shifts) memberShift.set(s.member_id, s);

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
  const minByArea = new Map<string, number>(areas.map((a) => [a.key, Number(a.min_staff ?? 0)]));

  const staffRows = (await DB.prepare(
    `SELECT a.key AS area_key, COUNT(s.id) AS count
     FROM areas a
     LEFT JOIN shifts s
       ON s.home_area_key=a.key
      AND s.schedule_id=?
      AND s.status_key='working'
     GROUP BY a.key`
  )
    .bind(scheduleId)
    .all()).results as any[];

  const baseCounts = new Map<string, number>(staffRows.map((r) => [r.area_key, Number(r.count)]));

  const breaks = (await DB.prepare(
    `SELECT b.id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
            s.member_id AS off_member_id, s.home_area_key AS off_area_key, s.schedule_id
     FROM breaks b
     JOIN shifts s ON s.id=b.shift_id
     WHERE s.schedule_id=?`
  )
    .bind(scheduleId)
    .all()).results as BreakRow[];

  function canWork(memberId: number, areaKey: string) {
    const m = memberById.get(memberId);
    if (!m) return false;
    if (m.all_areas === 1) return true;
    return Boolean(permsByMember.get(memberId)?.has(areaKey));
  }

  function isBlockedByStatus(memberId: number) {
    const sh = memberShift.get(memberId);
    return !sh || sh.status_key !== 'working';
  }

  function violatesAreaMins(offAreaKey: string, coverMemberId: number, coverAreaKey: string) {
    const counts = new Map(baseCounts);
    // off-person leaves their area
    counts.set(offAreaKey, (counts.get(offAreaKey) ?? 0) - 1);
    if (coverAreaKey !== offAreaKey) {
      counts.set(coverAreaKey, (counts.get(coverAreaKey) ?? 0) - 1);
      counts.set(offAreaKey, (counts.get(offAreaKey) ?? 0) + 1);
    }
    for (const [areaKey, min] of minByArea.entries()) {
      if ((counts.get(areaKey) ?? 0) < min) return true;
    }
    return false;
  }

  function breakRange(b: BreakRow) {
    return minutesRange(b.start_time, b.duration_minutes);
  }

  function hasOverlapForCover(coverMemberId: number, target: { start: number; end: number }, breakId: number) {
    for (const b of breaks) {
      if (b.id === breakId) continue;
      const r = breakRange(b);
      if (!r) continue;
      // already covering someone else
      if (b.cover_member_id === coverMemberId && overlap(target.start, target.end, r.start, r.end)) return true;
      // on their own break
      if (b.off_member_id === coverMemberId && overlap(target.start, target.end, r.start, r.end)) return true;
    }
    return false;
  }

  function isCoverValid(b: BreakRow): boolean {
    if (b.cover_member_id == null) return false;
    const coverId = b.cover_member_id;
    const coverShift = memberShift.get(coverId);
    if (!coverShift) return false;
    if (isBlockedByStatus(coverId)) return false;
    if (!canWork(coverId, b.off_area_key)) return false;

    const target = breakRange(b);
    if (!target) return false;

    if (hasOverlapForCover(coverId, target, b.id)) return false;

    if (violatesAreaMins(b.off_area_key, coverId, coverShift.home_area_key)) return false;

    return true;
  }

  function pickCover(b: BreakRow): number | null {
    const target = breakRange(b);
    if (!target) return null;

    for (const s of shifts) {
      if (s.status_key !== 'working') continue;
      if (s.member_id === b.off_member_id) continue;
      if (!canWork(s.member_id, b.off_area_key)) continue;
      if (hasOverlapForCover(s.member_id, target, b.id)) continue;
      if (violatesAreaMins(b.off_area_key, s.member_id, s.home_area_key)) continue;
      return s.member_id;
    }
    return null;
  }

  let fixed = 0;
  let stillMissing = 0;

  for (const b of breaks) {
    // Only care about breaks for working shifts
    const offShift = memberShift.get(b.off_member_id);
    if (!offShift || offShift.status_key !== 'working') continue;

    const valid = b.cover_member_id != null && isCoverValid(b);
    if (valid) continue;

    // Clear invalid cover
    if (b.cover_member_id != null) {
      await DB.prepare('UPDATE breaks SET cover_member_id=NULL WHERE id=?').bind(b.id).run();
      b.cover_member_id = null;
    }

    const pick = pickCover(b);
    if (pick) {
      await DB.prepare('UPDATE breaks SET cover_member_id=? WHERE id=?').bind(pick, b.id).run();
      b.cover_member_id = pick;
      fixed++;
    } else {
      stillMissing++;
    }
  }

  const msg = stillMissing > 0
    ? `Auto-fix complete: ${fixed} cover(s) assigned, ${stillMissing} still missing.`
    : `Auto-fix complete: ${fixed} cover(s) assigned.`;

  return redirectWithMessage(`/admin/schedule/${date}#breaks`, { notice: msg });
};
