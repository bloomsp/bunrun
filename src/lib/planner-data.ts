import { buildPlannerContext, type PlannerBreak, type PlannerContext, type PlannerShift } from './break-planner';

export type PlannerMemberRow = { id: number; all_areas: number };
export type PlannerPermRow = { member_id: number; area_key: string };
export type PlannerAreaRow = { key: string; min_staff: number | null };
export type PlannerPreferredCovererRow = { shift_id: number; member_id: number; priority: number };

export type PlannerScheduleData = {
  shifts: PlannerShift[];
  breaks: PlannerBreak[];
  members: PlannerMemberRow[];
  perms: PlannerPermRow[];
  preferredRankByShiftId: Map<number, Map<number, number>>;
  minByArea: Map<string, number>;
  planner: PlannerContext;
};

export async function loadPreferredRankByShiftId(
  DB: D1Database,
  opts?: { scheduleId?: number; workBlockId?: number; shiftId?: number }
): Promise<Map<number, Map<number, number>>> {
  let sql = 'SELECT shift_id, member_id, priority FROM shift_cover_priorities';
  const binds: Array<number> = [];

  if (opts?.shiftId != null) {
    sql += ' WHERE shift_id=?';
    binds.push(opts.shiftId);
  } else if (opts?.workBlockId != null) {
    sql += ' WHERE shift_id IN (SELECT id FROM shifts WHERE work_block_id=?)';
    binds.push(opts.workBlockId);
  } else if (opts?.scheduleId != null) {
    sql += ' WHERE shift_id IN (SELECT id FROM shifts WHERE schedule_id=?)';
    binds.push(opts.scheduleId);
  }

  sql += ' ORDER BY shift_id ASC, priority ASC';
  const rows = (await DB.prepare(sql).bind(...binds).all()).results as PlannerPreferredCovererRow[];
  const preferredRankByShiftId = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const ranks = preferredRankByShiftId.get(row.shift_id) ?? new Map<number, number>();
    ranks.set(row.member_id, ranks.size);
    preferredRankByShiftId.set(row.shift_id, ranks);
  }
  return preferredRankByShiftId;
}

export async function loadPlannerScheduleData(
  DB: D1Database,
  scheduleId: number,
  opts?: { preferredCoverersFor?: { scheduleId?: number; workBlockId?: number; shiftId?: number } }
): Promise<PlannerScheduleData> {
  const shifts = (await DB.prepare(
    'SELECT id, work_block_id, member_id, home_area_key, status_key, shift_role, start_time, end_time FROM shifts WHERE schedule_id=?'
  ).bind(scheduleId).all()).results as PlannerShift[];

  const [members, perms, areas, breaks, preferredRankByShiftId] = await Promise.all([
    DB.prepare('SELECT id, all_areas FROM members').all().then((result) => result.results as PlannerMemberRow[]),
    DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all().then((result) => result.results as PlannerPermRow[]),
    DB.prepare('SELECT key, min_staff FROM areas').all().then((result) => result.results as PlannerAreaRow[]),
    DB.prepare(
      `SELECT b.id, b.work_block_id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
              s.member_id AS off_member_id, s.home_area_key AS off_area_key
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?`
    ).bind(scheduleId).all().then((result) => result.results as PlannerBreak[]),
    loadPreferredRankByShiftId(DB, opts?.preferredCoverersFor?.shiftId != null
      ? { shiftId: opts.preferredCoverersFor.shiftId }
      : opts?.preferredCoverersFor?.workBlockId != null
        ? { workBlockId: opts.preferredCoverersFor.workBlockId }
        : { scheduleId: opts?.preferredCoverersFor?.scheduleId ?? scheduleId })
  ]);

  const minByArea = new Map<string, number>(areas.map((area) => [area.key, Number(area.min_staff ?? 0)]));
  const planner = buildPlannerContext({
    shifts,
    members,
    perms,
    minByArea,
    preferredRankByShiftId
  });

  return {
    shifts,
    breaks,
    members,
    perms,
    preferredRankByShiftId,
    minByArea,
    planner
  };
}
