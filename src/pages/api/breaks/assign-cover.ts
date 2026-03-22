import type { APIRoute } from 'astro';
import { requireRole } from '../../../lib/auth';
import { getDB } from '../../../lib/db';
import { overlap, minutesRange } from '../../../lib/breaks';

type StaffRow = { area_key: string; label: string; min_staff: number; count: number };

export const POST: APIRoute = async ({ request }) => {
  const guard = requireRole(request, 'admin');
  if (!guard.ok) return guard.redirect;

  const form = await request.formData();
  const date = (form.get('date') || '').toString();
  const breakId = Number(form.get('breakId'));
  const coverMemberIdRaw = (form.get('coverMemberId') || '').toString();
  const coverMemberId = coverMemberIdRaw === '' ? null : Number(coverMemberIdRaw);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Invalid date', { status: 400 });
  if (!Number.isFinite(breakId) || breakId <= 0) return new Response('Invalid breakId', { status: 400 });
  if (coverMemberId !== null && (!Number.isFinite(coverMemberId) || coverMemberId <= 0)) {
    return new Response('Invalid coverMemberId', { status: 400 });
  }

  const DB = await getDB();

  // Load target break info (incl. schedule + area)
  const target = (await DB.prepare(
    `SELECT b.id as break_id, b.start_time, b.duration_minutes,
            s.schedule_id, s.home_area_key, s.member_id AS off_member_id
     FROM breaks b
     JOIN shifts s ON s.id = b.shift_id
     WHERE b.id=?`
  )
    .bind(breakId)
    .first()) as any;

  if (!target) return new Response('Break not found', { status: 404 });

  const targetRange = minutesRange(target.start_time, target.duration_minutes);
  if (!targetRange) return redirectWithMessage(`/admin/schedule/${date}#breaks`, { error: 'Invalid break time' });

  // Load off-person shift + member area
  const offShift = (await DB.prepare(
    `SELECT s.id, s.status_key, s.home_area_key
     FROM shifts s
     WHERE s.schedule_id=? AND s.member_id=?`
  )
    .bind(target.schedule_id, target.off_member_id)
    .first()) as any;

  if (!offShift) return new Response('Off member shift not found', { status: 404 });

  if (coverMemberId !== null) {
    // Check cover eligibility: must be on the same schedule day and not blocked.
    const coverShift = (await DB.prepare(
      `SELECT s.id, s.status_key, s.home_area_key, m.all_areas
       FROM shifts s
       JOIN members m ON m.id = s.member_id
       WHERE s.schedule_id=? AND s.member_id=?`
    )
      .bind(target.schedule_id, coverMemberId)
      .first()) as any;

    if (!coverShift) return new Response('Cover member is not on the roster for this day', { status: 409 });

    const status = (await DB.prepare('SELECT blocks_coverage FROM statuses WHERE key=?')
      .bind(coverShift.status_key)
      .first()) as any;

    if (status?.blocks_coverage === 1) {
      return new Response('Cover member is not available (status blocks coverage)', { status: 409 });
    }

    // Area permission check (cover must be allowed to work the off-person area)
    const canWork = coverShift.all_areas === 1
      ? true
      : Boolean(
          (await DB.prepare(
            'SELECT 1 FROM member_area_permissions WHERE member_id=? AND area_key=?'
          )
            .bind(coverMemberId, target.home_area_key)
            .first())
        );

    if (!canWork) {
      return new Response('Cover member is not permitted to work that area', { status: 409 });
    }

    // Overlap check: cover person cannot cover two people at same time.
    const otherCoverBreaks = (await DB.prepare(
      `SELECT b.id, b.start_time, b.duration_minutes
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=? AND b.cover_member_id=? AND b.id<>?`
    )
      .bind(target.schedule_id, coverMemberId, breakId)
      .all()).results as any[];

    for (const b of otherCoverBreaks) {
      const r = minutesRange(b.start_time, b.duration_minutes);
      if (!r) continue;
      if (overlap(targetRange.start, targetRange.end, r.start, r.end)) {
        return new Response('Cover member already covering someone else during that time', { status: 409 });
      }
    }

    // Also ensure the cover member is not on break themselves
    const coverOwnBreaks = (await DB.prepare(
      `SELECT b.id, b.start_time, b.duration_minutes
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=? AND s.member_id=?`
    )
      .bind(target.schedule_id, coverMemberId)
      .all()).results as any[];

    for (const b of coverOwnBreaks) {
      const r = minutesRange(b.start_time, b.duration_minutes);
      if (!r) continue;
      if (overlap(targetRange.start, targetRange.end, r.start, r.end)) {
        return new Response('Cover member is on break during that time', { status: 409 });
      }
    }

    // Area minimum staffing check
    const staff = (await DB.prepare(
      `SELECT a.key AS area_key, a.label, a.min_staff,
              COUNT(s.id) AS count
       FROM areas a
       LEFT JOIN shifts s
         ON s.home_area_key = a.key
        AND s.schedule_id = ?
        AND s.status_key = 'working'
       GROUP BY a.key, a.label, a.min_staff`
    )
      .bind(target.schedule_id)
      .all()).results as StaffRow[];

    const counts = new Map(staff.map((r) => [r.area_key, Number(r.count)]));

    // Off-person leaves their area
    counts.set(target.home_area_key, (counts.get(target.home_area_key) ?? 0) - 1);

    // Cover person leaves their own area if different
    if (coverShift.home_area_key !== target.home_area_key) {
      counts.set(coverShift.home_area_key, (counts.get(coverShift.home_area_key) ?? 0) - 1);
      // Cover adds to the covered area
      counts.set(target.home_area_key, (counts.get(target.home_area_key) ?? 0) + 1);
    }

    const failing = staff.filter((r) => (counts.get(r.area_key) ?? 0) < Number(r.min_staff));
    if (failing.length) {
      const msg = failing
        .map((r) => `${r.label} below minimum (${counts.get(r.area_key) ?? 0}/${r.min_staff})`)
        .join('; ');
      return new Response(`Area staffing minimum would be violated: ${msg}`, { status: 409 });
    }
  }

  await DB.prepare('UPDATE breaks SET cover_member_id=? WHERE id=?')
    .bind(coverMemberId, breakId)
    .run();

  return new Response(null, { status: 303, headers: { Location: `/admin/schedule/${date}#breaks` } });
};
: 303, headers: { Location: `/admin/schedule/${date}#breaks` } });
};
