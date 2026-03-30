export async function memberCanWorkArea(DB: D1Database, memberId: number, areaKey: string): Promise<boolean> {
  const member = (await DB.prepare('SELECT all_areas FROM members WHERE id=?').bind(memberId).first()) as { all_areas: number } | null;
  if (!member) return false;
  if (member.all_areas === 1) return true;

  const permitted = await DB.prepare(
    'SELECT 1 FROM member_area_permissions WHERE member_id=? AND area_key=?'
  )
    .bind(memberId, areaKey)
    .first();
  return Boolean(permitted);
}

export async function assertMemberCanWorkArea(
  DB: D1Database,
  memberId: number,
  areaKey: string
): Promise<string | null> {
  const canWork = await memberCanWorkArea(DB, memberId, areaKey);
  return canWork ? null : 'Member is not permitted to work in that area';
}
