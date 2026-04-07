export type MemberLookup = {
  id: number;
  name: string;
  active: number;
  all_areas: number;
  default_area_key: string | null;
  break_preference?: string;
};

export type AreaLookup = {
  key: string;
  label: string;
  min_staff?: number;
};

export type StatusLookup = {
  key: string;
  label: string;
  blocks_coverage: number;
};

export type PermissionLookup = { member_id: number; area_key: string };

export async function loadMembers(DB: D1Database, opts?: { activeOnly?: boolean; includeBreakPreference?: boolean }) {
  const where = opts?.activeOnly ? 'WHERE active=1' : '';
  const breakPreference = opts?.includeBreakPreference ? ', break_preference' : '';
  return (await DB.prepare(
    `SELECT id, name, active, all_areas, default_area_key${breakPreference}
     FROM members
     ${where}
     ORDER BY name COLLATE NOCASE ASC`
  ).all()).results as MemberLookup[];
}

export async function loadAreas(DB: D1Database) {
  return (await DB.prepare('SELECT key, label, min_staff FROM areas ORDER BY label COLLATE NOCASE ASC').all()).results as AreaLookup[];
}

export async function loadStatuses(DB: D1Database) {
  return (await DB.prepare('SELECT key, label, blocks_coverage FROM statuses ORDER BY label COLLATE NOCASE ASC').all()).results as StatusLookup[];
}

export async function loadPermissions(DB: D1Database) {
  return (await DB.prepare('SELECT member_id, area_key FROM member_area_permissions').all()).results as PermissionLookup[];
}

export async function loadShiftCoverPriorityRows(DB: D1Database) {
  return (
    await DB.prepare(
      `SELECT scp.shift_id, scp.member_id, scp.priority, m.name
       FROM shift_cover_priorities scp
       JOIN members m ON m.id = scp.member_id
       ORDER BY scp.shift_id ASC, scp.priority ASC`
    ).all()
  ).results as Array<{ shift_id: number; member_id: number; priority: number; name: string }>;
}
