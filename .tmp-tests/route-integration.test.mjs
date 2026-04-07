// tests/route-integration.test.ts
import test from "node:test";
import assert from "node:assert/strict";

// src/lib/auth.ts
function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const out = {};
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}
function getRoleFromRequest(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  const role = cookies["bunrun_role"];
  if (role === "view" || role === "admin") return role;
  return null;
}
function requireRole(request, role) {
  const current = getRoleFromRequest(request);
  if (!current) {
    const to = role === "admin" ? "/login/admin" : "/login/view";
    return { ok: false, redirect: new Response(null, { status: 303, headers: { Location: to } }) };
  }
  if (role === "admin" && current !== "admin") {
    return {
      ok: false,
      redirect: new Response(null, {
        status: 303,
        headers: { Location: "/login/admin?error=Please+sign+in+with+the+admin+password" }
      })
    };
  }
  return { ok: true };
}

// src/lib/db.ts
async function getDB() {
  const testDB = globalThis.__bunrunTestDB;
  if (testDB) return testDB;
  try {
    const mod = await import("cloudflare:workers");
    const cfEnv = mod.env;
    if (!cfEnv?.DB) throw new Error("Missing D1 binding: DB");
    return cfEnv.DB;
  } catch (e) {
    throw new Error(
      "D1 is not available in astro dev. Use the deployed Cloudflare Worker, or run via wrangler dev to test D1 bindings."
    );
  }
}

// src/lib/redirect.ts
function redirectWithMessage(to, opts) {
  const url = new URL(to, "https://example.local");
  if (opts?.error) url.searchParams.set("error", opts.error);
  if (opts?.notice) url.searchParams.set("notice", opts.notice);
  const loc = url.pathname + (url.search ? url.search : "") + (url.hash ? url.hash : "");
  return new Response(null, { status: 303, headers: { Location: loc } });
}

// src/lib/time.ts
function parseHHMM(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh * 60 + mm;
}

// src/lib/breaks.ts
function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
function minutesRange(startHHMM, durationMinutes) {
  const s = parseHHMM(startHHMM);
  if (s == null) return null;
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration)) return null;
  return { start: s, end: s + duration };
}

// src/lib/shifts.ts
function shiftRange(shift) {
  const start = parseHHMM(shift.start_time);
  const end = shift.end_time ? parseHHMM(shift.end_time) : null;
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}
function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}
function findOverlappingShift(shifts, target, opts) {
  const excludeShiftId = opts?.excludeShiftId ?? null;
  for (const shift of shifts) {
    if (excludeShiftId != null && shift.id === excludeShiftId) continue;
    const range = shiftRange(shift);
    if (!range) continue;
    if (rangesOverlap(range, target)) return shift;
  }
  return null;
}
function shiftsActiveInRange(shifts, target, opts) {
  return shifts.filter((shift) => {
    if (opts?.workingOnly && shift.status_key !== "working") return false;
    const range = shiftRange(shift);
    return Boolean(range && rangesOverlap(range, target));
  });
}
function firstActiveShiftInRange(shifts, target, opts) {
  return shiftsActiveInRange(shifts, target, opts)[0] ?? null;
}
function countWorkingShiftsByAreaInRange(shifts, target) {
  const counts = /* @__PURE__ */ new Map();
  for (const shift of shifts) {
    if (shift.status_key !== "working") continue;
    const range = shiftRange(shift);
    if (!range || !rangesOverlap(range, target)) continue;
    counts.set(shift.home_area_key, (counts.get(shift.home_area_key) ?? 0) + 1);
  }
  return counts;
}

// src/lib/break-planner.ts
function buildPlannerContext(input) {
  const shiftsByMember = /* @__PURE__ */ new Map();
  for (const shift of input.shifts) {
    const rows = shiftsByMember.get(shift.member_id) ?? [];
    rows.push(shift);
    shiftsByMember.set(shift.member_id, rows);
  }
  const memberById = new Map(input.members.map((member) => [member.id, member]));
  const permsByMember = /* @__PURE__ */ new Map();
  for (const perm of input.perms) {
    const rows = permsByMember.get(perm.member_id) ?? /* @__PURE__ */ new Set();
    rows.add(perm.area_key);
    permsByMember.set(perm.member_id, rows);
  }
  return {
    shifts: input.shifts,
    shiftsByMember,
    memberById,
    permsByMember,
    minByArea: input.minByArea,
    preferredRankByShiftId: input.preferredRankByShiftId ?? /* @__PURE__ */ new Map()
  };
}
function breakTargetRange(row) {
  return minutesRange(row.start_time, Number(row.duration_minutes));
}
function canMemberWorkArea(context, memberId, areaKey) {
  const member = context.memberById.get(memberId);
  if (!member) return false;
  if (Number(member.all_areas) === 1) return true;
  return Boolean(context.permsByMember.get(memberId)?.has(areaKey));
}
function activeWorkingShiftForMember(context, memberId, target) {
  return firstActiveShiftInRange(context.shiftsByMember.get(memberId) ?? [], target, { workingOnly: true });
}
function hasCoverConflict(breaks, memberId, target, excludeBreakId) {
  for (const row of breaks) {
    if (excludeBreakId != null && row.id === excludeBreakId) continue;
    const range = breakTargetRange(row);
    if (!range) continue;
    if (row.cover_member_id === memberId && overlap(target.start, target.end, range.start, range.end)) return true;
    if (row.off_member_id === memberId && overlap(target.start, target.end, range.start, range.end)) return true;
  }
  return false;
}
function violatesAreaMinimums(context, breaks, targetBreak, target, coverMemberId) {
  const counts = countWorkingShiftsByAreaInRange(context.shifts, target);
  const overlappingBreaks = breaks.filter((row) => {
    const range = breakTargetRange(row);
    if (!range) return false;
    return overlap(target.start, target.end, range.start, range.end);
  });
  for (const row of overlappingBreaks) {
    const nextCoverMemberId = row.id === targetBreak.id ? coverMemberId : row.cover_member_id;
    counts.set(row.off_area_key, (counts.get(row.off_area_key) ?? 0) - 1);
    if (nextCoverMemberId == null) continue;
    const coverShift = activeWorkingShiftForMember(context, nextCoverMemberId, target);
    if (!coverShift) continue;
    if (coverShift.home_area_key !== row.off_area_key) {
      counts.set(coverShift.home_area_key, (counts.get(coverShift.home_area_key) ?? 0) - 1);
      counts.set(row.off_area_key, (counts.get(row.off_area_key) ?? 0) + 1);
    }
  }
  for (const [areaKey, activeCount] of counts.entries()) {
    if (activeCount <= 0) continue;
    const minStaff = context.minByArea.get(areaKey) ?? 0;
    if ((counts.get(areaKey) ?? 0) < minStaff) return true;
  }
  return false;
}
function isAreaCoveredWithoutAssignedCover(context, breaks, targetBreak) {
  const target = breakTargetRange(targetBreak);
  if (!target) return false;
  return !violatesAreaMinimums(context, breaks, targetBreak, target, null);
}
function coverOptionScore(context, targetBreak, coverShift) {
  const preferredRanks = context.preferredRankByShiftId.get(targetBreak.shift_id) ?? /* @__PURE__ */ new Map();
  const preferredRank = preferredRanks.get(coverShift.member_id);
  let score = 0;
  if ((coverShift.shift_role ?? "normal") === "floater") {
    score -= 120;
  }
  if (preferredRank == null) {
    score += 40;
  } else {
    score += preferredRank * 4;
  }
  if (coverShift.home_area_key !== targetBreak.off_area_key) score += 12;
  return score + coverShift.member_id / 1e4;
}
function listEligibleCoverOptions(context, breaks, targetBreak) {
  const target = breakTargetRange(targetBreak);
  if (!target) return [{ memberId: null, score: 1e3 }];
  const options = [];
  if (isAreaCoveredWithoutAssignedCover(context, breaks, targetBreak)) {
    options.push({ memberId: null, score: -20 });
  }
  for (const shift of context.shifts) {
    if (shift.status_key !== "working") continue;
    if (shift.member_id === targetBreak.off_member_id) continue;
    if (activeWorkingShiftForMember(context, shift.member_id, target)?.id !== shift.id) continue;
    if (shift.home_area_key !== targetBreak.off_area_key && !canMemberWorkArea(context, shift.member_id, targetBreak.off_area_key)) continue;
    if (hasCoverConflict(breaks, shift.member_id, target, targetBreak.id)) continue;
    if (violatesAreaMinimums(context, breaks, targetBreak, target, shift.member_id)) continue;
    options.push({
      memberId: shift.member_id,
      score: coverOptionScore(context, targetBreak, shift)
    });
  }
  options.sort((a, b) => a.score - b.score);
  if (!options.some((row) => row.memberId == null)) {
    options.push({ memberId: null, score: 1e3 });
  }
  return options;
}
function isCoverAssignmentValid(context, breaks, targetBreak, coverMemberId) {
  const target = breakTargetRange(targetBreak);
  if (!target) return false;
  if (coverMemberId == null) {
    return isAreaCoveredWithoutAssignedCover(context, breaks, targetBreak);
  }
  const coverShift = activeWorkingShiftForMember(context, coverMemberId, target);
  if (!coverShift) return false;
  if (coverShift.home_area_key !== targetBreak.off_area_key && !canMemberWorkArea(context, coverMemberId, targetBreak.off_area_key)) {
    return false;
  }
  if (hasCoverConflict(breaks, coverMemberId, target, targetBreak.id)) return false;
  if (violatesAreaMinimums(context, breaks, targetBreak, target, coverMemberId)) return false;
  return true;
}

// src/lib/http.ts
function isISODate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function getString(form, key, fallback = "") {
  return (form.get(key) ?? fallback).toString();
}
function getTrimmedString(form, key, fallback = "") {
  return getString(form, key, fallback).trim();
}
function getPositiveInt(form, key) {
  const value = Number(form.get(key));
  return Number.isFinite(value) && value > 0 ? value : null;
}
function getOptionalPositiveInt(form, key) {
  const raw = getTrimmedString(form, key);
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : void 0;
}
function getReturnTo(form, fallback) {
  const value = getTrimmedString(form, "returnTo", fallback);
  return value || fallback;
}
function getUniquePositiveInts(form, key, limit) {
  const values = form.getAll(key).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  const unique = [...new Set(values)];
  return typeof limit === "number" ? unique.slice(0, limit) : unique;
}

// src/lib/planner-data.ts
async function loadPreferredRankByShiftId(DB, opts) {
  let sql = "SELECT shift_id, member_id, priority FROM shift_cover_priorities";
  const binds = [];
  if (opts?.shiftId != null) {
    sql += " WHERE shift_id=?";
    binds.push(opts.shiftId);
  } else if (opts?.workBlockId != null) {
    sql += " WHERE shift_id IN (SELECT id FROM shifts WHERE work_block_id=?)";
    binds.push(opts.workBlockId);
  } else if (opts?.scheduleId != null) {
    sql += " WHERE shift_id IN (SELECT id FROM shifts WHERE schedule_id=?)";
    binds.push(opts.scheduleId);
  }
  sql += " ORDER BY shift_id ASC, priority ASC";
  const rows = (await DB.prepare(sql).bind(...binds).all()).results;
  const preferredRankByShiftId = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const ranks = preferredRankByShiftId.get(row.shift_id) ?? /* @__PURE__ */ new Map();
    ranks.set(row.member_id, ranks.size);
    preferredRankByShiftId.set(row.shift_id, ranks);
  }
  return preferredRankByShiftId;
}
async function loadPlannerScheduleData(DB, scheduleId, opts) {
  const shifts = (await DB.prepare(
    "SELECT id, work_block_id, member_id, home_area_key, status_key, shift_role, start_time, end_time FROM shifts WHERE schedule_id=?"
  ).bind(scheduleId).all()).results;
  const [members, perms, areas, breaks, preferredRankByShiftId] = await Promise.all([
    DB.prepare("SELECT id, all_areas FROM members").all().then((result) => result.results),
    DB.prepare("SELECT member_id, area_key FROM member_area_permissions").all().then((result) => result.results),
    DB.prepare("SELECT key, min_staff FROM areas").all().then((result) => result.results),
    DB.prepare(
      `SELECT b.id, b.work_block_id, b.shift_id, b.start_time, b.duration_minutes, b.cover_member_id,
              s.member_id AS off_member_id, s.home_area_key AS off_area_key
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?`
    ).bind(scheduleId).all().then((result) => result.results),
    loadPreferredRankByShiftId(DB, opts?.preferredCoverersFor?.shiftId != null ? { shiftId: opts.preferredCoverersFor.shiftId } : opts?.preferredCoverersFor?.workBlockId != null ? { workBlockId: opts.preferredCoverersFor.workBlockId } : { scheduleId: opts?.preferredCoverersFor?.scheduleId ?? scheduleId })
  ]);
  const minByArea = new Map(areas.map((area) => [area.key, Number(area.min_staff ?? 0)]));
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

// src/pages/api/breaks/assign-cover.ts
var POST = async ({ request }) => {
  const guard = requireRole(request, "admin");
  if (!guard.ok) return guard.redirect;
  const form = await request.formData();
  const date = getString(form, "date");
  const breakId = getPositiveInt(form, "breakId");
  const coverMemberId = getOptionalPositiveInt(form, "coverMemberId");
  const returnTo = getReturnTo(form, `/admin/schedule/${date}?panel=breaks#breaks`);
  if (!isISODate(date)) return redirectWithMessage(returnTo, { error: "Invalid date" });
  if (breakId == null) return redirectWithMessage(returnTo, { error: "Invalid break" });
  if (coverMemberId === void 0) {
    return redirectWithMessage(returnTo, { error: "Invalid cover selection" });
  }
  const DB = await getDB();
  const target = await DB.prepare(
    `SELECT b.id as break_id, b.start_time, b.duration_minutes,
            s.id AS off_shift_id, s.schedule_id, s.home_area_key, s.member_id AS off_member_id
     FROM breaks b
     JOIN shifts s ON s.id = b.shift_id
     WHERE b.id=?`
  ).bind(breakId).first();
  if (!target) return redirectWithMessage(returnTo, { error: "Break not found" });
  if (coverMemberId !== null) {
    const { planner, breaks } = await loadPlannerScheduleData(DB, target.schedule_id, {
      preferredCoverersFor: { shiftId: target.off_shift_id }
    });
    const currentBreak = breaks.find((row) => row.id === breakId);
    if (!currentBreak) return redirectWithMessage(returnTo, { error: "Break not found" });
    const validCandidateIds = new Set(
      listEligibleCoverOptions(planner, breaks, currentBreak).map((row) => row.memberId).filter((value) => value != null)
    );
    if (!validCandidateIds.has(coverMemberId) || !isCoverAssignmentValid(planner, breaks, currentBreak, coverMemberId)) {
      return redirectWithMessage(returnTo, { error: "Selected cover member is not available for that break" });
    }
  }
  await DB.prepare("UPDATE breaks SET cover_member_id=? WHERE id=?").bind(coverMemberId, breakId).run();
  return redirectWithMessage(returnTo, { notice: "Cover updated" });
};

// src/lib/area-permissions.ts
async function memberCanWorkArea(DB, memberId, areaKey) {
  const member = await DB.prepare("SELECT all_areas FROM members WHERE id=?").bind(memberId).first();
  if (!member) return false;
  if (member.all_areas === 1) return true;
  const permitted = await DB.prepare(
    "SELECT 1 FROM member_area_permissions WHERE member_id=? AND area_key=?"
  ).bind(memberId, areaKey).first();
  return Boolean(permitted);
}
async function assertMemberCanWorkArea(DB, memberId, areaKey) {
  const canWork = await memberCanWorkArea(DB, memberId, areaKey);
  return canWork ? null : "Member is not permitted to work in that area";
}

// src/lib/work-blocks.ts
function workBlockTestHooks() {
  return globalThis.__bunrunWorkBlockTestHooks;
}
function shiftContainsTime(shift, timeHHMM) {
  const start = parseHHMM(shift.start_time);
  const end = shift.end_time ? parseHHMM(shift.end_time) : null;
  const time = parseHHMM(timeHHMM);
  if (start == null || end == null || time == null) return false;
  return start <= time && time < end;
}
function activeShiftAtTime(shifts, memberId, timeHHMM) {
  return shifts.find((shift) => shift.member_id === memberId && shift.status_key === "working" && shiftContainsTime(shift, timeHHMM)) ?? null;
}
function buildPendingWorkBlocks(shifts) {
  const working = shifts.filter((shift) => shift.status_key === "working").slice().sort(
    (a, b) => a.member_id - b.member_id || a.start_time.localeCompare(b.start_time) || (a.end_time ?? "").localeCompare(b.end_time ?? "") || a.id - b.id
  );
  const blocks = [];
  let current = null;
  for (const shift of working) {
    if (!shift.end_time) continue;
    if (!current || current.member_id !== shift.member_id || current.end_time !== shift.start_time) {
      current = {
        member_id: shift.member_id,
        start_time: shift.start_time,
        end_time: shift.end_time,
        total_minutes: Number(shift.shift_minutes ?? 0),
        shiftIds: [shift.id]
      };
      blocks.push(current);
      continue;
    }
    current.end_time = shift.end_time;
    current.total_minutes += Number(shift.shift_minutes ?? 0);
    current.shiftIds.push(shift.id);
  }
  return blocks;
}
async function recomputeWorkBlocksForSchedule(DB, scheduleId) {
  const hook = workBlockTestHooks()?.recomputeWorkBlocksForSchedule;
  if (hook) {
    await hook(DB, scheduleId);
    return;
  }
  const shifts = (await DB.prepare(
    `SELECT id, schedule_id, member_id, status_key, home_area_key, start_time, end_time, shift_minutes, work_block_id
       FROM shifts
       WHERE schedule_id=?
       ORDER BY member_id ASC, start_time ASC, id ASC`
  ).bind(scheduleId).all()).results;
  const breaks = (await DB.prepare(
    `SELECT b.id, b.shift_id, b.start_time
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=?`
  ).bind(scheduleId).all()).results;
  await DB.batch([
    DB.prepare("UPDATE shifts SET work_block_id=NULL WHERE schedule_id=?").bind(scheduleId),
    DB.prepare(
      `UPDATE breaks
       SET work_block_id=NULL
       WHERE id IN (
         SELECT b.id
         FROM breaks b
         JOIN shifts s ON s.id = b.shift_id
         WHERE s.schedule_id=?
       )`
    ).bind(scheduleId),
    DB.prepare("DELETE FROM work_blocks WHERE schedule_id=?").bind(scheduleId)
  ]);
  const pendingBlocks = buildPendingWorkBlocks(shifts);
  const shiftsById = new Map(shifts.map((shift) => [shift.id, shift]));
  for (const pending of pendingBlocks) {
    const insert = await DB.prepare(
      `INSERT INTO work_blocks (schedule_id, member_id, start_time, end_time, total_minutes)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(scheduleId, pending.member_id, pending.start_time, pending.end_time, pending.total_minutes).run();
    const workBlockId = Number(insert?.meta?.last_row_id ?? 0);
    if (!workBlockId) continue;
    const shiftUpdates = [];
    for (const shiftId of pending.shiftIds) {
      shiftUpdates.push(DB.prepare("UPDATE shifts SET work_block_id=? WHERE id=?").bind(workBlockId, shiftId));
      const shift = shiftsById.get(shiftId);
      if (shift) shift.work_block_id = workBlockId;
    }
    if (shiftUpdates.length > 0) {
      await DB.batch(shiftUpdates);
    }
  }
  const breakUpdates = [];
  for (const row of breaks) {
    const oldShift = shiftsById.get(row.shift_id);
    if (!oldShift) continue;
    const activeShift = activeShiftAtTime(shifts, oldShift.member_id, row.start_time) ?? oldShift;
    breakUpdates.push(
      DB.prepare("UPDATE breaks SET shift_id=?, work_block_id=? WHERE id=?").bind(activeShift.id, activeShift.work_block_id ?? null, row.id)
    );
  }
  if (breakUpdates.length > 0) {
    await DB.batch(breakUpdates);
  }
}
async function clearMemberBreakPlanForSchedule(DB, scheduleId, memberId) {
  const hook = workBlockTestHooks()?.clearMemberBreakPlanForSchedule;
  if (hook) {
    await hook(DB, scheduleId, memberId);
    return;
  }
  await DB.prepare(
    `DELETE FROM breaks
     WHERE id IN (
       SELECT b.id
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=? AND s.member_id=?
     )`
  ).bind(scheduleId, memberId).run();
  await DB.prepare(
    `UPDATE breaks
     SET cover_member_id=NULL
     WHERE id IN (
       SELECT b.id
       FROM breaks b
       JOIN shifts s ON s.id = b.shift_id
       WHERE s.schedule_id=? AND b.cover_member_id=?
     )`
  ).bind(scheduleId, memberId).run();
}

// src/pages/api/shifts/update.ts
var POST2 = async ({ request }) => {
  const guard = requireRole(request, "admin");
  if (!guard.ok) return guard.redirect;
  const form = await request.formData();
  const date = getString(form, "date");
  const shiftId = getPositiveInt(form, "shiftId");
  const homeAreaKey = getString(form, "homeAreaKey");
  const statusKey = getString(form, "statusKey");
  const shiftRole = (form.get("shiftRole") || "normal").toString() === "floater" ? "floater" : "normal";
  const startTime = (form.get("startTime") || "").toString();
  const endTime = (form.get("endTime") || "").toString();
  const preferredCovererIds = getUniquePositiveInts(form, "preferredCovererIds", 4);
  if (!isISODate(date)) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: "Invalid date" });
  if (shiftId == null) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: "Invalid shift" });
  const startMin = parseHHMM(startTime);
  const endMin = parseHHMM(endTime);
  if (startMin == null || endMin == null) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: "Invalid time" });
  if (endMin <= startMin) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: "End time must be after start time (same day)." });
  const shiftMinutes = endMin - startMin;
  if (shiftMinutes > 10 * 60) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: "Shift exceeds 10 hours max." });
  const DB = await getDB();
  const current = await DB.prepare("SELECT schedule_id, member_id, start_time, end_time, work_block_id FROM shifts WHERE id=?").bind(shiftId).first();
  if (!current) return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: "Shift not found" });
  const permissionError = await assertMemberCanWorkArea(DB, current.member_id, homeAreaKey);
  if (permissionError) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: permissionError });
  }
  if (preferredCovererIds.some((memberId) => memberId === current.member_id)) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, { error: "A member cannot be their own preferred coverer" });
  }
  const uniquePreferredCovererIds = preferredCovererIds;
  const siblingShifts = (await DB.prepare(
    "SELECT id, member_id, home_area_key, status_key, start_time, end_time FROM shifts WHERE schedule_id=? AND member_id=?"
  ).bind(current.schedule_id, current.member_id).all()).results;
  const overlap2 = findOverlappingShift(siblingShifts, { start: startMin, end: endMin }, { excludeShiftId: shiftId });
  if (overlap2) {
    return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
      error: `Shift overlaps another shift for this member (${overlap2.start_time}-${overlap2.end_time ?? "\u2014"}).`
    });
  }
  await DB.prepare(
    "UPDATE shifts SET home_area_key=?, status_key=?, shift_role=?, start_time=?, end_time=?, shift_minutes=? WHERE id=?"
  ).bind(homeAreaKey, statusKey, shiftRole, startTime, endTime, shiftMinutes, shiftId).run();
  await recomputeWorkBlocksForSchedule(DB, current.schedule_id);
  await clearMemberBreakPlanForSchedule(DB, current.schedule_id, current.member_id);
  const priorityStatements = [DB.prepare("DELETE FROM shift_cover_priorities WHERE shift_id=?").bind(shiftId)];
  for (const [index, memberId] of uniquePreferredCovererIds.entries()) {
    priorityStatements.push(
      DB.prepare("INSERT INTO shift_cover_priorities (shift_id, member_id, priority) VALUES (?, ?, ?)").bind(shiftId, memberId, index + 1)
    );
  }
  await DB.batch(priorityStatements);
  if (statusKey === "sick") {
    const sickRange = shiftRange({ start_time: startTime, end_time: endTime });
    if (sickRange) {
      const coverAssignments = (await DB.prepare(
        `SELECT b.id, b.start_time, b.duration_minutes
           FROM breaks b
           JOIN shifts s ON s.id = b.shift_id
           WHERE s.schedule_id=? AND b.cover_member_id=?`
      ).bind(current.schedule_id, current.member_id).all()).results;
      const clearingStatements = [];
      for (const assignment of coverAssignments) {
        const start = parseHHMM(assignment.start_time);
        if (start == null) continue;
        const end = start + Number(assignment.duration_minutes);
        if (start < sickRange.end && sickRange.start < end) {
          clearingStatements.push(DB.prepare("UPDATE breaks SET cover_member_id=NULL WHERE id=?").bind(assignment.id));
        }
      }
      if (clearingStatements.length > 0) {
        await DB.batch(clearingStatements);
      }
    }
  }
  return redirectWithMessage(`/admin/schedule/${date}#shifts`, {
    notice: statusKey === "sick" ? "Shift updated (Sick applied). Break plan cleared for that member." : "Shift updated. Break plan cleared for that member."
  });
};

// tests/helpers/route-test-helpers.ts
var FakeStatement = class {
  sql;
  handlers;
  args = [];
  constructor(sql, handlers) {
    this.sql = sql;
    this.handlers = handlers;
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    return this.handlers.first(this.sql, this.args);
  }
  async all() {
    return { results: await this.handlers.all(this.sql, this.args) };
  }
  async run() {
    return this.handlers.run(this.sql, this.args);
  }
};
var RouteDB = class {
  firstHandlers = /* @__PURE__ */ new Map();
  allHandlers = /* @__PURE__ */ new Map();
  runs = [];
  batches = [];
  prepare(sql) {
    return new FakeStatement(sql, this);
  }
  async first(sql, args) {
    const entry = [...this.firstHandlers.entries()].find(([key]) => sql.includes(key));
    if (!entry) return null;
    return typeof entry[1] === "function" ? entry[1](args, sql) : entry[1];
  }
  async all(sql, args) {
    const entry = [...this.allHandlers.entries()].find(([key]) => sql.includes(key));
    if (!entry) return [];
    return typeof entry[1] === "function" ? entry[1](args, sql) : entry[1];
  }
  async run(sql, args) {
    this.runs.push({ sql, args });
    return { meta: { changes: 1, last_row_id: 1 } };
  }
  async batch(statements) {
    this.batches.push(statements.map((statement) => ({ sql: statement.sql, args: statement.args })));
    return [];
  }
};
function adminRequest(url, form) {
  const body = new URLSearchParams(form);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: "bunrun_role=admin"
    },
    body
  });
}
function installTestDB(db) {
  globalThis.__bunrunTestDB = db;
}
function installWorkBlockHooks(hooks) {
  globalThis.__bunrunWorkBlockTestHooks = hooks;
}
function resetRouteTestGlobals() {
  delete globalThis.__bunrunTestDB;
  delete globalThis.__bunrunWorkBlockTestHooks;
}

// tests/route-integration.test.ts
test.afterEach(() => {
  resetRouteTestGlobals();
});
test("assign-cover route persists a valid cover selection", async () => {
  const db = new RouteDB();
  db.firstHandlers.set("FROM breaks b", {
    break_id: 5,
    start_time: "09:00",
    duration_minutes: 15,
    off_shift_id: 1,
    schedule_id: 99,
    home_area_key: "registers",
    off_member_id: 10
  });
  db.allHandlers.set("FROM shifts WHERE schedule_id=?", [
    { id: 1, member_id: 10, home_area_key: "registers", status_key: "working", shift_role: "normal", start_time: "06:00", end_time: "12:00" },
    { id: 2, member_id: 20, home_area_key: "registers", status_key: "working", shift_role: "floater", start_time: "06:00", end_time: "12:00" }
  ]);
  db.allHandlers.set("SELECT id, all_areas FROM members", [
    { id: 10, all_areas: 1 },
    { id: 20, all_areas: 1 }
  ]);
  db.allHandlers.set("SELECT member_id, area_key FROM member_area_permissions", []);
  db.allHandlers.set("SELECT key, min_staff FROM areas", [{ key: "registers", min_staff: 1 }]);
  db.allHandlers.set("SELECT shift_id, member_id, priority FROM shift_cover_priorities", [{ shift_id: 1, member_id: 20, priority: 1 }]);
  db.allHandlers.set("FROM breaks b\n       JOIN shifts s ON s.id = b.shift_id", [
    { id: 5, work_block_id: 1, shift_id: 1, start_time: "09:00", duration_minutes: 15, cover_member_id: null, off_member_id: 10, off_area_key: "registers" }
  ]);
  installTestDB(db);
  const response = await POST({
    request: adminRequest("https://example.test/api/breaks/assign-cover", {
      date: "2026-04-07",
      breakId: "5",
      coverMemberId: "20",
      returnTo: "/admin/schedule/2026-04-07?panel=breaks#breaks"
    })
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/admin/schedule/2026-04-07?panel=breaks&notice=Cover+updated#breaks");
  assert.ok(db.runs.some((run) => run.sql.includes("UPDATE breaks SET cover_member_id=? WHERE id=?") && run.args[0] === 20 && run.args[1] === 5));
});
test("assign-cover route rejects an unavailable cover selection", async () => {
  const db = new RouteDB();
  db.firstHandlers.set("FROM breaks b", {
    break_id: 5,
    start_time: "09:00",
    duration_minutes: 15,
    off_shift_id: 1,
    schedule_id: 99,
    home_area_key: "registers",
    off_member_id: 10
  });
  db.allHandlers.set("FROM shifts WHERE schedule_id=?", [
    { id: 1, member_id: 10, home_area_key: "registers", status_key: "working", shift_role: "normal", start_time: "06:00", end_time: "12:00" },
    { id: 2, member_id: 20, home_area_key: "service-desk", status_key: "sick", shift_role: "normal", start_time: "06:00", end_time: "12:00" }
  ]);
  db.allHandlers.set("SELECT id, all_areas FROM members", [
    { id: 10, all_areas: 1 },
    { id: 20, all_areas: 0 }
  ]);
  db.allHandlers.set("SELECT member_id, area_key FROM member_area_permissions", []);
  db.allHandlers.set("SELECT key, min_staff FROM areas", [{ key: "registers", min_staff: 1 }]);
  db.allHandlers.set("SELECT shift_id, member_id, priority FROM shift_cover_priorities", [{ shift_id: 1, member_id: 20, priority: 1 }]);
  db.allHandlers.set("FROM breaks b\n       JOIN shifts s ON s.id = b.shift_id", [
    { id: 5, work_block_id: 1, shift_id: 1, start_time: "09:00", duration_minutes: 15, cover_member_id: null, off_member_id: 10, off_area_key: "registers" }
  ]);
  installTestDB(db);
  const response = await POST({
    request: adminRequest("https://example.test/api/breaks/assign-cover", {
      date: "2026-04-07",
      breakId: "5",
      coverMemberId: "20",
      returnTo: "/admin/schedule/2026-04-07?panel=breaks#breaks"
    })
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("Location") ?? "", /error=Selected\+cover\+member\+is\+not\+available/);
  assert.equal(db.runs.length, 0);
});
test("shift-update route clears overlapping cover assignments when marking a shift sick", async () => {
  const db = new RouteDB();
  db.firstHandlers.set("SELECT schedule_id, member_id, start_time, end_time, work_block_id FROM shifts WHERE id=?", {
    schedule_id: 77,
    member_id: 20,
    start_time: "06:00",
    end_time: "12:00",
    work_block_id: 10
  });
  db.firstHandlers.set("SELECT all_areas FROM members WHERE id=?", { all_areas: 1 });
  db.allHandlers.set("SELECT id, member_id, home_area_key, status_key, start_time, end_time FROM shifts WHERE schedule_id=? AND member_id=?", [
    { id: 12, member_id: 20, home_area_key: "registers", status_key: "working", start_time: "06:00", end_time: "12:00" }
  ]);
  db.allHandlers.set("FROM breaks b\n           JOIN shifts s ON s.id = b.shift_id\n           WHERE s.schedule_id=? AND b.cover_member_id=?", [
    { id: 300, start_time: "09:00", duration_minutes: 30 },
    { id: 301, start_time: "12:30", duration_minutes: 15 }
  ]);
  installTestDB(db);
  installWorkBlockHooks({
    recomputeWorkBlocksForSchedule: () => {
    },
    clearMemberBreakPlanForSchedule: () => {
    }
  });
  const response = await POST2({
    request: adminRequest("https://example.test/api/shifts/update", {
      date: "2026-04-07",
      shiftId: "12",
      homeAreaKey: "registers",
      statusKey: "sick",
      shiftRole: "normal",
      startTime: "08:00",
      endTime: "11:00"
    })
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("Location") ?? "", /notice=Shift\+updated\+%28Sick\+applied%29\.\+Break\+plan\+cleared\+for\+that\+member\./);
  assert.ok(db.batches.some((batch) => batch.some((stmt) => stmt.sql.includes("DELETE FROM shift_cover_priorities"))));
  assert.ok(db.batches.some((batch) => batch.some((stmt) => stmt.sql.includes("UPDATE breaks SET cover_member_id=NULL WHERE id=?") && stmt.args[0] === 300)));
  assert.ok(!db.batches.some((batch) => batch.some((stmt) => stmt.sql.includes("UPDATE breaks SET cover_member_id=NULL WHERE id=?") && stmt.args[0] === 301)));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvcm91dGUtaW50ZWdyYXRpb24udGVzdC50cyIsICIuLi9zcmMvbGliL2F1dGgudHMiLCAiLi4vc3JjL2xpYi9kYi50cyIsICIuLi9zcmMvbGliL3JlZGlyZWN0LnRzIiwgIi4uL3NyYy9saWIvdGltZS50cyIsICIuLi9zcmMvbGliL2JyZWFrcy50cyIsICIuLi9zcmMvbGliL3NoaWZ0cy50cyIsICIuLi9zcmMvbGliL2JyZWFrLXBsYW5uZXIudHMiLCAiLi4vc3JjL2xpYi9odHRwLnRzIiwgIi4uL3NyYy9saWIvcGxhbm5lci1kYXRhLnRzIiwgIi4uL3NyYy9wYWdlcy9hcGkvYnJlYWtzL2Fzc2lnbi1jb3Zlci50cyIsICIuLi9zcmMvbGliL2FyZWEtcGVybWlzc2lvbnMudHMiLCAiLi4vc3JjL2xpYi93b3JrLWJsb2Nrcy50cyIsICIuLi9zcmMvcGFnZXMvYXBpL3NoaWZ0cy91cGRhdGUudHMiLCAiLi4vdGVzdHMvaGVscGVycy9yb3V0ZS10ZXN0LWhlbHBlcnMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5cbmltcG9ydCB7IFBPU1QgYXMgYXNzaWduQ292ZXJQT1NUIH0gZnJvbSAnLi4vc3JjL3BhZ2VzL2FwaS9icmVha3MvYXNzaWduLWNvdmVyLnRzJztcbmltcG9ydCB7IFBPU1QgYXMgc2hpZnRVcGRhdGVQT1NUIH0gZnJvbSAnLi4vc3JjL3BhZ2VzL2FwaS9zaGlmdHMvdXBkYXRlLnRzJztcbmltcG9ydCB7IGFkbWluUmVxdWVzdCwgaW5zdGFsbFRlc3REQiwgaW5zdGFsbFdvcmtCbG9ja0hvb2tzLCByZXNldFJvdXRlVGVzdEdsb2JhbHMsIFJvdXRlREIgfSBmcm9tICcuL2hlbHBlcnMvcm91dGUtdGVzdC1oZWxwZXJzLnRzJztcblxudGVzdC5hZnRlckVhY2goKCkgPT4ge1xuICByZXNldFJvdXRlVGVzdEdsb2JhbHMoKTtcbn0pO1xuXG50ZXN0KCdhc3NpZ24tY292ZXIgcm91dGUgcGVyc2lzdHMgYSB2YWxpZCBjb3ZlciBzZWxlY3Rpb24nLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGRiID0gbmV3IFJvdXRlREIoKTtcbiAgZGIuZmlyc3RIYW5kbGVycy5zZXQoJ0ZST00gYnJlYWtzIGInLCB7XG4gICAgYnJlYWtfaWQ6IDUsXG4gICAgc3RhcnRfdGltZTogJzA5OjAwJyxcbiAgICBkdXJhdGlvbl9taW51dGVzOiAxNSxcbiAgICBvZmZfc2hpZnRfaWQ6IDEsXG4gICAgc2NoZWR1bGVfaWQ6IDk5LFxuICAgIGhvbWVfYXJlYV9rZXk6ICdyZWdpc3RlcnMnLFxuICAgIG9mZl9tZW1iZXJfaWQ6IDEwXG4gIH0pO1xuICBkYi5hbGxIYW5kbGVycy5zZXQoJ0ZST00gc2hpZnRzIFdIRVJFIHNjaGVkdWxlX2lkPT8nLCBbXG4gICAgeyBpZDogMSwgbWVtYmVyX2lkOiAxMCwgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsIHN0YXR1c19rZXk6ICd3b3JraW5nJywgc2hpZnRfcm9sZTogJ25vcm1hbCcsIHN0YXJ0X3RpbWU6ICcwNjowMCcsIGVuZF90aW1lOiAnMTI6MDAnIH0sXG4gICAgeyBpZDogMiwgbWVtYmVyX2lkOiAyMCwgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsIHN0YXR1c19rZXk6ICd3b3JraW5nJywgc2hpZnRfcm9sZTogJ2Zsb2F0ZXInLCBzdGFydF90aW1lOiAnMDY6MDAnLCBlbmRfdGltZTogJzEyOjAwJyB9XG4gIF0pO1xuICBkYi5hbGxIYW5kbGVycy5zZXQoJ1NFTEVDVCBpZCwgYWxsX2FyZWFzIEZST00gbWVtYmVycycsIFtcbiAgICB7IGlkOiAxMCwgYWxsX2FyZWFzOiAxIH0sXG4gICAgeyBpZDogMjAsIGFsbF9hcmVhczogMSB9XG4gIF0pO1xuICBkYi5hbGxIYW5kbGVycy5zZXQoJ1NFTEVDVCBtZW1iZXJfaWQsIGFyZWFfa2V5IEZST00gbWVtYmVyX2FyZWFfcGVybWlzc2lvbnMnLCBbXSk7XG4gIGRiLmFsbEhhbmRsZXJzLnNldCgnU0VMRUNUIGtleSwgbWluX3N0YWZmIEZST00gYXJlYXMnLCBbeyBrZXk6ICdyZWdpc3RlcnMnLCBtaW5fc3RhZmY6IDEgfV0pO1xuICBkYi5hbGxIYW5kbGVycy5zZXQoJ1NFTEVDVCBzaGlmdF9pZCwgbWVtYmVyX2lkLCBwcmlvcml0eSBGUk9NIHNoaWZ0X2NvdmVyX3ByaW9yaXRpZXMnLCBbeyBzaGlmdF9pZDogMSwgbWVtYmVyX2lkOiAyMCwgcHJpb3JpdHk6IDEgfV0pO1xuICBkYi5hbGxIYW5kbGVycy5zZXQoJ0ZST00gYnJlYWtzIGJcXG4gICAgICAgSk9JTiBzaGlmdHMgcyBPTiBzLmlkID0gYi5zaGlmdF9pZCcsIFtcbiAgICB7IGlkOiA1LCB3b3JrX2Jsb2NrX2lkOiAxLCBzaGlmdF9pZDogMSwgc3RhcnRfdGltZTogJzA5OjAwJywgZHVyYXRpb25fbWludXRlczogMTUsIGNvdmVyX21lbWJlcl9pZDogbnVsbCwgb2ZmX21lbWJlcl9pZDogMTAsIG9mZl9hcmVhX2tleTogJ3JlZ2lzdGVycycgfVxuICBdKTtcbiAgaW5zdGFsbFRlc3REQihkYik7XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBhc3NpZ25Db3ZlclBPU1Qoe1xuICAgIHJlcXVlc3Q6IGFkbWluUmVxdWVzdCgnaHR0cHM6Ly9leGFtcGxlLnRlc3QvYXBpL2JyZWFrcy9hc3NpZ24tY292ZXInLCB7XG4gICAgICBkYXRlOiAnMjAyNi0wNC0wNycsXG4gICAgICBicmVha0lkOiAnNScsXG4gICAgICBjb3Zlck1lbWJlcklkOiAnMjAnLFxuICAgICAgcmV0dXJuVG86ICcvYWRtaW4vc2NoZWR1bGUvMjAyNi0wNC0wNz9wYW5lbD1icmVha3MjYnJlYWtzJ1xuICAgIH0pXG4gIH0gYXMgYW55KTtcblxuICBhc3NlcnQuZXF1YWwocmVzcG9uc2Uuc3RhdHVzLCAzMDMpO1xuICBhc3NlcnQuZXF1YWwocmVzcG9uc2UuaGVhZGVycy5nZXQoJ0xvY2F0aW9uJyksICcvYWRtaW4vc2NoZWR1bGUvMjAyNi0wNC0wNz9wYW5lbD1icmVha3Mmbm90aWNlPUNvdmVyK3VwZGF0ZWQjYnJlYWtzJyk7XG4gIGFzc2VydC5vayhkYi5ydW5zLnNvbWUoKHJ1bikgPT4gcnVuLnNxbC5pbmNsdWRlcygnVVBEQVRFIGJyZWFrcyBTRVQgY292ZXJfbWVtYmVyX2lkPT8gV0hFUkUgaWQ9PycpICYmIHJ1bi5hcmdzWzBdID09PSAyMCAmJiBydW4uYXJnc1sxXSA9PT0gNSkpO1xufSk7XG5cbnRlc3QoJ2Fzc2lnbi1jb3ZlciByb3V0ZSByZWplY3RzIGFuIHVuYXZhaWxhYmxlIGNvdmVyIHNlbGVjdGlvbicsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZGIgPSBuZXcgUm91dGVEQigpO1xuICBkYi5maXJzdEhhbmRsZXJzLnNldCgnRlJPTSBicmVha3MgYicsIHtcbiAgICBicmVha19pZDogNSxcbiAgICBzdGFydF90aW1lOiAnMDk6MDAnLFxuICAgIGR1cmF0aW9uX21pbnV0ZXM6IDE1LFxuICAgIG9mZl9zaGlmdF9pZDogMSxcbiAgICBzY2hlZHVsZV9pZDogOTksXG4gICAgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsXG4gICAgb2ZmX21lbWJlcl9pZDogMTBcbiAgfSk7XG4gIGRiLmFsbEhhbmRsZXJzLnNldCgnRlJPTSBzaGlmdHMgV0hFUkUgc2NoZWR1bGVfaWQ9PycsIFtcbiAgICB7IGlkOiAxLCBtZW1iZXJfaWQ6IDEwLCBob21lX2FyZWFfa2V5OiAncmVnaXN0ZXJzJywgc3RhdHVzX2tleTogJ3dvcmtpbmcnLCBzaGlmdF9yb2xlOiAnbm9ybWFsJywgc3RhcnRfdGltZTogJzA2OjAwJywgZW5kX3RpbWU6ICcxMjowMCcgfSxcbiAgICB7IGlkOiAyLCBtZW1iZXJfaWQ6IDIwLCBob21lX2FyZWFfa2V5OiAnc2VydmljZS1kZXNrJywgc3RhdHVzX2tleTogJ3NpY2snLCBzaGlmdF9yb2xlOiAnbm9ybWFsJywgc3RhcnRfdGltZTogJzA2OjAwJywgZW5kX3RpbWU6ICcxMjowMCcgfVxuICBdKTtcbiAgZGIuYWxsSGFuZGxlcnMuc2V0KCdTRUxFQ1QgaWQsIGFsbF9hcmVhcyBGUk9NIG1lbWJlcnMnLCBbXG4gICAgeyBpZDogMTAsIGFsbF9hcmVhczogMSB9LFxuICAgIHsgaWQ6IDIwLCBhbGxfYXJlYXM6IDAgfVxuICBdKTtcbiAgZGIuYWxsSGFuZGxlcnMuc2V0KCdTRUxFQ1QgbWVtYmVyX2lkLCBhcmVhX2tleSBGUk9NIG1lbWJlcl9hcmVhX3Blcm1pc3Npb25zJywgW10pO1xuICBkYi5hbGxIYW5kbGVycy5zZXQoJ1NFTEVDVCBrZXksIG1pbl9zdGFmZiBGUk9NIGFyZWFzJywgW3sga2V5OiAncmVnaXN0ZXJzJywgbWluX3N0YWZmOiAxIH1dKTtcbiAgZGIuYWxsSGFuZGxlcnMuc2V0KCdTRUxFQ1Qgc2hpZnRfaWQsIG1lbWJlcl9pZCwgcHJpb3JpdHkgRlJPTSBzaGlmdF9jb3Zlcl9wcmlvcml0aWVzJywgW3sgc2hpZnRfaWQ6IDEsIG1lbWJlcl9pZDogMjAsIHByaW9yaXR5OiAxIH1dKTtcbiAgZGIuYWxsSGFuZGxlcnMuc2V0KCdGUk9NIGJyZWFrcyBiXFxuICAgICAgIEpPSU4gc2hpZnRzIHMgT04gcy5pZCA9IGIuc2hpZnRfaWQnLCBbXG4gICAgeyBpZDogNSwgd29ya19ibG9ja19pZDogMSwgc2hpZnRfaWQ6IDEsIHN0YXJ0X3RpbWU6ICcwOTowMCcsIGR1cmF0aW9uX21pbnV0ZXM6IDE1LCBjb3Zlcl9tZW1iZXJfaWQ6IG51bGwsIG9mZl9tZW1iZXJfaWQ6IDEwLCBvZmZfYXJlYV9rZXk6ICdyZWdpc3RlcnMnIH1cbiAgXSk7XG4gIGluc3RhbGxUZXN0REIoZGIpO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgYXNzaWduQ292ZXJQT1NUKHtcbiAgICByZXF1ZXN0OiBhZG1pblJlcXVlc3QoJ2h0dHBzOi8vZXhhbXBsZS50ZXN0L2FwaS9icmVha3MvYXNzaWduLWNvdmVyJywge1xuICAgICAgZGF0ZTogJzIwMjYtMDQtMDcnLFxuICAgICAgYnJlYWtJZDogJzUnLFxuICAgICAgY292ZXJNZW1iZXJJZDogJzIwJyxcbiAgICAgIHJldHVyblRvOiAnL2FkbWluL3NjaGVkdWxlLzIwMjYtMDQtMDc/cGFuZWw9YnJlYWtzI2JyZWFrcydcbiAgICB9KVxuICB9IGFzIGFueSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3BvbnNlLnN0YXR1cywgMzAzKTtcbiAgYXNzZXJ0Lm1hdGNoKHJlc3BvbnNlLmhlYWRlcnMuZ2V0KCdMb2NhdGlvbicpID8/ICcnLCAvZXJyb3I9U2VsZWN0ZWRcXCtjb3ZlclxcK21lbWJlclxcK2lzXFwrbm90XFwrYXZhaWxhYmxlLyk7XG4gIGFzc2VydC5lcXVhbChkYi5ydW5zLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdCgnc2hpZnQtdXBkYXRlIHJvdXRlIGNsZWFycyBvdmVybGFwcGluZyBjb3ZlciBhc3NpZ25tZW50cyB3aGVuIG1hcmtpbmcgYSBzaGlmdCBzaWNrJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBkYiA9IG5ldyBSb3V0ZURCKCk7XG4gIGRiLmZpcnN0SGFuZGxlcnMuc2V0KCdTRUxFQ1Qgc2NoZWR1bGVfaWQsIG1lbWJlcl9pZCwgc3RhcnRfdGltZSwgZW5kX3RpbWUsIHdvcmtfYmxvY2tfaWQgRlJPTSBzaGlmdHMgV0hFUkUgaWQ9PycsIHtcbiAgICBzY2hlZHVsZV9pZDogNzcsXG4gICAgbWVtYmVyX2lkOiAyMCxcbiAgICBzdGFydF90aW1lOiAnMDY6MDAnLFxuICAgIGVuZF90aW1lOiAnMTI6MDAnLFxuICAgIHdvcmtfYmxvY2tfaWQ6IDEwXG4gIH0pO1xuICBkYi5maXJzdEhhbmRsZXJzLnNldCgnU0VMRUNUIGFsbF9hcmVhcyBGUk9NIG1lbWJlcnMgV0hFUkUgaWQ9PycsIHsgYWxsX2FyZWFzOiAxIH0pO1xuICBkYi5hbGxIYW5kbGVycy5zZXQoJ1NFTEVDVCBpZCwgbWVtYmVyX2lkLCBob21lX2FyZWFfa2V5LCBzdGF0dXNfa2V5LCBzdGFydF90aW1lLCBlbmRfdGltZSBGUk9NIHNoaWZ0cyBXSEVSRSBzY2hlZHVsZV9pZD0/IEFORCBtZW1iZXJfaWQ9PycsIFtcbiAgICB7IGlkOiAxMiwgbWVtYmVyX2lkOiAyMCwgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsIHN0YXR1c19rZXk6ICd3b3JraW5nJywgc3RhcnRfdGltZTogJzA2OjAwJywgZW5kX3RpbWU6ICcxMjowMCcgfVxuICBdKTtcbiAgZGIuYWxsSGFuZGxlcnMuc2V0KCdGUk9NIGJyZWFrcyBiXFxuICAgICAgICAgICBKT0lOIHNoaWZ0cyBzIE9OIHMuaWQgPSBiLnNoaWZ0X2lkXFxuICAgICAgICAgICBXSEVSRSBzLnNjaGVkdWxlX2lkPT8gQU5EIGIuY292ZXJfbWVtYmVyX2lkPT8nLCBbXG4gICAgeyBpZDogMzAwLCBzdGFydF90aW1lOiAnMDk6MDAnLCBkdXJhdGlvbl9taW51dGVzOiAzMCB9LFxuICAgIHsgaWQ6IDMwMSwgc3RhcnRfdGltZTogJzEyOjMwJywgZHVyYXRpb25fbWludXRlczogMTUgfVxuICBdKTtcbiAgaW5zdGFsbFRlc3REQihkYik7XG4gIGluc3RhbGxXb3JrQmxvY2tIb29rcyh7XG4gICAgcmVjb21wdXRlV29ya0Jsb2Nrc0ZvclNjaGVkdWxlOiAoKSA9PiB7fSxcbiAgICBjbGVhck1lbWJlckJyZWFrUGxhbkZvclNjaGVkdWxlOiAoKSA9PiB7fVxuICB9KTtcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNoaWZ0VXBkYXRlUE9TVCh7XG4gICAgcmVxdWVzdDogYWRtaW5SZXF1ZXN0KCdodHRwczovL2V4YW1wbGUudGVzdC9hcGkvc2hpZnRzL3VwZGF0ZScsIHtcbiAgICAgIGRhdGU6ICcyMDI2LTA0LTA3JyxcbiAgICAgIHNoaWZ0SWQ6ICcxMicsXG4gICAgICBob21lQXJlYUtleTogJ3JlZ2lzdGVycycsXG4gICAgICBzdGF0dXNLZXk6ICdzaWNrJyxcbiAgICAgIHNoaWZ0Um9sZTogJ25vcm1hbCcsXG4gICAgICBzdGFydFRpbWU6ICcwODowMCcsXG4gICAgICBlbmRUaW1lOiAnMTE6MDAnXG4gICAgfSlcbiAgfSBhcyBhbnkpO1xuXG4gIGFzc2VydC5lcXVhbChyZXNwb25zZS5zdGF0dXMsIDMwMyk7XG4gIGFzc2VydC5tYXRjaChyZXNwb25zZS5oZWFkZXJzLmdldCgnTG9jYXRpb24nKSA/PyAnJywgL25vdGljZT1TaGlmdFxcK3VwZGF0ZWRcXCslMjhTaWNrXFwrYXBwbGllZCUyOVxcLlxcK0JyZWFrXFwrcGxhblxcK2NsZWFyZWRcXCtmb3JcXCt0aGF0XFwrbWVtYmVyXFwuLyk7XG4gIGFzc2VydC5vayhkYi5iYXRjaGVzLnNvbWUoKGJhdGNoKSA9PiBiYXRjaC5zb21lKChzdG10KSA9PiBzdG10LnNxbC5pbmNsdWRlcygnREVMRVRFIEZST00gc2hpZnRfY292ZXJfcHJpb3JpdGllcycpKSkpO1xuICBhc3NlcnQub2soZGIuYmF0Y2hlcy5zb21lKChiYXRjaCkgPT4gYmF0Y2guc29tZSgoc3RtdCkgPT4gc3RtdC5zcWwuaW5jbHVkZXMoJ1VQREFURSBicmVha3MgU0VUIGNvdmVyX21lbWJlcl9pZD1OVUxMIFdIRVJFIGlkPT8nKSAmJiBzdG10LmFyZ3NbMF0gPT09IDMwMCkpKTtcbiAgYXNzZXJ0Lm9rKCFkYi5iYXRjaGVzLnNvbWUoKGJhdGNoKSA9PiBiYXRjaC5zb21lKChzdG10KSA9PiBzdG10LnNxbC5pbmNsdWRlcygnVVBEQVRFIGJyZWFrcyBTRVQgY292ZXJfbWVtYmVyX2lkPU5VTEwgV0hFUkUgaWQ9PycpICYmIHN0bXQuYXJnc1swXSA9PT0gMzAxKSkpO1xufSk7XG4iLCAiZXhwb3J0IHR5cGUgQXV0aFJvbGUgPSAndmlldycgfCAnYWRtaW4nO1xuXG5jb25zdCBDT09LSUVfQkFTRSA9ICdQYXRoPS87IEh0dHBPbmx5OyBTYW1lU2l0ZT1MYXgnO1xuXG5mdW5jdGlvbiBwYXJzZUNvb2tpZXMoY29va2llSGVhZGVyOiBzdHJpbmcgfCBudWxsKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGlmICghY29va2llSGVhZGVyKSByZXR1cm4ge307XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBmb3IgKGNvbnN0IHBhcnQgb2YgY29va2llSGVhZGVyLnNwbGl0KCc7JykpIHtcbiAgICBjb25zdCBbaywgLi4ucmVzdF0gPSBwYXJ0LnRyaW0oKS5zcGxpdCgnPScpO1xuICAgIGlmICghaykgY29udGludWU7XG4gICAgb3V0W2tdID0gZGVjb2RlVVJJQ29tcG9uZW50KHJlc3Quam9pbignPScpKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Um9sZUZyb21SZXF1ZXN0KHJlcXVlc3Q6IFJlcXVlc3QpOiBBdXRoUm9sZSB8IG51bGwge1xuICBjb25zdCBjb29raWVzID0gcGFyc2VDb29raWVzKHJlcXVlc3QuaGVhZGVycy5nZXQoJ2Nvb2tpZScpKTtcbiAgY29uc3Qgcm9sZSA9IGNvb2tpZXNbJ2J1bnJ1bl9yb2xlJ107XG4gIGlmIChyb2xlID09PSAndmlldycgfHwgcm9sZSA9PT0gJ2FkbWluJykgcmV0dXJuIHJvbGU7XG4gIHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVxdWlyZVJvbGUocmVxdWVzdDogUmVxdWVzdCwgcm9sZTogQXV0aFJvbGUpOiB7IG9rOiB0cnVlIH0gfCB7IG9rOiBmYWxzZTsgcmVkaXJlY3Q6IFJlc3BvbnNlIH0ge1xuICBjb25zdCBjdXJyZW50ID0gZ2V0Um9sZUZyb21SZXF1ZXN0KHJlcXVlc3QpO1xuICBpZiAoIWN1cnJlbnQpIHtcbiAgICBjb25zdCB0byA9IHJvbGUgPT09ICdhZG1pbicgPyAnL2xvZ2luL2FkbWluJyA6ICcvbG9naW4vdmlldyc7XG4gICAgLy8gVXNlIGEgcmVsYXRpdmUgcmVkaXJlY3QgZm9yIG1heGltdW0gY29tcGF0aWJpbGl0eSBpbiB0aGUgUGFnZXMvV29ya2VycyBydW50aW1lLlxuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVkaXJlY3Q6IG5ldyBSZXNwb25zZShudWxsLCB7IHN0YXR1czogMzAzLCBoZWFkZXJzOiB7IExvY2F0aW9uOiB0byB9IH0pIH07XG4gIH1cbiAgaWYgKHJvbGUgPT09ICdhZG1pbicgJiYgY3VycmVudCAhPT0gJ2FkbWluJykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICByZWRpcmVjdDogbmV3IFJlc3BvbnNlKG51bGwsIHtcbiAgICAgICAgc3RhdHVzOiAzMDMsXG4gICAgICAgIGhlYWRlcnM6IHsgTG9jYXRpb246ICcvbG9naW4vYWRtaW4/ZXJyb3I9UGxlYXNlK3NpZ24raW4rd2l0aCt0aGUrYWRtaW4rcGFzc3dvcmQnIH1cbiAgICAgIH0pXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNTZWN1cmVSZXF1ZXN0KHJlcXVlc3Q6IFJlcXVlc3QpIHtcbiAgcmV0dXJuIG5ldyBVUkwocmVxdWVzdC51cmwpLnByb3RvY29sID09PSAnaHR0cHM6Jztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvb2tpZUZvclJvbGUocm9sZTogQXV0aFJvbGUsIG9wdHM/OiB7IHNlY3VyZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBtYXhBZ2UgPSA2MCAqIDYwICogMTI7IC8vIDEyIGhvdXJzXG4gIGNvbnN0IHNlY3VyZSA9IG9wdHM/LnNlY3VyZSA/PyBmYWxzZTtcbiAgcmV0dXJuIGBidW5ydW5fcm9sZT0ke3JvbGV9OyAke0NPT0tJRV9CQVNFfTsgTWF4LUFnZT0ke21heEFnZX0ke3NlY3VyZSA/ICc7IFNlY3VyZScgOiAnJ31gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJSb2xlQ29va2llKG9wdHM/OiB7IHNlY3VyZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBzZWN1cmUgPSBvcHRzPy5zZWN1cmUgPz8gZmFsc2U7XG4gIHJldHVybiBgYnVucnVuX3JvbGU9OyAke0NPT0tJRV9CQVNFfTsgTWF4LUFnZT0wJHtzZWN1cmUgPyAnOyBTZWN1cmUnIDogJyd9YDtcbn1cbiIsICIvLyBDbG91ZGZsYXJlIEQxIGFjY2Vzc1xuLy9cbi8vIEluIEFzdHJvIHY2ICsgQ2xvdWRmbGFyZSBhZGFwdGVyLCBgQXN0cm8ubG9jYWxzLnJ1bnRpbWUuZW52YCBpcyBubyBsb25nZXIgYXZhaWxhYmxlLlxuLy8gVGhlIHJlY29tbWVuZGVkIGFwcHJvYWNoIGlzIGBpbXBvcnQgeyBlbnYgfSBmcm9tIFwiY2xvdWRmbGFyZTp3b3JrZXJzXCJgLlxuLy9cbi8vIEluIGBhc3RybyBkZXZgIChOb2RlKSwgQ2xvdWRmbGFyZSBydW50aW1lIGJpbmRpbmdzIChEMSkgYXJlIG5vdCBhdmFpbGFibGUuXG4vLyBXZSBzdXJmYWNlIGEgY2xlYXIgZXJyb3Igc28gcGFnZXMgY2FuIHNob3cgYSBmcmllbmRseSBcIkRCIG5vdCBjb25maWd1cmVkXCIgbWVzc2FnZS5cblxuZXhwb3J0IHR5cGUgRW52ID0ge1xuICBEQjogRDFEYXRhYmFzZTtcbn07XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXREQigpOiBQcm9taXNlPEQxRGF0YWJhc2U+IHtcbiAgY29uc3QgdGVzdERCID0gKGdsb2JhbFRoaXMgYXMgYW55KS5fX2J1bnJ1blRlc3REQiBhcyBEMURhdGFiYXNlIHwgdW5kZWZpbmVkO1xuICBpZiAodGVzdERCKSByZXR1cm4gdGVzdERCO1xuXG4gIHRyeSB7XG4gICAgLy8gT25seSB3b3JrcyBpbiB0aGUgQ2xvdWRmbGFyZSBydW50aW1lIChQYWdlcy9Xb3JrZXJzKS5cbiAgICBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoJ2Nsb3VkZmxhcmU6d29ya2VycycpO1xuICAgIGNvbnN0IGNmRW52ID0gKG1vZCBhcyBhbnkpLmVudiBhcyBFbnYgfCB1bmRlZmluZWQ7XG4gICAgaWYgKCFjZkVudj8uREIpIHRocm93IG5ldyBFcnJvcignTWlzc2luZyBEMSBiaW5kaW5nOiBEQicpO1xuICAgIHJldHVybiBjZkVudi5EQjtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICdEMSBpcyBub3QgYXZhaWxhYmxlIGluIGFzdHJvIGRldi4gVXNlIHRoZSBkZXBsb3llZCBDbG91ZGZsYXJlIFdvcmtlciwgb3IgcnVuIHZpYSB3cmFuZ2xlciBkZXYgdG8gdGVzdCBEMSBiaW5kaW5ncy4nXG4gICAgKTtcbiAgfVxufVxuIiwgImV4cG9ydCBmdW5jdGlvbiByZWRpcmVjdFdpdGhNZXNzYWdlKHRvOiBzdHJpbmcsIG9wdHM/OiB7IGVycm9yPzogc3RyaW5nOyBub3RpY2U/OiBzdHJpbmcgfSkge1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHRvLCAnaHR0cHM6Ly9leGFtcGxlLmxvY2FsJyk7XG4gIGlmIChvcHRzPy5lcnJvcikgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2Vycm9yJywgb3B0cy5lcnJvcik7XG4gIGlmIChvcHRzPy5ub3RpY2UpIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdub3RpY2UnLCBvcHRzLm5vdGljZSk7XG4gIC8vIFN0cmlwIGZha2Ugb3JpZ2luXG4gIGNvbnN0IGxvYyA9IHVybC5wYXRobmFtZSArICh1cmwuc2VhcmNoID8gdXJsLnNlYXJjaCA6ICcnKSArICh1cmwuaGFzaCA/IHVybC5oYXNoIDogJycpO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKG51bGwsIHsgc3RhdHVzOiAzMDMsIGhlYWRlcnM6IHsgTG9jYXRpb246IGxvYyB9IH0pO1xufVxuIiwgImV4cG9ydCBmdW5jdGlvbiBwYXJzZUhITU0odmFsdWU6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtID0gL14oWzAxXT9cXGR8MlswLTNdKTooWzAtNV1cXGQpJC8uZXhlYyh2YWx1ZS50cmltKCkpO1xuICBpZiAoIW0pIHJldHVybiBudWxsO1xuICBjb25zdCBoaCA9IE51bWJlcihtWzFdKTtcbiAgY29uc3QgbW0gPSBOdW1iZXIobVsyXSk7XG4gIHJldHVybiBoaCAqIDYwICsgbW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREdXJhdGlvbk1pbnV0ZXModG90YWw6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHNpZ24gPSB0b3RhbCA8IDAgPyAnLScgOiAnJztcbiAgY29uc3QgbSA9IE1hdGguYWJzKHRvdGFsKTtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IobSAvIDYwKTtcbiAgY29uc3QgciA9IG0gJSA2MDtcbiAgaWYgKGggPT09IDApIHJldHVybiBgJHtzaWdufSR7cn1tYDtcbiAgaWYgKHIgPT09IDApIHJldHVybiBgJHtzaWdufSR7aH1oYDtcbiAgcmV0dXJuIGAke3NpZ259JHtofWggJHtyfW1gO1xufVxuXG4vLyBCcmlzYmFuZSBpcyBVVEMrMTAgd2l0aCBubyBEU1QuXG5jb25zdCBCUklTQkFORV9PRkZTRVQgPSAnKzEwOjAwJztcblxuZXhwb3J0IGZ1bmN0aW9uIGRheVR5cGVGb3JEYXRlKGRhdGVZWVlZTU1ERDogc3RyaW5nKTogJ3dlZWtkYXknIHwgJ3dlZWtlbmQnIHwgbnVsbCB7XG4gIGlmICghL15cXGR7NH0tXFxkezJ9LVxcZHsyfSQvLnRlc3QoZGF0ZVlZWVlNTUREKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGQgPSBuZXcgRGF0ZShgJHtkYXRlWVlZWU1NRER9VDAwOjAwOjAwJHtCUklTQkFORV9PRkZTRVR9YCk7XG4gIGNvbnN0IGRvdyA9IGQuZ2V0VVRDRGF5KCk7XG4gIC8vIDAgU3VuLCA2IFNhdFxuICByZXR1cm4gZG93ID09PSAwIHx8IGRvdyA9PT0gNiA/ICd3ZWVrZW5kJyA6ICd3ZWVrZGF5Jztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRvSEhNTSh0b3RhbE1pbnV0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGhoID0gTWF0aC5mbG9vcih0b3RhbE1pbnV0ZXMgLyA2MCkgJSAyNDtcbiAgY29uc3QgbW0gPSB0b3RhbE1pbnV0ZXMgJSA2MDtcbiAgcmV0dXJuIGAke1N0cmluZyhoaCkucGFkU3RhcnQoMiwgJzAnKX06JHtTdHJpbmcobW0pLnBhZFN0YXJ0KDIsICcwJyl9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9wZXJhdGluZ0hvdXJzRm9yKGRhdGVZWVlZTU1ERDogc3RyaW5nKTogeyBvcGVuOiBudW1iZXI7IGNsb3NlOiBudW1iZXIgfSB8IG51bGwge1xuICBjb25zdCBkdCA9IGRheVR5cGVGb3JEYXRlKGRhdGVZWVlZTU1ERCk7XG4gIGlmICghZHQpIHJldHVybiBudWxsO1xuICAvLyB3ZWVrZW5kIDA2OjAwLTE5OjE1LCB3ZWVrZGF5IDA2OjAwLTIxOjE1XG4gIHJldHVybiBkdCA9PT0gJ3dlZWtlbmQnXG4gICAgPyB7IG9wZW46IDYgKiA2MCwgY2xvc2U6IDE5ICogNjAgKyAxNSB9XG4gICAgOiB7IG9wZW46IDYgKiA2MCwgY2xvc2U6IDIxICogNjAgKyAxNSB9O1xufVxuIiwgImltcG9ydCB7IHBhcnNlSEhNTSB9IGZyb20gJy4vdGltZSc7XG5cbmV4cG9ydCBmdW5jdGlvbiBicmVha0FsbG93YW5jZU1pbnV0ZXMoc2hpZnRNaW51dGVzOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAoc2hpZnRNaW51dGVzIDwgNCAqIDYwKSByZXR1cm4gMDtcbiAgaWYgKHNoaWZ0TWludXRlcyA8PSA1ICogNjApIHJldHVybiAxNTtcbiAgaWYgKHNoaWZ0TWludXRlcyA8IDcgKiA2MCkgcmV0dXJuIDQ1O1xuICBpZiAoc2hpZnRNaW51dGVzIDwgMTAgKiA2MCkgcmV0dXJuIDYwO1xuICByZXR1cm4gOTA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvdmVybGFwKGFTdGFydDogbnVtYmVyLCBhRW5kOiBudW1iZXIsIGJTdGFydDogbnVtYmVyLCBiRW5kOiBudW1iZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIGFTdGFydCA8IGJFbmQgJiYgYlN0YXJ0IDwgYUVuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1pbnV0ZXNSYW5nZShzdGFydEhITU06IHN0cmluZywgZHVyYXRpb25NaW51dGVzOiBudW1iZXIpOiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0gfCBudWxsIHtcbiAgY29uc3QgcyA9IHBhcnNlSEhNTShzdGFydEhITU0pO1xuICBpZiAocyA9PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZHVyYXRpb24gPSBOdW1iZXIoZHVyYXRpb25NaW51dGVzKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoZHVyYXRpb24pKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc3RhcnQ6IHMsIGVuZDogcyArIGR1cmF0aW9uIH07XG59XG4iLCAiaW1wb3J0IHsgcGFyc2VISE1NIH0gZnJvbSAnLi90aW1lJztcblxuZXhwb3J0IHR5cGUgU2hpZnRUaW1lTGlrZSA9IHtcbiAgaWQ/OiBudW1iZXI7XG4gIG1lbWJlcl9pZDogbnVtYmVyO1xuICBob21lX2FyZWFfa2V5OiBzdHJpbmc7XG4gIHN0YXR1c19rZXk6IHN0cmluZztcbiAgc3RhcnRfdGltZTogc3RyaW5nO1xuICBlbmRfdGltZTogc3RyaW5nIHwgbnVsbDtcbn07XG5cbmV4cG9ydCB0eXBlIE1pbnV0ZVJhbmdlID0ge1xuICBzdGFydDogbnVtYmVyO1xuICBlbmQ6IG51bWJlcjtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBzaGlmdFJhbmdlKHNoaWZ0OiBQaWNrPFNoaWZ0VGltZUxpa2UsICdzdGFydF90aW1lJyB8ICdlbmRfdGltZSc+KTogTWludXRlUmFuZ2UgfCBudWxsIHtcbiAgY29uc3Qgc3RhcnQgPSBwYXJzZUhITU0oc2hpZnQuc3RhcnRfdGltZSk7XG4gIGNvbnN0IGVuZCA9IHNoaWZ0LmVuZF90aW1lID8gcGFyc2VISE1NKHNoaWZ0LmVuZF90aW1lKSA6IG51bGw7XG4gIGlmIChzdGFydCA9PSBudWxsIHx8IGVuZCA9PSBudWxsIHx8IGVuZCA8PSBzdGFydCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHN0YXJ0LCBlbmQgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJhbmdlc092ZXJsYXAoYTogTWludXRlUmFuZ2UsIGI6IE1pbnV0ZVJhbmdlKTogYm9vbGVhbiB7XG4gIHJldHVybiBhLnN0YXJ0IDwgYi5lbmQgJiYgYi5zdGFydCA8IGEuZW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZmluZE92ZXJsYXBwaW5nU2hpZnQoXG4gIHNoaWZ0czogQXJyYXk8U2hpZnRUaW1lTGlrZT4sXG4gIHRhcmdldDogTWludXRlUmFuZ2UsXG4gIG9wdHM/OiB7IGV4Y2x1ZGVTaGlmdElkPzogbnVtYmVyIH1cbik6IFNoaWZ0VGltZUxpa2UgfCBudWxsIHtcbiAgY29uc3QgZXhjbHVkZVNoaWZ0SWQgPSBvcHRzPy5leGNsdWRlU2hpZnRJZCA/PyBudWxsO1xuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIHNoaWZ0cykge1xuICAgIGlmIChleGNsdWRlU2hpZnRJZCAhPSBudWxsICYmIHNoaWZ0LmlkID09PSBleGNsdWRlU2hpZnRJZCkgY29udGludWU7XG4gICAgY29uc3QgcmFuZ2UgPSBzaGlmdFJhbmdlKHNoaWZ0KTtcbiAgICBpZiAoIXJhbmdlKSBjb250aW51ZTtcbiAgICBpZiAocmFuZ2VzT3ZlcmxhcChyYW5nZSwgdGFyZ2V0KSkgcmV0dXJuIHNoaWZ0O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hpZnRzQWN0aXZlSW5SYW5nZShzaGlmdHM6IEFycmF5PFNoaWZ0VGltZUxpa2U+LCB0YXJnZXQ6IE1pbnV0ZVJhbmdlLCBvcHRzPzogeyB3b3JraW5nT25seT86IGJvb2xlYW4gfSkge1xuICByZXR1cm4gc2hpZnRzLmZpbHRlcigoc2hpZnQpID0+IHtcbiAgICBpZiAob3B0cz8ud29ya2luZ09ubHkgJiYgc2hpZnQuc3RhdHVzX2tleSAhPT0gJ3dvcmtpbmcnKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcmFuZ2UgPSBzaGlmdFJhbmdlKHNoaWZ0KTtcbiAgICByZXR1cm4gQm9vbGVhbihyYW5nZSAmJiByYW5nZXNPdmVybGFwKHJhbmdlLCB0YXJnZXQpKTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaXJzdEFjdGl2ZVNoaWZ0SW5SYW5nZShcbiAgc2hpZnRzOiBBcnJheTxTaGlmdFRpbWVMaWtlPixcbiAgdGFyZ2V0OiBNaW51dGVSYW5nZSxcbiAgb3B0cz86IHsgd29ya2luZ09ubHk/OiBib29sZWFuIH1cbikge1xuICByZXR1cm4gc2hpZnRzQWN0aXZlSW5SYW5nZShzaGlmdHMsIHRhcmdldCwgb3B0cylbMF0gPz8gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvdW50V29ya2luZ1NoaWZ0c0J5QXJlYUluUmFuZ2Uoc2hpZnRzOiBBcnJheTxTaGlmdFRpbWVMaWtlPiwgdGFyZ2V0OiBNaW51dGVSYW5nZSkge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIHNoaWZ0cykge1xuICAgIGlmIChzaGlmdC5zdGF0dXNfa2V5ICE9PSAnd29ya2luZycpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJhbmdlID0gc2hpZnRSYW5nZShzaGlmdCk7XG4gICAgaWYgKCFyYW5nZSB8fCAhcmFuZ2VzT3ZlcmxhcChyYW5nZSwgdGFyZ2V0KSkgY29udGludWU7XG4gICAgY291bnRzLnNldChzaGlmdC5ob21lX2FyZWFfa2V5LCAoY291bnRzLmdldChzaGlmdC5ob21lX2FyZWFfa2V5KSA/PyAwKSArIDEpO1xuICB9XG4gIHJldHVybiBjb3VudHM7XG59XG4iLCAiaW1wb3J0IHsgb3ZlcmxhcCwgbWludXRlc1JhbmdlIH0gZnJvbSAnLi9icmVha3MnO1xuaW1wb3J0IHsgY291bnRXb3JraW5nU2hpZnRzQnlBcmVhSW5SYW5nZSwgZmlyc3RBY3RpdmVTaGlmdEluUmFuZ2UgfSBmcm9tICcuL3NoaWZ0cyc7XG5cbmV4cG9ydCB0eXBlIFBsYW5uZXJTaGlmdCA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgbWVtYmVyX2lkOiBudW1iZXI7XG4gIGhvbWVfYXJlYV9rZXk6IHN0cmluZztcbiAgc3RhdHVzX2tleTogc3RyaW5nO1xuICBzaGlmdF9yb2xlPzogc3RyaW5nO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGVuZF90aW1lOiBzdHJpbmcgfCBudWxsO1xufTtcblxuZXhwb3J0IHR5cGUgUGxhbm5lckJyZWFrID0ge1xuICBpZDogbnVtYmVyO1xuICB3b3JrX2Jsb2NrX2lkOiBudW1iZXIgfCBudWxsO1xuICBzaGlmdF9pZDogbnVtYmVyO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGR1cmF0aW9uX21pbnV0ZXM6IG51bWJlcjtcbiAgY292ZXJfbWVtYmVyX2lkOiBudW1iZXIgfCBudWxsO1xuICBvZmZfbWVtYmVyX2lkOiBudW1iZXI7XG4gIG9mZl9zaGlmdF9pZD86IG51bWJlcjtcbiAgb2ZmX2FyZWFfa2V5OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBQbGFubmVyTWVtYmVyID0ge1xuICBpZDogbnVtYmVyO1xuICBhbGxfYXJlYXM6IG51bWJlcjtcbn07XG5cbmV4cG9ydCB0eXBlIFBsYW5uZXJDb250ZXh0ID0ge1xuICBzaGlmdHM6IFBsYW5uZXJTaGlmdFtdO1xuICBzaGlmdHNCeU1lbWJlcjogTWFwPG51bWJlciwgUGxhbm5lclNoaWZ0W10+O1xuICBtZW1iZXJCeUlkOiBNYXA8bnVtYmVyLCBQbGFubmVyTWVtYmVyPjtcbiAgcGVybXNCeU1lbWJlcjogTWFwPG51bWJlciwgU2V0PHN0cmluZz4+O1xuICBtaW5CeUFyZWE6IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ6IE1hcDxudW1iZXIsIE1hcDxudW1iZXIsIG51bWJlcj4+O1xufTtcblxudHlwZSBDb3Zlck9wdGlvbiA9IHtcbiAgbWVtYmVySWQ6IG51bWJlciB8IG51bGw7XG4gIHNjb3JlOiBudW1iZXI7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRQbGFubmVyQ29udGV4dChpbnB1dDoge1xuICBzaGlmdHM6IFBsYW5uZXJTaGlmdFtdO1xuICBtZW1iZXJzOiBQbGFubmVyTWVtYmVyW107XG4gIHBlcm1zOiBBcnJheTx7IG1lbWJlcl9pZDogbnVtYmVyOyBhcmVhX2tleTogc3RyaW5nIH0+O1xuICBtaW5CeUFyZWE6IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ/OiBNYXA8bnVtYmVyLCBNYXA8bnVtYmVyLCBudW1iZXI+Pjtcbn0pOiBQbGFubmVyQ29udGV4dCB7XG4gIGNvbnN0IHNoaWZ0c0J5TWVtYmVyID0gbmV3IE1hcDxudW1iZXIsIFBsYW5uZXJTaGlmdFtdPigpO1xuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIGlucHV0LnNoaWZ0cykge1xuICAgIGNvbnN0IHJvd3MgPSBzaGlmdHNCeU1lbWJlci5nZXQoc2hpZnQubWVtYmVyX2lkKSA/PyBbXTtcbiAgICByb3dzLnB1c2goc2hpZnQpO1xuICAgIHNoaWZ0c0J5TWVtYmVyLnNldChzaGlmdC5tZW1iZXJfaWQsIHJvd3MpO1xuICB9XG5cbiAgY29uc3QgbWVtYmVyQnlJZCA9IG5ldyBNYXAoaW5wdXQubWVtYmVycy5tYXAoKG1lbWJlcikgPT4gW21lbWJlci5pZCwgbWVtYmVyXSkpO1xuICBjb25zdCBwZXJtc0J5TWVtYmVyID0gbmV3IE1hcDxudW1iZXIsIFNldDxzdHJpbmc+PigpO1xuICBmb3IgKGNvbnN0IHBlcm0gb2YgaW5wdXQucGVybXMpIHtcbiAgICBjb25zdCByb3dzID0gcGVybXNCeU1lbWJlci5nZXQocGVybS5tZW1iZXJfaWQpID8/IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIHJvd3MuYWRkKHBlcm0uYXJlYV9rZXkpO1xuICAgIHBlcm1zQnlNZW1iZXIuc2V0KHBlcm0ubWVtYmVyX2lkLCByb3dzKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc2hpZnRzOiBpbnB1dC5zaGlmdHMsXG4gICAgc2hpZnRzQnlNZW1iZXIsXG4gICAgbWVtYmVyQnlJZCxcbiAgICBwZXJtc0J5TWVtYmVyLFxuICAgIG1pbkJ5QXJlYTogaW5wdXQubWluQnlBcmVhLFxuICAgIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ6IGlucHV0LnByZWZlcnJlZFJhbmtCeVNoaWZ0SWQgPz8gbmV3IE1hcCgpXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBicmVha1RhcmdldFJhbmdlKHJvdzogUGljazxQbGFubmVyQnJlYWssICdzdGFydF90aW1lJyB8ICdkdXJhdGlvbl9taW51dGVzJz4pIHtcbiAgcmV0dXJuIG1pbnV0ZXNSYW5nZShyb3cuc3RhcnRfdGltZSwgTnVtYmVyKHJvdy5kdXJhdGlvbl9taW51dGVzKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYW5NZW1iZXJXb3JrQXJlYShjb250ZXh0OiBQbGFubmVyQ29udGV4dCwgbWVtYmVySWQ6IG51bWJlciwgYXJlYUtleTogc3RyaW5nKSB7XG4gIGNvbnN0IG1lbWJlciA9IGNvbnRleHQubWVtYmVyQnlJZC5nZXQobWVtYmVySWQpO1xuICBpZiAoIW1lbWJlcikgcmV0dXJuIGZhbHNlO1xuICBpZiAoTnVtYmVyKG1lbWJlci5hbGxfYXJlYXMpID09PSAxKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIEJvb2xlYW4oY29udGV4dC5wZXJtc0J5TWVtYmVyLmdldChtZW1iZXJJZCk/LmhhcyhhcmVhS2V5KSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhY3RpdmVXb3JraW5nU2hpZnRGb3JNZW1iZXIoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBtZW1iZXJJZDogbnVtYmVyLFxuICB0YXJnZXQ6IHsgc3RhcnQ6IG51bWJlcjsgZW5kOiBudW1iZXIgfVxuKSB7XG4gIHJldHVybiBmaXJzdEFjdGl2ZVNoaWZ0SW5SYW5nZShjb250ZXh0LnNoaWZ0c0J5TWVtYmVyLmdldChtZW1iZXJJZCkgPz8gW10sIHRhcmdldCwgeyB3b3JraW5nT25seTogdHJ1ZSB9KSBhcyBQbGFubmVyU2hpZnQgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzQ292ZXJDb25mbGljdChcbiAgYnJlYWtzOiBQbGFubmVyQnJlYWtbXSxcbiAgbWVtYmVySWQ6IG51bWJlcixcbiAgdGFyZ2V0OiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0sXG4gIGV4Y2x1ZGVCcmVha0lkPzogbnVtYmVyXG4pIHtcbiAgZm9yIChjb25zdCByb3cgb2YgYnJlYWtzKSB7XG4gICAgaWYgKGV4Y2x1ZGVCcmVha0lkICE9IG51bGwgJiYgcm93LmlkID09PSBleGNsdWRlQnJlYWtJZCkgY29udGludWU7XG4gICAgY29uc3QgcmFuZ2UgPSBicmVha1RhcmdldFJhbmdlKHJvdyk7XG4gICAgaWYgKCFyYW5nZSkgY29udGludWU7XG4gICAgaWYgKHJvdy5jb3Zlcl9tZW1iZXJfaWQgPT09IG1lbWJlcklkICYmIG92ZXJsYXAodGFyZ2V0LnN0YXJ0LCB0YXJnZXQuZW5kLCByYW5nZS5zdGFydCwgcmFuZ2UuZW5kKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHJvdy5vZmZfbWVtYmVyX2lkID09PSBtZW1iZXJJZCAmJiBvdmVybGFwKHRhcmdldC5zdGFydCwgdGFyZ2V0LmVuZCwgcmFuZ2Uuc3RhcnQsIHJhbmdlLmVuZCkpIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZpb2xhdGVzQXJlYU1pbmltdW1zKFxuICBjb250ZXh0OiBQbGFubmVyQ29udGV4dCxcbiAgYnJlYWtzOiBQbGFubmVyQnJlYWtbXSxcbiAgdGFyZ2V0QnJlYWs6IFBsYW5uZXJCcmVhayxcbiAgdGFyZ2V0OiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0sXG4gIGNvdmVyTWVtYmVySWQ6IG51bWJlciB8IG51bGxcbikge1xuICBjb25zdCBjb3VudHMgPSBjb3VudFdvcmtpbmdTaGlmdHNCeUFyZWFJblJhbmdlKGNvbnRleHQuc2hpZnRzLCB0YXJnZXQpO1xuICBjb25zdCBvdmVybGFwcGluZ0JyZWFrcyA9IGJyZWFrcy5maWx0ZXIoKHJvdykgPT4ge1xuICAgIGNvbnN0IHJhbmdlID0gYnJlYWtUYXJnZXRSYW5nZShyb3cpO1xuICAgIGlmICghcmFuZ2UpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gb3ZlcmxhcCh0YXJnZXQuc3RhcnQsIHRhcmdldC5lbmQsIHJhbmdlLnN0YXJ0LCByYW5nZS5lbmQpO1xuICB9KTtcblxuICBmb3IgKGNvbnN0IHJvdyBvZiBvdmVybGFwcGluZ0JyZWFrcykge1xuICAgIGNvbnN0IG5leHRDb3Zlck1lbWJlcklkID0gcm93LmlkID09PSB0YXJnZXRCcmVhay5pZCA/IGNvdmVyTWVtYmVySWQgOiByb3cuY292ZXJfbWVtYmVyX2lkO1xuICAgIGNvdW50cy5zZXQocm93Lm9mZl9hcmVhX2tleSwgKGNvdW50cy5nZXQocm93Lm9mZl9hcmVhX2tleSkgPz8gMCkgLSAxKTtcblxuICAgIGlmIChuZXh0Q292ZXJNZW1iZXJJZCA9PSBudWxsKSBjb250aW51ZTtcbiAgICBjb25zdCBjb3ZlclNoaWZ0ID0gYWN0aXZlV29ya2luZ1NoaWZ0Rm9yTWVtYmVyKGNvbnRleHQsIG5leHRDb3Zlck1lbWJlcklkLCB0YXJnZXQpO1xuICAgIGlmICghY292ZXJTaGlmdCkgY29udGludWU7XG4gICAgaWYgKGNvdmVyU2hpZnQuaG9tZV9hcmVhX2tleSAhPT0gcm93Lm9mZl9hcmVhX2tleSkge1xuICAgICAgY291bnRzLnNldChjb3ZlclNoaWZ0LmhvbWVfYXJlYV9rZXksIChjb3VudHMuZ2V0KGNvdmVyU2hpZnQuaG9tZV9hcmVhX2tleSkgPz8gMCkgLSAxKTtcbiAgICAgIGNvdW50cy5zZXQocm93Lm9mZl9hcmVhX2tleSwgKGNvdW50cy5nZXQocm93Lm9mZl9hcmVhX2tleSkgPz8gMCkgKyAxKTtcbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IFthcmVhS2V5LCBhY3RpdmVDb3VudF0gb2YgY291bnRzLmVudHJpZXMoKSkge1xuICAgIGlmIChhY3RpdmVDb3VudCA8PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCBtaW5TdGFmZiA9IGNvbnRleHQubWluQnlBcmVhLmdldChhcmVhS2V5KSA/PyAwO1xuICAgIGlmICgoY291bnRzLmdldChhcmVhS2V5KSA/PyAwKSA8IG1pblN0YWZmKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0FyZWFDb3ZlcmVkV2l0aG91dEFzc2lnbmVkQ292ZXIoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBicmVha3M6IFBsYW5uZXJCcmVha1tdLFxuICB0YXJnZXRCcmVhazogUGxhbm5lckJyZWFrXG4pIHtcbiAgY29uc3QgdGFyZ2V0ID0gYnJlYWtUYXJnZXRSYW5nZSh0YXJnZXRCcmVhayk7XG4gIGlmICghdGFyZ2V0KSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAhdmlvbGF0ZXNBcmVhTWluaW11bXMoY29udGV4dCwgYnJlYWtzLCB0YXJnZXRCcmVhaywgdGFyZ2V0LCBudWxsKTtcbn1cblxuZnVuY3Rpb24gY292ZXJPcHRpb25TY29yZShcbiAgY29udGV4dDogUGxhbm5lckNvbnRleHQsXG4gIHRhcmdldEJyZWFrOiBQbGFubmVyQnJlYWssXG4gIGNvdmVyU2hpZnQ6IFBsYW5uZXJTaGlmdFxuKSB7XG4gIGNvbnN0IHByZWZlcnJlZFJhbmtzID0gY29udGV4dC5wcmVmZXJyZWRSYW5rQnlTaGlmdElkLmdldCh0YXJnZXRCcmVhay5zaGlmdF9pZCkgPz8gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcbiAgY29uc3QgcHJlZmVycmVkUmFuayA9IHByZWZlcnJlZFJhbmtzLmdldChjb3ZlclNoaWZ0Lm1lbWJlcl9pZCk7XG4gIGxldCBzY29yZSA9IDA7XG5cbiAgaWYgKChjb3ZlclNoaWZ0LnNoaWZ0X3JvbGUgPz8gJ25vcm1hbCcpID09PSAnZmxvYXRlcicpIHtcbiAgICBzY29yZSAtPSAxMjA7XG4gIH1cblxuICBpZiAocHJlZmVycmVkUmFuayA9PSBudWxsKSB7XG4gICAgc2NvcmUgKz0gNDA7XG4gIH0gZWxzZSB7XG4gICAgc2NvcmUgKz0gcHJlZmVycmVkUmFuayAqIDQ7XG4gIH1cblxuICBpZiAoY292ZXJTaGlmdC5ob21lX2FyZWFfa2V5ICE9PSB0YXJnZXRCcmVhay5vZmZfYXJlYV9rZXkpIHNjb3JlICs9IDEyO1xuXG4gIHJldHVybiBzY29yZSArIGNvdmVyU2hpZnQubWVtYmVyX2lkIC8gMTAwMDA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RWxpZ2libGVDb3Zlck9wdGlvbnMoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBicmVha3M6IFBsYW5uZXJCcmVha1tdLFxuICB0YXJnZXRCcmVhazogUGxhbm5lckJyZWFrXG4pOiBDb3Zlck9wdGlvbltdIHtcbiAgY29uc3QgdGFyZ2V0ID0gYnJlYWtUYXJnZXRSYW5nZSh0YXJnZXRCcmVhayk7XG4gIGlmICghdGFyZ2V0KSByZXR1cm4gW3sgbWVtYmVySWQ6IG51bGwsIHNjb3JlOiAxMDAwIH1dO1xuXG4gIGNvbnN0IG9wdGlvbnM6IENvdmVyT3B0aW9uW10gPSBbXTtcblxuICBpZiAoaXNBcmVhQ292ZXJlZFdpdGhvdXRBc3NpZ25lZENvdmVyKGNvbnRleHQsIGJyZWFrcywgdGFyZ2V0QnJlYWspKSB7XG4gICAgb3B0aW9ucy5wdXNoKHsgbWVtYmVySWQ6IG51bGwsIHNjb3JlOiAtMjAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIGNvbnRleHQuc2hpZnRzKSB7XG4gICAgaWYgKHNoaWZ0LnN0YXR1c19rZXkgIT09ICd3b3JraW5nJykgY29udGludWU7XG4gICAgaWYgKHNoaWZ0Lm1lbWJlcl9pZCA9PT0gdGFyZ2V0QnJlYWsub2ZmX21lbWJlcl9pZCkgY29udGludWU7XG4gICAgaWYgKGFjdGl2ZVdvcmtpbmdTaGlmdEZvck1lbWJlcihjb250ZXh0LCBzaGlmdC5tZW1iZXJfaWQsIHRhcmdldCk/LmlkICE9PSBzaGlmdC5pZCkgY29udGludWU7XG4gICAgaWYgKHNoaWZ0LmhvbWVfYXJlYV9rZXkgIT09IHRhcmdldEJyZWFrLm9mZl9hcmVhX2tleSAmJiAhY2FuTWVtYmVyV29ya0FyZWEoY29udGV4dCwgc2hpZnQubWVtYmVyX2lkLCB0YXJnZXRCcmVhay5vZmZfYXJlYV9rZXkpKSBjb250aW51ZTtcbiAgICBpZiAoaGFzQ292ZXJDb25mbGljdChicmVha3MsIHNoaWZ0Lm1lbWJlcl9pZCwgdGFyZ2V0LCB0YXJnZXRCcmVhay5pZCkpIGNvbnRpbnVlO1xuICAgIGlmICh2aW9sYXRlc0FyZWFNaW5pbXVtcyhjb250ZXh0LCBicmVha3MsIHRhcmdldEJyZWFrLCB0YXJnZXQsIHNoaWZ0Lm1lbWJlcl9pZCkpIGNvbnRpbnVlO1xuXG4gICAgb3B0aW9ucy5wdXNoKHtcbiAgICAgIG1lbWJlcklkOiBzaGlmdC5tZW1iZXJfaWQsXG4gICAgICBzY29yZTogY292ZXJPcHRpb25TY29yZShjb250ZXh0LCB0YXJnZXRCcmVhaywgc2hpZnQpXG4gICAgfSk7XG4gIH1cblxuICBvcHRpb25zLnNvcnQoKGEsIGIpID0+IGEuc2NvcmUgLSBiLnNjb3JlKTtcbiAgaWYgKCFvcHRpb25zLnNvbWUoKHJvdykgPT4gcm93Lm1lbWJlcklkID09IG51bGwpKSB7XG4gICAgb3B0aW9ucy5wdXNoKHsgbWVtYmVySWQ6IG51bGwsIHNjb3JlOiAxMDAwIH0pO1xuICB9XG4gIHJldHVybiBvcHRpb25zO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNDb3ZlckFzc2lnbm1lbnRWYWxpZChcbiAgY29udGV4dDogUGxhbm5lckNvbnRleHQsXG4gIGJyZWFrczogUGxhbm5lckJyZWFrW10sXG4gIHRhcmdldEJyZWFrOiBQbGFubmVyQnJlYWssXG4gIGNvdmVyTWVtYmVySWQ6IG51bWJlciB8IG51bGxcbikge1xuICBjb25zdCB0YXJnZXQgPSBicmVha1RhcmdldFJhbmdlKHRhcmdldEJyZWFrKTtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNvdmVyTWVtYmVySWQgPT0gbnVsbCkge1xuICAgIHJldHVybiBpc0FyZWFDb3ZlcmVkV2l0aG91dEFzc2lnbmVkQ292ZXIoY29udGV4dCwgYnJlYWtzLCB0YXJnZXRCcmVhayk7XG4gIH1cbiAgY29uc3QgY292ZXJTaGlmdCA9IGFjdGl2ZVdvcmtpbmdTaGlmdEZvck1lbWJlcihjb250ZXh0LCBjb3Zlck1lbWJlcklkLCB0YXJnZXQpO1xuICBpZiAoIWNvdmVyU2hpZnQpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNvdmVyU2hpZnQuaG9tZV9hcmVhX2tleSAhPT0gdGFyZ2V0QnJlYWsub2ZmX2FyZWFfa2V5ICYmICFjYW5NZW1iZXJXb3JrQXJlYShjb250ZXh0LCBjb3Zlck1lbWJlcklkLCB0YXJnZXRCcmVhay5vZmZfYXJlYV9rZXkpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChoYXNDb3ZlckNvbmZsaWN0KGJyZWFrcywgY292ZXJNZW1iZXJJZCwgdGFyZ2V0LCB0YXJnZXRCcmVhay5pZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHZpb2xhdGVzQXJlYU1pbmltdW1zKGNvbnRleHQsIGJyZWFrcywgdGFyZ2V0QnJlYWssIHRhcmdldCwgY292ZXJNZW1iZXJJZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhc3NpZ25CZXN0Q292ZXJzKFxuICBjb250ZXh0OiBQbGFubmVyQ29udGV4dCxcbiAgbG9ja2VkQnJlYWtzOiBQbGFubmVyQnJlYWtbXSxcbiAgcGVuZGluZ0JyZWFrczogUGxhbm5lckJyZWFrW11cbik6IE1hcDxudW1iZXIsIG51bWJlciB8IG51bGw+IHtcbiAgY29uc3QgYXNzaWdubWVudHMgPSBuZXcgTWFwPG51bWJlciwgbnVtYmVyIHwgbnVsbD4oKTtcbiAgaWYgKHBlbmRpbmdCcmVha3MubGVuZ3RoID09PSAwKSByZXR1cm4gYXNzaWdubWVudHM7XG5cbiAgY29uc3QgcGVuZGluZ0J5SWQgPSBuZXcgTWFwKHBlbmRpbmdCcmVha3MubWFwKChyb3cpID0+IFtyb3cuaWQsIHJvd10pKTtcbiAgbGV0IGJlc3RTY29yZSA9IE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcbiAgbGV0IGJlc3RBc3NpZ25tZW50cyA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXIgfCBudWxsPigpO1xuXG4gIGNvbnN0IHNlYXJjaCA9IChjdXJyZW50QnJlYWtzOiBQbGFubmVyQnJlYWtbXSwgcmVtYWluaW5nSWRzOiBudW1iZXJbXSwgcnVubmluZ1Njb3JlOiBudW1iZXIpID0+IHtcbiAgICBpZiAocnVubmluZ1Njb3JlID49IGJlc3RTY29yZSkgcmV0dXJuO1xuICAgIGlmIChyZW1haW5pbmdJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBiZXN0U2NvcmUgPSBydW5uaW5nU2NvcmU7XG4gICAgICBiZXN0QXNzaWdubWVudHMgPSBuZXcgTWFwKGFzc2lnbm1lbnRzKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsZXQgbmV4dElkID0gcmVtYWluaW5nSWRzWzBdITtcbiAgICBsZXQgbmV4dE9wdGlvbnM6IENvdmVyT3B0aW9uW10gfCBudWxsID0gbnVsbDtcblxuICAgIGZvciAoY29uc3QgYnJlYWtJZCBvZiByZW1haW5pbmdJZHMpIHtcbiAgICAgIGNvbnN0IHJvdyA9IHBlbmRpbmdCeUlkLmdldChicmVha0lkKTtcbiAgICAgIGlmICghcm93KSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG9wdGlvbnMgPSBsaXN0RWxpZ2libGVDb3Zlck9wdGlvbnMoY29udGV4dCwgY3VycmVudEJyZWFrcywgcm93KTtcbiAgICAgIGlmICghbmV4dE9wdGlvbnMgfHwgb3B0aW9ucy5sZW5ndGggPCBuZXh0T3B0aW9ucy5sZW5ndGgpIHtcbiAgICAgICAgbmV4dElkID0gYnJlYWtJZDtcbiAgICAgICAgbmV4dE9wdGlvbnMgPSBvcHRpb25zO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHJvdyA9IHBlbmRpbmdCeUlkLmdldChuZXh0SWQpO1xuICAgIGlmICghcm93IHx8ICFuZXh0T3B0aW9ucykgcmV0dXJuO1xuXG4gICAgY29uc3QgcmVtYWluaW5nQWZ0ZXIgPSByZW1haW5pbmdJZHMuZmlsdGVyKChpZCkgPT4gaWQgIT09IG5leHRJZCk7XG4gICAgZm9yIChjb25zdCBvcHRpb24gb2YgbmV4dE9wdGlvbnMpIHtcbiAgICAgIGFzc2lnbm1lbnRzLnNldChuZXh0SWQsIG9wdGlvbi5tZW1iZXJJZCk7XG4gICAgICBjb25zdCBuZXh0QnJlYWtzID0gY3VycmVudEJyZWFrcy5tYXAoKGl0ZW0pID0+XG4gICAgICAgIGl0ZW0uaWQgPT09IG5leHRJZCA/IHsgLi4uaXRlbSwgY292ZXJfbWVtYmVyX2lkOiBvcHRpb24ubWVtYmVySWQgfSA6IGl0ZW1cbiAgICAgICk7XG4gICAgICBzZWFyY2gobmV4dEJyZWFrcywgcmVtYWluaW5nQWZ0ZXIsIHJ1bm5pbmdTY29yZSArIG9wdGlvbi5zY29yZSk7XG4gICAgfVxuICAgIGFzc2lnbm1lbnRzLmRlbGV0ZShuZXh0SWQpO1xuICB9O1xuXG4gIHNlYXJjaChbLi4ubG9ja2VkQnJlYWtzLCAuLi5wZW5kaW5nQnJlYWtzXSwgcGVuZGluZ0JyZWFrcy5tYXAoKHJvdykgPT4gcm93LmlkKSwgMCk7XG4gIHJldHVybiBiZXN0QXNzaWdubWVudHM7XG59XG4iLCAiZXhwb3J0IGZ1bmN0aW9uIGlzSVNPRGF0ZSh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdCh2YWx1ZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTdHJpbmcoZm9ybTogRm9ybURhdGEsIGtleTogc3RyaW5nLCBmYWxsYmFjayA9ICcnKTogc3RyaW5nIHtcbiAgcmV0dXJuIChmb3JtLmdldChrZXkpID8/IGZhbGxiYWNrKS50b1N0cmluZygpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VHJpbW1lZFN0cmluZyhmb3JtOiBGb3JtRGF0YSwga2V5OiBzdHJpbmcsIGZhbGxiYWNrID0gJycpOiBzdHJpbmcge1xuICByZXR1cm4gZ2V0U3RyaW5nKGZvcm0sIGtleSwgZmFsbGJhY2spLnRyaW0oKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFBvc2l0aXZlSW50KGZvcm06IEZvcm1EYXRhLCBrZXk6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCB2YWx1ZSA9IE51bWJlcihmb3JtLmdldChrZXkpKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgJiYgdmFsdWUgPiAwID8gdmFsdWUgOiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0T3B0aW9uYWxQb3NpdGl2ZUludChmb3JtOiBGb3JtRGF0YSwga2V5OiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gZ2V0VHJpbW1lZFN0cmluZyhmb3JtLCBrZXkpO1xuICBpZiAocmF3ID09PSAnJykgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHZhbHVlID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpICYmIHZhbHVlID4gMCA/IHZhbHVlIDogdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmV0dXJuVG8oZm9ybTogRm9ybURhdGEsIGZhbGxiYWNrOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB2YWx1ZSA9IGdldFRyaW1tZWRTdHJpbmcoZm9ybSwgJ3JldHVyblRvJywgZmFsbGJhY2spO1xuICByZXR1cm4gdmFsdWUgfHwgZmFsbGJhY2s7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRVbmlxdWVQb3NpdGl2ZUludHMoZm9ybTogRm9ybURhdGEsIGtleTogc3RyaW5nLCBsaW1pdD86IG51bWJlcik6IG51bWJlcltdIHtcbiAgY29uc3QgdmFsdWVzID0gZm9ybS5nZXRBbGwoa2V5KVxuICAgIC5tYXAoKHZhbHVlKSA9PiBOdW1iZXIodmFsdWUpKVxuICAgIC5maWx0ZXIoKHZhbHVlKSA9PiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpICYmIHZhbHVlID4gMCk7XG4gIGNvbnN0IHVuaXF1ZSA9IFsuLi5uZXcgU2V0KHZhbHVlcyldO1xuICByZXR1cm4gdHlwZW9mIGxpbWl0ID09PSAnbnVtYmVyJyA/IHVuaXF1ZS5zbGljZSgwLCBsaW1pdCkgOiB1bmlxdWU7XG59XG4iLCAiaW1wb3J0IHsgYnVpbGRQbGFubmVyQ29udGV4dCwgdHlwZSBQbGFubmVyQnJlYWssIHR5cGUgUGxhbm5lckNvbnRleHQsIHR5cGUgUGxhbm5lclNoaWZ0IH0gZnJvbSAnLi9icmVhay1wbGFubmVyJztcblxuZXhwb3J0IHR5cGUgUGxhbm5lck1lbWJlclJvdyA9IHsgaWQ6IG51bWJlcjsgYWxsX2FyZWFzOiBudW1iZXIgfTtcbmV4cG9ydCB0eXBlIFBsYW5uZXJQZXJtUm93ID0geyBtZW1iZXJfaWQ6IG51bWJlcjsgYXJlYV9rZXk6IHN0cmluZyB9O1xuZXhwb3J0IHR5cGUgUGxhbm5lckFyZWFSb3cgPSB7IGtleTogc3RyaW5nOyBtaW5fc3RhZmY6IG51bWJlciB8IG51bGwgfTtcbmV4cG9ydCB0eXBlIFBsYW5uZXJQcmVmZXJyZWRDb3ZlcmVyUm93ID0geyBzaGlmdF9pZDogbnVtYmVyOyBtZW1iZXJfaWQ6IG51bWJlcjsgcHJpb3JpdHk6IG51bWJlciB9O1xuXG5leHBvcnQgdHlwZSBQbGFubmVyU2NoZWR1bGVEYXRhID0ge1xuICBzaGlmdHM6IFBsYW5uZXJTaGlmdFtdO1xuICBicmVha3M6IFBsYW5uZXJCcmVha1tdO1xuICBtZW1iZXJzOiBQbGFubmVyTWVtYmVyUm93W107XG4gIHBlcm1zOiBQbGFubmVyUGVybVJvd1tdO1xuICBwcmVmZXJyZWRSYW5rQnlTaGlmdElkOiBNYXA8bnVtYmVyLCBNYXA8bnVtYmVyLCBudW1iZXI+PjtcbiAgbWluQnlBcmVhOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xuICBwbGFubmVyOiBQbGFubmVyQ29udGV4dDtcbn07XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkUHJlZmVycmVkUmFua0J5U2hpZnRJZChcbiAgREI6IEQxRGF0YWJhc2UsXG4gIG9wdHM/OiB7IHNjaGVkdWxlSWQ/OiBudW1iZXI7IHdvcmtCbG9ja0lkPzogbnVtYmVyOyBzaGlmdElkPzogbnVtYmVyIH1cbik6IFByb21pc2U8TWFwPG51bWJlciwgTWFwPG51bWJlciwgbnVtYmVyPj4+IHtcbiAgbGV0IHNxbCA9ICdTRUxFQ1Qgc2hpZnRfaWQsIG1lbWJlcl9pZCwgcHJpb3JpdHkgRlJPTSBzaGlmdF9jb3Zlcl9wcmlvcml0aWVzJztcbiAgY29uc3QgYmluZHM6IEFycmF5PG51bWJlcj4gPSBbXTtcblxuICBpZiAob3B0cz8uc2hpZnRJZCAhPSBudWxsKSB7XG4gICAgc3FsICs9ICcgV0hFUkUgc2hpZnRfaWQ9Pyc7XG4gICAgYmluZHMucHVzaChvcHRzLnNoaWZ0SWQpO1xuICB9IGVsc2UgaWYgKG9wdHM/LndvcmtCbG9ja0lkICE9IG51bGwpIHtcbiAgICBzcWwgKz0gJyBXSEVSRSBzaGlmdF9pZCBJTiAoU0VMRUNUIGlkIEZST00gc2hpZnRzIFdIRVJFIHdvcmtfYmxvY2tfaWQ9PyknO1xuICAgIGJpbmRzLnB1c2gob3B0cy53b3JrQmxvY2tJZCk7XG4gIH0gZWxzZSBpZiAob3B0cz8uc2NoZWR1bGVJZCAhPSBudWxsKSB7XG4gICAgc3FsICs9ICcgV0hFUkUgc2hpZnRfaWQgSU4gKFNFTEVDVCBpZCBGUk9NIHNoaWZ0cyBXSEVSRSBzY2hlZHVsZV9pZD0/KSc7XG4gICAgYmluZHMucHVzaChvcHRzLnNjaGVkdWxlSWQpO1xuICB9XG5cbiAgc3FsICs9ICcgT1JERVIgQlkgc2hpZnRfaWQgQVNDLCBwcmlvcml0eSBBU0MnO1xuICBjb25zdCByb3dzID0gKGF3YWl0IERCLnByZXBhcmUoc3FsKS5iaW5kKC4uLmJpbmRzKS5hbGwoKSkucmVzdWx0cyBhcyBQbGFubmVyUHJlZmVycmVkQ292ZXJlclJvd1tdO1xuICBjb25zdCBwcmVmZXJyZWRSYW5rQnlTaGlmdElkID0gbmV3IE1hcDxudW1iZXIsIE1hcDxudW1iZXIsIG51bWJlcj4+KCk7XG4gIGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIHtcbiAgICBjb25zdCByYW5rcyA9IHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQuZ2V0KHJvdy5zaGlmdF9pZCkgPz8gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcbiAgICByYW5rcy5zZXQocm93Lm1lbWJlcl9pZCwgcmFua3Muc2l6ZSk7XG4gICAgcHJlZmVycmVkUmFua0J5U2hpZnRJZC5zZXQocm93LnNoaWZ0X2lkLCByYW5rcyk7XG4gIH1cbiAgcmV0dXJuIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkUGxhbm5lclNjaGVkdWxlRGF0YShcbiAgREI6IEQxRGF0YWJhc2UsXG4gIHNjaGVkdWxlSWQ6IG51bWJlcixcbiAgb3B0cz86IHsgcHJlZmVycmVkQ292ZXJlcnNGb3I/OiB7IHNjaGVkdWxlSWQ/OiBudW1iZXI7IHdvcmtCbG9ja0lkPzogbnVtYmVyOyBzaGlmdElkPzogbnVtYmVyIH0gfVxuKTogUHJvbWlzZTxQbGFubmVyU2NoZWR1bGVEYXRhPiB7XG4gIGNvbnN0IHNoaWZ0cyA9IChhd2FpdCBEQi5wcmVwYXJlKFxuICAgICdTRUxFQ1QgaWQsIHdvcmtfYmxvY2tfaWQsIG1lbWJlcl9pZCwgaG9tZV9hcmVhX2tleSwgc3RhdHVzX2tleSwgc2hpZnRfcm9sZSwgc3RhcnRfdGltZSwgZW5kX3RpbWUgRlJPTSBzaGlmdHMgV0hFUkUgc2NoZWR1bGVfaWQ9PydcbiAgKS5iaW5kKHNjaGVkdWxlSWQpLmFsbCgpKS5yZXN1bHRzIGFzIFBsYW5uZXJTaGlmdFtdO1xuXG4gIGNvbnN0IFttZW1iZXJzLCBwZXJtcywgYXJlYXMsIGJyZWFrcywgcHJlZmVycmVkUmFua0J5U2hpZnRJZF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgREIucHJlcGFyZSgnU0VMRUNUIGlkLCBhbGxfYXJlYXMgRlJPTSBtZW1iZXJzJykuYWxsKCkudGhlbigocmVzdWx0KSA9PiByZXN1bHQucmVzdWx0cyBhcyBQbGFubmVyTWVtYmVyUm93W10pLFxuICAgIERCLnByZXBhcmUoJ1NFTEVDVCBtZW1iZXJfaWQsIGFyZWFfa2V5IEZST00gbWVtYmVyX2FyZWFfcGVybWlzc2lvbnMnKS5hbGwoKS50aGVuKChyZXN1bHQpID0+IHJlc3VsdC5yZXN1bHRzIGFzIFBsYW5uZXJQZXJtUm93W10pLFxuICAgIERCLnByZXBhcmUoJ1NFTEVDVCBrZXksIG1pbl9zdGFmZiBGUk9NIGFyZWFzJykuYWxsKCkudGhlbigocmVzdWx0KSA9PiByZXN1bHQucmVzdWx0cyBhcyBQbGFubmVyQXJlYVJvd1tdKSxcbiAgICBEQi5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCBiLmlkLCBiLndvcmtfYmxvY2tfaWQsIGIuc2hpZnRfaWQsIGIuc3RhcnRfdGltZSwgYi5kdXJhdGlvbl9taW51dGVzLCBiLmNvdmVyX21lbWJlcl9pZCxcbiAgICAgICAgICAgICAgcy5tZW1iZXJfaWQgQVMgb2ZmX21lbWJlcl9pZCwgcy5ob21lX2FyZWFfa2V5IEFTIG9mZl9hcmVhX2tleVxuICAgICAgIEZST00gYnJlYWtzIGJcbiAgICAgICBKT0lOIHNoaWZ0cyBzIE9OIHMuaWQgPSBiLnNoaWZ0X2lkXG4gICAgICAgV0hFUkUgcy5zY2hlZHVsZV9pZD0/YFxuICAgICkuYmluZChzY2hlZHVsZUlkKS5hbGwoKS50aGVuKChyZXN1bHQpID0+IHJlc3VsdC5yZXN1bHRzIGFzIFBsYW5uZXJCcmVha1tdKSxcbiAgICBsb2FkUHJlZmVycmVkUmFua0J5U2hpZnRJZChEQiwgb3B0cz8ucHJlZmVycmVkQ292ZXJlcnNGb3I/LnNoaWZ0SWQgIT0gbnVsbFxuICAgICAgPyB7IHNoaWZ0SWQ6IG9wdHMucHJlZmVycmVkQ292ZXJlcnNGb3Iuc2hpZnRJZCB9XG4gICAgICA6IG9wdHM/LnByZWZlcnJlZENvdmVyZXJzRm9yPy53b3JrQmxvY2tJZCAhPSBudWxsXG4gICAgICAgID8geyB3b3JrQmxvY2tJZDogb3B0cy5wcmVmZXJyZWRDb3ZlcmVyc0Zvci53b3JrQmxvY2tJZCB9XG4gICAgICAgIDogeyBzY2hlZHVsZUlkOiBvcHRzPy5wcmVmZXJyZWRDb3ZlcmVyc0Zvcj8uc2NoZWR1bGVJZCA/PyBzY2hlZHVsZUlkIH0pXG4gIF0pO1xuXG4gIGNvbnN0IG1pbkJ5QXJlYSA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KGFyZWFzLm1hcCgoYXJlYSkgPT4gW2FyZWEua2V5LCBOdW1iZXIoYXJlYS5taW5fc3RhZmYgPz8gMCldKSk7XG4gIGNvbnN0IHBsYW5uZXIgPSBidWlsZFBsYW5uZXJDb250ZXh0KHtcbiAgICBzaGlmdHMsXG4gICAgbWVtYmVycyxcbiAgICBwZXJtcyxcbiAgICBtaW5CeUFyZWEsXG4gICAgcHJlZmVycmVkUmFua0J5U2hpZnRJZFxuICB9KTtcblxuICByZXR1cm4ge1xuICAgIHNoaWZ0cyxcbiAgICBicmVha3MsXG4gICAgbWVtYmVycyxcbiAgICBwZXJtcyxcbiAgICBwcmVmZXJyZWRSYW5rQnlTaGlmdElkLFxuICAgIG1pbkJ5QXJlYSxcbiAgICBwbGFubmVyXG4gIH07XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBBUElSb3V0ZSB9IGZyb20gJ2FzdHJvJztcbmltcG9ydCB7IHJlcXVpcmVSb2xlIH0gZnJvbSAnLi4vLi4vLi4vbGliL2F1dGgnO1xuaW1wb3J0IHsgZ2V0REIgfSBmcm9tICcuLi8uLi8uLi9saWIvZGInO1xuaW1wb3J0IHsgcmVkaXJlY3RXaXRoTWVzc2FnZSB9IGZyb20gJy4uLy4uLy4uL2xpYi9yZWRpcmVjdCc7XG5pbXBvcnQgeyBpc0NvdmVyQXNzaWdubWVudFZhbGlkLCBsaXN0RWxpZ2libGVDb3Zlck9wdGlvbnMgfSBmcm9tICcuLi8uLi8uLi9saWIvYnJlYWstcGxhbm5lcic7XG5pbXBvcnQgeyBnZXRPcHRpb25hbFBvc2l0aXZlSW50LCBnZXRQb3NpdGl2ZUludCwgZ2V0UmV0dXJuVG8sIGdldFN0cmluZywgaXNJU09EYXRlIH0gZnJvbSAnLi4vLi4vLi4vbGliL2h0dHAnO1xuaW1wb3J0IHsgbG9hZFBsYW5uZXJTY2hlZHVsZURhdGEgfSBmcm9tICcuLi8uLi8uLi9saWIvcGxhbm5lci1kYXRhJztcblxuZXhwb3J0IGNvbnN0IFBPU1Q6IEFQSVJvdXRlID0gYXN5bmMgKHsgcmVxdWVzdCB9KSA9PiB7XG4gIGNvbnN0IGd1YXJkID0gcmVxdWlyZVJvbGUocmVxdWVzdCwgJ2FkbWluJyk7XG4gIGlmICghZ3VhcmQub2spIHJldHVybiBndWFyZC5yZWRpcmVjdDtcblxuICBjb25zdCBmb3JtID0gYXdhaXQgcmVxdWVzdC5mb3JtRGF0YSgpO1xuICBjb25zdCBkYXRlID0gZ2V0U3RyaW5nKGZvcm0sICdkYXRlJyk7XG4gIGNvbnN0IGJyZWFrSWQgPSBnZXRQb3NpdGl2ZUludChmb3JtLCAnYnJlYWtJZCcpO1xuICBjb25zdCBjb3Zlck1lbWJlcklkID0gZ2V0T3B0aW9uYWxQb3NpdGl2ZUludChmb3JtLCAnY292ZXJNZW1iZXJJZCcpO1xuICBjb25zdCByZXR1cm5UbyA9IGdldFJldHVyblRvKGZvcm0sIGAvYWRtaW4vc2NoZWR1bGUvJHtkYXRlfT9wYW5lbD1icmVha3MjYnJlYWtzYCk7XG5cbiAgaWYgKCFpc0lTT0RhdGUoZGF0ZSkpIHJldHVybiByZWRpcmVjdFdpdGhNZXNzYWdlKHJldHVyblRvLCB7IGVycm9yOiAnSW52YWxpZCBkYXRlJyB9KTtcbiAgaWYgKGJyZWFrSWQgPT0gbnVsbCkgcmV0dXJuIHJlZGlyZWN0V2l0aE1lc3NhZ2UocmV0dXJuVG8sIHsgZXJyb3I6ICdJbnZhbGlkIGJyZWFrJyB9KTtcbiAgaWYgKGNvdmVyTWVtYmVySWQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiByZWRpcmVjdFdpdGhNZXNzYWdlKHJldHVyblRvLCB7IGVycm9yOiAnSW52YWxpZCBjb3ZlciBzZWxlY3Rpb24nIH0pO1xuICB9XG5cbiAgY29uc3QgREIgPSBhd2FpdCBnZXREQigpO1xuXG4gIGNvbnN0IHRhcmdldCA9IChhd2FpdCBEQi5wcmVwYXJlKFxuICAgIGBTRUxFQ1QgYi5pZCBhcyBicmVha19pZCwgYi5zdGFydF90aW1lLCBiLmR1cmF0aW9uX21pbnV0ZXMsXG4gICAgICAgICAgICBzLmlkIEFTIG9mZl9zaGlmdF9pZCwgcy5zY2hlZHVsZV9pZCwgcy5ob21lX2FyZWFfa2V5LCBzLm1lbWJlcl9pZCBBUyBvZmZfbWVtYmVyX2lkXG4gICAgIEZST00gYnJlYWtzIGJcbiAgICAgSk9JTiBzaGlmdHMgcyBPTiBzLmlkID0gYi5zaGlmdF9pZFxuICAgICBXSEVSRSBiLmlkPT9gXG4gIClcbiAgICAuYmluZChicmVha0lkKVxuICAgIC5maXJzdCgpKSBhcyBhbnk7XG5cbiAgaWYgKCF0YXJnZXQpIHJldHVybiByZWRpcmVjdFdpdGhNZXNzYWdlKHJldHVyblRvLCB7IGVycm9yOiAnQnJlYWsgbm90IGZvdW5kJyB9KTtcblxuICBpZiAoY292ZXJNZW1iZXJJZCAhPT0gbnVsbCkge1xuICAgIGNvbnN0IHsgcGxhbm5lciwgYnJlYWtzIH0gPSBhd2FpdCBsb2FkUGxhbm5lclNjaGVkdWxlRGF0YShEQiwgdGFyZ2V0LnNjaGVkdWxlX2lkLCB7XG4gICAgICBwcmVmZXJyZWRDb3ZlcmVyc0ZvcjogeyBzaGlmdElkOiB0YXJnZXQub2ZmX3NoaWZ0X2lkIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IGN1cnJlbnRCcmVhayA9IGJyZWFrcy5maW5kKChyb3cpID0+IHJvdy5pZCA9PT0gYnJlYWtJZCk7XG4gICAgaWYgKCFjdXJyZW50QnJlYWspIHJldHVybiByZWRpcmVjdFdpdGhNZXNzYWdlKHJldHVyblRvLCB7IGVycm9yOiAnQnJlYWsgbm90IGZvdW5kJyB9KTtcblxuICAgIGNvbnN0IHZhbGlkQ2FuZGlkYXRlSWRzID0gbmV3IFNldChcbiAgICAgIGxpc3RFbGlnaWJsZUNvdmVyT3B0aW9ucyhwbGFubmVyLCBicmVha3MsIGN1cnJlbnRCcmVhaylcbiAgICAgICAgLm1hcCgocm93KSA9PiByb3cubWVtYmVySWQpXG4gICAgICAgIC5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgbnVtYmVyID0+IHZhbHVlICE9IG51bGwpXG4gICAgKTtcblxuICAgIGlmICghdmFsaWRDYW5kaWRhdGVJZHMuaGFzKGNvdmVyTWVtYmVySWQpIHx8ICFpc0NvdmVyQXNzaWdubWVudFZhbGlkKHBsYW5uZXIsIGJyZWFrcywgY3VycmVudEJyZWFrLCBjb3Zlck1lbWJlcklkKSkge1xuICAgICAgcmV0dXJuIHJlZGlyZWN0V2l0aE1lc3NhZ2UocmV0dXJuVG8sIHsgZXJyb3I6ICdTZWxlY3RlZCBjb3ZlciBtZW1iZXIgaXMgbm90IGF2YWlsYWJsZSBmb3IgdGhhdCBicmVhaycgfSk7XG4gICAgfVxuICB9XG5cbiAgYXdhaXQgREIucHJlcGFyZSgnVVBEQVRFIGJyZWFrcyBTRVQgY292ZXJfbWVtYmVyX2lkPT8gV0hFUkUgaWQ9PycpXG4gICAgLmJpbmQoY292ZXJNZW1iZXJJZCwgYnJlYWtJZClcbiAgICAucnVuKCk7XG5cbiAgcmV0dXJuIHJlZGlyZWN0V2l0aE1lc3NhZ2UocmV0dXJuVG8sIHsgbm90aWNlOiAnQ292ZXIgdXBkYXRlZCcgfSk7XG59O1xuIiwgImV4cG9ydCBhc3luYyBmdW5jdGlvbiBtZW1iZXJDYW5Xb3JrQXJlYShEQjogRDFEYXRhYmFzZSwgbWVtYmVySWQ6IG51bWJlciwgYXJlYUtleTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IG1lbWJlciA9IChhd2FpdCBEQi5wcmVwYXJlKCdTRUxFQ1QgYWxsX2FyZWFzIEZST00gbWVtYmVycyBXSEVSRSBpZD0/JykuYmluZChtZW1iZXJJZCkuZmlyc3QoKSkgYXMgeyBhbGxfYXJlYXM6IG51bWJlciB9IHwgbnVsbDtcbiAgaWYgKCFtZW1iZXIpIHJldHVybiBmYWxzZTtcbiAgaWYgKG1lbWJlci5hbGxfYXJlYXMgPT09IDEpIHJldHVybiB0cnVlO1xuXG4gIGNvbnN0IHBlcm1pdHRlZCA9IGF3YWl0IERCLnByZXBhcmUoXG4gICAgJ1NFTEVDVCAxIEZST00gbWVtYmVyX2FyZWFfcGVybWlzc2lvbnMgV0hFUkUgbWVtYmVyX2lkPT8gQU5EIGFyZWFfa2V5PT8nXG4gIClcbiAgICAuYmluZChtZW1iZXJJZCwgYXJlYUtleSlcbiAgICAuZmlyc3QoKTtcbiAgcmV0dXJuIEJvb2xlYW4ocGVybWl0dGVkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFzc2VydE1lbWJlckNhbldvcmtBcmVhKFxuICBEQjogRDFEYXRhYmFzZSxcbiAgbWVtYmVySWQ6IG51bWJlcixcbiAgYXJlYUtleTogc3RyaW5nXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgY2FuV29yayA9IGF3YWl0IG1lbWJlckNhbldvcmtBcmVhKERCLCBtZW1iZXJJZCwgYXJlYUtleSk7XG4gIHJldHVybiBjYW5Xb3JrID8gbnVsbCA6ICdNZW1iZXIgaXMgbm90IHBlcm1pdHRlZCB0byB3b3JrIGluIHRoYXQgYXJlYSc7XG59XG4iLCAiaW1wb3J0IHsgcGFyc2VISE1NIH0gZnJvbSAnLi90aW1lJztcblxuZnVuY3Rpb24gd29ya0Jsb2NrVGVzdEhvb2tzKCkge1xuICByZXR1cm4gKGdsb2JhbFRoaXMgYXMgYW55KS5fX2J1bnJ1bldvcmtCbG9ja1Rlc3RIb29rcyBhcyB7XG4gICAgcmVjb21wdXRlV29ya0Jsb2Nrc0ZvclNjaGVkdWxlPzogKERCOiBEMURhdGFiYXNlLCBzY2hlZHVsZUlkOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD4gfCB2b2lkO1xuICAgIGNsZWFyTWVtYmVyQnJlYWtQbGFuRm9yU2NoZWR1bGU/OiAoREI6IEQxRGF0YWJhc2UsIHNjaGVkdWxlSWQ6IG51bWJlciwgbWVtYmVySWQ6IG51bWJlcikgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQ7XG4gIH0gfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCB0eXBlIFdvcmtCbG9jayA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgc2NoZWR1bGVfaWQ6IG51bWJlcjtcbiAgbWVtYmVyX2lkOiBudW1iZXI7XG4gIHN0YXJ0X3RpbWU6IHN0cmluZztcbiAgZW5kX3RpbWU6IHN0cmluZztcbiAgdG90YWxfbWludXRlczogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgV29ya0Jsb2NrU2hpZnQgPSB7XG4gIGlkOiBudW1iZXI7XG4gIHNjaGVkdWxlX2lkOiBudW1iZXI7XG4gIG1lbWJlcl9pZDogbnVtYmVyO1xuICBzdGF0dXNfa2V5OiBzdHJpbmc7XG4gIGhvbWVfYXJlYV9rZXk6IHN0cmluZztcbiAgc3RhcnRfdGltZTogc3RyaW5nO1xuICBlbmRfdGltZTogc3RyaW5nIHwgbnVsbDtcbiAgc2hpZnRfbWludXRlczogbnVtYmVyO1xuICB3b3JrX2Jsb2NrX2lkPzogbnVtYmVyIHwgbnVsbDtcbn07XG5cbnR5cGUgUGVuZGluZ1dvcmtCbG9jayA9IHtcbiAgbWVtYmVyX2lkOiBudW1iZXI7XG4gIHN0YXJ0X3RpbWU6IHN0cmluZztcbiAgZW5kX3RpbWU6IHN0cmluZztcbiAgdG90YWxfbWludXRlczogbnVtYmVyO1xuICBzaGlmdElkczogbnVtYmVyW107XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gc2hpZnRDb250YWluc1RpbWUoc2hpZnQ6IFBpY2s8V29ya0Jsb2NrU2hpZnQsICdzdGFydF90aW1lJyB8ICdlbmRfdGltZSc+LCB0aW1lSEhNTTogc3RyaW5nKSB7XG4gIGNvbnN0IHN0YXJ0ID0gcGFyc2VISE1NKHNoaWZ0LnN0YXJ0X3RpbWUpO1xuICBjb25zdCBlbmQgPSBzaGlmdC5lbmRfdGltZSA/IHBhcnNlSEhNTShzaGlmdC5lbmRfdGltZSkgOiBudWxsO1xuICBjb25zdCB0aW1lID0gcGFyc2VISE1NKHRpbWVISE1NKTtcbiAgaWYgKHN0YXJ0ID09IG51bGwgfHwgZW5kID09IG51bGwgfHwgdGltZSA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBzdGFydCA8PSB0aW1lICYmIHRpbWUgPCBlbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhY3RpdmVTaGlmdEF0VGltZShzaGlmdHM6IFdvcmtCbG9ja1NoaWZ0W10sIG1lbWJlcklkOiBudW1iZXIsIHRpbWVISE1NOiBzdHJpbmcpIHtcbiAgcmV0dXJuIHNoaWZ0cy5maW5kKChzaGlmdCkgPT4gc2hpZnQubWVtYmVyX2lkID09PSBtZW1iZXJJZCAmJiBzaGlmdC5zdGF0dXNfa2V5ID09PSAnd29ya2luZycgJiYgc2hpZnRDb250YWluc1RpbWUoc2hpZnQsIHRpbWVISE1NKSkgPz8gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkUGVuZGluZ1dvcmtCbG9ja3Moc2hpZnRzOiBXb3JrQmxvY2tTaGlmdFtdKTogUGVuZGluZ1dvcmtCbG9ja1tdIHtcbiAgY29uc3Qgd29ya2luZyA9IHNoaWZ0c1xuICAgIC5maWx0ZXIoKHNoaWZ0KSA9PiBzaGlmdC5zdGF0dXNfa2V5ID09PSAnd29ya2luZycpXG4gICAgLnNsaWNlKClcbiAgICAuc29ydCgoYSwgYikgPT5cbiAgICAgIGEubWVtYmVyX2lkIC0gYi5tZW1iZXJfaWQgfHxcbiAgICAgIGEuc3RhcnRfdGltZS5sb2NhbGVDb21wYXJlKGIuc3RhcnRfdGltZSkgfHxcbiAgICAgIChhLmVuZF90aW1lID8/ICcnKS5sb2NhbGVDb21wYXJlKGIuZW5kX3RpbWUgPz8gJycpIHx8XG4gICAgICBhLmlkIC0gYi5pZFxuICAgICk7XG5cbiAgY29uc3QgYmxvY2tzOiBQZW5kaW5nV29ya0Jsb2NrW10gPSBbXTtcbiAgbGV0IGN1cnJlbnQ6IFBlbmRpbmdXb3JrQmxvY2sgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIHdvcmtpbmcpIHtcbiAgICBpZiAoIXNoaWZ0LmVuZF90aW1lKSBjb250aW51ZTtcbiAgICBpZiAoXG4gICAgICAhY3VycmVudCB8fFxuICAgICAgY3VycmVudC5tZW1iZXJfaWQgIT09IHNoaWZ0Lm1lbWJlcl9pZCB8fFxuICAgICAgY3VycmVudC5lbmRfdGltZSAhPT0gc2hpZnQuc3RhcnRfdGltZVxuICAgICkge1xuICAgICAgY3VycmVudCA9IHtcbiAgICAgICAgbWVtYmVyX2lkOiBzaGlmdC5tZW1iZXJfaWQsXG4gICAgICAgIHN0YXJ0X3RpbWU6IHNoaWZ0LnN0YXJ0X3RpbWUsXG4gICAgICAgIGVuZF90aW1lOiBzaGlmdC5lbmRfdGltZSxcbiAgICAgICAgdG90YWxfbWludXRlczogTnVtYmVyKHNoaWZ0LnNoaWZ0X21pbnV0ZXMgPz8gMCksXG4gICAgICAgIHNoaWZ0SWRzOiBbc2hpZnQuaWRdXG4gICAgICB9O1xuICAgICAgYmxvY2tzLnB1c2goY3VycmVudCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjdXJyZW50LmVuZF90aW1lID0gc2hpZnQuZW5kX3RpbWU7XG4gICAgY3VycmVudC50b3RhbF9taW51dGVzICs9IE51bWJlcihzaGlmdC5zaGlmdF9taW51dGVzID8/IDApO1xuICAgIGN1cnJlbnQuc2hpZnRJZHMucHVzaChzaGlmdC5pZCk7XG4gIH1cblxuICByZXR1cm4gYmxvY2tzO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVjb21wdXRlV29ya0Jsb2Nrc0ZvclNjaGVkdWxlKERCOiBEMURhdGFiYXNlLCBzY2hlZHVsZUlkOiBudW1iZXIpIHtcbiAgY29uc3QgaG9vayA9IHdvcmtCbG9ja1Rlc3RIb29rcygpPy5yZWNvbXB1dGVXb3JrQmxvY2tzRm9yU2NoZWR1bGU7XG4gIGlmIChob29rKSB7XG4gICAgYXdhaXQgaG9vayhEQiwgc2NoZWR1bGVJZCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHNoaWZ0cyA9IChcbiAgICBhd2FpdCBEQi5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCBpZCwgc2NoZWR1bGVfaWQsIG1lbWJlcl9pZCwgc3RhdHVzX2tleSwgaG9tZV9hcmVhX2tleSwgc3RhcnRfdGltZSwgZW5kX3RpbWUsIHNoaWZ0X21pbnV0ZXMsIHdvcmtfYmxvY2tfaWRcbiAgICAgICBGUk9NIHNoaWZ0c1xuICAgICAgIFdIRVJFIHNjaGVkdWxlX2lkPT9cbiAgICAgICBPUkRFUiBCWSBtZW1iZXJfaWQgQVNDLCBzdGFydF90aW1lIEFTQywgaWQgQVNDYFxuICAgIClcbiAgICAgIC5iaW5kKHNjaGVkdWxlSWQpXG4gICAgICAuYWxsKClcbiAgKS5yZXN1bHRzIGFzIFdvcmtCbG9ja1NoaWZ0W107XG5cbiAgY29uc3QgYnJlYWtzID0gKFxuICAgIGF3YWl0IERCLnByZXBhcmUoXG4gICAgICBgU0VMRUNUIGIuaWQsIGIuc2hpZnRfaWQsIGIuc3RhcnRfdGltZVxuICAgICAgIEZST00gYnJlYWtzIGJcbiAgICAgICBKT0lOIHNoaWZ0cyBzIE9OIHMuaWQgPSBiLnNoaWZ0X2lkXG4gICAgICAgV0hFUkUgcy5zY2hlZHVsZV9pZD0/YFxuICAgIClcbiAgICAgIC5iaW5kKHNjaGVkdWxlSWQpXG4gICAgICAuYWxsKClcbiAgKS5yZXN1bHRzIGFzIEFycmF5PHsgaWQ6IG51bWJlcjsgc2hpZnRfaWQ6IG51bWJlcjsgc3RhcnRfdGltZTogc3RyaW5nIH0+O1xuXG4gIGF3YWl0IERCLmJhdGNoKFtcbiAgICBEQi5wcmVwYXJlKCdVUERBVEUgc2hpZnRzIFNFVCB3b3JrX2Jsb2NrX2lkPU5VTEwgV0hFUkUgc2NoZWR1bGVfaWQ9PycpLmJpbmQoc2NoZWR1bGVJZCksXG4gICAgREIucHJlcGFyZShcbiAgICAgIGBVUERBVEUgYnJlYWtzXG4gICAgICAgU0VUIHdvcmtfYmxvY2tfaWQ9TlVMTFxuICAgICAgIFdIRVJFIGlkIElOIChcbiAgICAgICAgIFNFTEVDVCBiLmlkXG4gICAgICAgICBGUk9NIGJyZWFrcyBiXG4gICAgICAgICBKT0lOIHNoaWZ0cyBzIE9OIHMuaWQgPSBiLnNoaWZ0X2lkXG4gICAgICAgICBXSEVSRSBzLnNjaGVkdWxlX2lkPT9cbiAgICAgICApYFxuICAgICkuYmluZChzY2hlZHVsZUlkKSxcbiAgICBEQi5wcmVwYXJlKCdERUxFVEUgRlJPTSB3b3JrX2Jsb2NrcyBXSEVSRSBzY2hlZHVsZV9pZD0/JykuYmluZChzY2hlZHVsZUlkKVxuICBdKTtcblxuICBjb25zdCBwZW5kaW5nQmxvY2tzID0gYnVpbGRQZW5kaW5nV29ya0Jsb2NrcyhzaGlmdHMpO1xuICBjb25zdCBzaGlmdHNCeUlkID0gbmV3IE1hcDxudW1iZXIsIFdvcmtCbG9ja1NoaWZ0PihzaGlmdHMubWFwKChzaGlmdCkgPT4gW3NoaWZ0LmlkLCBzaGlmdF0pKTtcblxuICBmb3IgKGNvbnN0IHBlbmRpbmcgb2YgcGVuZGluZ0Jsb2Nrcykge1xuICAgIGNvbnN0IGluc2VydCA9IGF3YWl0IERCLnByZXBhcmUoXG4gICAgICBgSU5TRVJUIElOVE8gd29ya19ibG9ja3MgKHNjaGVkdWxlX2lkLCBtZW1iZXJfaWQsIHN0YXJ0X3RpbWUsIGVuZF90aW1lLCB0b3RhbF9taW51dGVzKVxuICAgICAgIFZBTFVFUyAoPywgPywgPywgPywgPylgXG4gICAgKVxuICAgICAgLmJpbmQoc2NoZWR1bGVJZCwgcGVuZGluZy5tZW1iZXJfaWQsIHBlbmRpbmcuc3RhcnRfdGltZSwgcGVuZGluZy5lbmRfdGltZSwgcGVuZGluZy50b3RhbF9taW51dGVzKVxuICAgICAgLnJ1bigpO1xuICAgIGNvbnN0IHdvcmtCbG9ja0lkID0gTnVtYmVyKChpbnNlcnQgYXMgYW55KT8ubWV0YT8ubGFzdF9yb3dfaWQgPz8gMCk7XG4gICAgaWYgKCF3b3JrQmxvY2tJZCkgY29udGludWU7XG5cbiAgICBjb25zdCBzaGlmdFVwZGF0ZXMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IHNoaWZ0SWQgb2YgcGVuZGluZy5zaGlmdElkcykge1xuICAgICAgc2hpZnRVcGRhdGVzLnB1c2goREIucHJlcGFyZSgnVVBEQVRFIHNoaWZ0cyBTRVQgd29ya19ibG9ja19pZD0/IFdIRVJFIGlkPT8nKS5iaW5kKHdvcmtCbG9ja0lkLCBzaGlmdElkKSk7XG4gICAgICBjb25zdCBzaGlmdCA9IHNoaWZ0c0J5SWQuZ2V0KHNoaWZ0SWQpO1xuICAgICAgaWYgKHNoaWZ0KSBzaGlmdC53b3JrX2Jsb2NrX2lkID0gd29ya0Jsb2NrSWQ7XG4gICAgfVxuICAgIGlmIChzaGlmdFVwZGF0ZXMubGVuZ3RoID4gMCkge1xuICAgICAgYXdhaXQgREIuYmF0Y2goc2hpZnRVcGRhdGVzKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBicmVha1VwZGF0ZXMgPSBbXTtcbiAgZm9yIChjb25zdCByb3cgb2YgYnJlYWtzKSB7XG4gICAgY29uc3Qgb2xkU2hpZnQgPSBzaGlmdHNCeUlkLmdldChyb3cuc2hpZnRfaWQpO1xuICAgIGlmICghb2xkU2hpZnQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFjdGl2ZVNoaWZ0ID0gYWN0aXZlU2hpZnRBdFRpbWUoc2hpZnRzLCBvbGRTaGlmdC5tZW1iZXJfaWQsIHJvdy5zdGFydF90aW1lKSA/PyBvbGRTaGlmdDtcbiAgICBicmVha1VwZGF0ZXMucHVzaChcbiAgICAgIERCLnByZXBhcmUoJ1VQREFURSBicmVha3MgU0VUIHNoaWZ0X2lkPT8sIHdvcmtfYmxvY2tfaWQ9PyBXSEVSRSBpZD0/JylcbiAgICAgICAgLmJpbmQoYWN0aXZlU2hpZnQuaWQsIGFjdGl2ZVNoaWZ0LndvcmtfYmxvY2tfaWQgPz8gbnVsbCwgcm93LmlkKVxuICAgICk7XG4gIH1cbiAgaWYgKGJyZWFrVXBkYXRlcy5sZW5ndGggPiAwKSB7XG4gICAgYXdhaXQgREIuYmF0Y2goYnJlYWtVcGRhdGVzKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJNZW1iZXJCcmVha1BsYW5Gb3JTY2hlZHVsZShEQjogRDFEYXRhYmFzZSwgc2NoZWR1bGVJZDogbnVtYmVyLCBtZW1iZXJJZDogbnVtYmVyKSB7XG4gIGNvbnN0IGhvb2sgPSB3b3JrQmxvY2tUZXN0SG9va3MoKT8uY2xlYXJNZW1iZXJCcmVha1BsYW5Gb3JTY2hlZHVsZTtcbiAgaWYgKGhvb2spIHtcbiAgICBhd2FpdCBob29rKERCLCBzY2hlZHVsZUlkLCBtZW1iZXJJZCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGF3YWl0IERCLnByZXBhcmUoXG4gICAgYERFTEVURSBGUk9NIGJyZWFrc1xuICAgICBXSEVSRSBpZCBJTiAoXG4gICAgICAgU0VMRUNUIGIuaWRcbiAgICAgICBGUk9NIGJyZWFrcyBiXG4gICAgICAgSk9JTiBzaGlmdHMgcyBPTiBzLmlkID0gYi5zaGlmdF9pZFxuICAgICAgIFdIRVJFIHMuc2NoZWR1bGVfaWQ9PyBBTkQgcy5tZW1iZXJfaWQ9P1xuICAgICApYFxuICApLmJpbmQoc2NoZWR1bGVJZCwgbWVtYmVySWQpLnJ1bigpO1xuXG4gIGF3YWl0IERCLnByZXBhcmUoXG4gICAgYFVQREFURSBicmVha3NcbiAgICAgU0VUIGNvdmVyX21lbWJlcl9pZD1OVUxMXG4gICAgIFdIRVJFIGlkIElOIChcbiAgICAgICBTRUxFQ1QgYi5pZFxuICAgICAgIEZST00gYnJlYWtzIGJcbiAgICAgICBKT0lOIHNoaWZ0cyBzIE9OIHMuaWQgPSBiLnNoaWZ0X2lkXG4gICAgICAgV0hFUkUgcy5zY2hlZHVsZV9pZD0/IEFORCBiLmNvdmVyX21lbWJlcl9pZD0/XG4gICAgIClgXG4gICkuYmluZChzY2hlZHVsZUlkLCBtZW1iZXJJZCkucnVuKCk7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBBUElSb3V0ZSB9IGZyb20gJ2FzdHJvJztcbmltcG9ydCB7IHJlcXVpcmVSb2xlIH0gZnJvbSAnLi4vLi4vLi4vbGliL2F1dGgnO1xuaW1wb3J0IHsgZ2V0REIgfSBmcm9tICcuLi8uLi8uLi9saWIvZGInO1xuaW1wb3J0IHsgcmVkaXJlY3RXaXRoTWVzc2FnZSB9IGZyb20gJy4uLy4uLy4uL2xpYi9yZWRpcmVjdCc7XG5pbXBvcnQgeyBwYXJzZUhITU0gfSBmcm9tICcuLi8uLi8uLi9saWIvdGltZSc7XG5pbXBvcnQgeyBmaW5kT3ZlcmxhcHBpbmdTaGlmdCwgc2hpZnRSYW5nZSB9IGZyb20gJy4uLy4uLy4uL2xpYi9zaGlmdHMnO1xuaW1wb3J0IHsgYXNzZXJ0TWVtYmVyQ2FuV29ya0FyZWEgfSBmcm9tICcuLi8uLi8uLi9saWIvYXJlYS1wZXJtaXNzaW9ucyc7XG5pbXBvcnQgeyBjbGVhck1lbWJlckJyZWFrUGxhbkZvclNjaGVkdWxlLCByZWNvbXB1dGVXb3JrQmxvY2tzRm9yU2NoZWR1bGUgfSBmcm9tICcuLi8uLi8uLi9saWIvd29yay1ibG9ja3MnO1xuaW1wb3J0IHsgZ2V0UG9zaXRpdmVJbnQsIGdldFN0cmluZywgZ2V0VW5pcXVlUG9zaXRpdmVJbnRzLCBpc0lTT0RhdGUgfSBmcm9tICcuLi8uLi8uLi9saWIvaHR0cCc7XG5cbmV4cG9ydCBjb25zdCBQT1NUOiBBUElSb3V0ZSA9IGFzeW5jICh7IHJlcXVlc3QgfSkgPT4ge1xuICBjb25zdCBndWFyZCA9IHJlcXVpcmVSb2xlKHJlcXVlc3QsICdhZG1pbicpO1xuICBpZiAoIWd1YXJkLm9rKSByZXR1cm4gZ3VhcmQucmVkaXJlY3Q7XG5cbiAgY29uc3QgZm9ybSA9IGF3YWl0IHJlcXVlc3QuZm9ybURhdGEoKTtcbiAgY29uc3QgZGF0ZSA9IGdldFN0cmluZyhmb3JtLCAnZGF0ZScpO1xuICBjb25zdCBzaGlmdElkID0gZ2V0UG9zaXRpdmVJbnQoZm9ybSwgJ3NoaWZ0SWQnKTtcbiAgY29uc3QgaG9tZUFyZWFLZXkgPSBnZXRTdHJpbmcoZm9ybSwgJ2hvbWVBcmVhS2V5Jyk7XG4gIGNvbnN0IHN0YXR1c0tleSA9IGdldFN0cmluZyhmb3JtLCAnc3RhdHVzS2V5Jyk7XG4gIGNvbnN0IHNoaWZ0Um9sZSA9ICgoZm9ybS5nZXQoJ3NoaWZ0Um9sZScpIHx8ICdub3JtYWwnKS50b1N0cmluZygpID09PSAnZmxvYXRlcicgPyAnZmxvYXRlcicgOiAnbm9ybWFsJyk7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IChmb3JtLmdldCgnc3RhcnRUaW1lJykgfHwgJycpLnRvU3RyaW5nKCk7XG4gIGNvbnN0IGVuZFRpbWUgPSAoZm9ybS5nZXQoJ2VuZFRpbWUnKSB8fCAnJykudG9TdHJpbmcoKTtcbiAgY29uc3QgcHJlZmVycmVkQ292ZXJlcklkcyA9IGdldFVuaXF1ZVBvc2l0aXZlSW50cyhmb3JtLCAncHJlZmVycmVkQ292ZXJlcklkcycsIDQpO1xuXG4gIGlmICghaXNJU09EYXRlKGRhdGUpKSByZXR1cm4gcmVkaXJlY3RXaXRoTWVzc2FnZShgL2FkbWluL3NjaGVkdWxlLyR7ZGF0ZX0jc2hpZnRzYCwgeyBlcnJvcjogJ0ludmFsaWQgZGF0ZScgfSk7XG4gIGlmIChzaGlmdElkID09IG51bGwpIHJldHVybiByZWRpcmVjdFdpdGhNZXNzYWdlKGAvYWRtaW4vc2NoZWR1bGUvJHtkYXRlfSNzaGlmdHNgLCB7IGVycm9yOiAnSW52YWxpZCBzaGlmdCcgfSk7XG5cbiAgY29uc3Qgc3RhcnRNaW4gPSBwYXJzZUhITU0oc3RhcnRUaW1lKTtcbiAgY29uc3QgZW5kTWluID0gcGFyc2VISE1NKGVuZFRpbWUpO1xuICBpZiAoc3RhcnRNaW4gPT0gbnVsbCB8fCBlbmRNaW4gPT0gbnVsbCkgcmV0dXJuIHJlZGlyZWN0V2l0aE1lc3NhZ2UoYC9hZG1pbi9zY2hlZHVsZS8ke2RhdGV9I3NoaWZ0c2AsIHsgZXJyb3I6ICdJbnZhbGlkIHRpbWUnIH0pO1xuICBpZiAoZW5kTWluIDw9IHN0YXJ0TWluKSByZXR1cm4gcmVkaXJlY3RXaXRoTWVzc2FnZShgL2FkbWluL3NjaGVkdWxlLyR7ZGF0ZX0jc2hpZnRzYCwgeyBlcnJvcjogJ0VuZCB0aW1lIG11c3QgYmUgYWZ0ZXIgc3RhcnQgdGltZSAoc2FtZSBkYXkpLicgfSk7XG5cbiAgY29uc3Qgc2hpZnRNaW51dGVzID0gZW5kTWluIC0gc3RhcnRNaW47XG4gIGlmIChzaGlmdE1pbnV0ZXMgPiAxMCAqIDYwKSByZXR1cm4gcmVkaXJlY3RXaXRoTWVzc2FnZShgL2FkbWluL3NjaGVkdWxlLyR7ZGF0ZX0jc2hpZnRzYCwgeyBlcnJvcjogJ1NoaWZ0IGV4Y2VlZHMgMTAgaG91cnMgbWF4LicgfSk7XG5cbiAgY29uc3QgREIgPSBhd2FpdCBnZXREQigpO1xuXG4gIGNvbnN0IGN1cnJlbnQgPSAoYXdhaXQgREIucHJlcGFyZSgnU0VMRUNUIHNjaGVkdWxlX2lkLCBtZW1iZXJfaWQsIHN0YXJ0X3RpbWUsIGVuZF90aW1lLCB3b3JrX2Jsb2NrX2lkIEZST00gc2hpZnRzIFdIRVJFIGlkPT8nKS5iaW5kKHNoaWZ0SWQpLmZpcnN0KCkpIGFzIGFueTtcbiAgaWYgKCFjdXJyZW50KSByZXR1cm4gcmVkaXJlY3RXaXRoTWVzc2FnZShgL2FkbWluL3NjaGVkdWxlLyR7ZGF0ZX0jc2hpZnRzYCwgeyBlcnJvcjogJ1NoaWZ0IG5vdCBmb3VuZCcgfSk7XG4gIGNvbnN0IHBlcm1pc3Npb25FcnJvciA9IGF3YWl0IGFzc2VydE1lbWJlckNhbldvcmtBcmVhKERCLCBjdXJyZW50Lm1lbWJlcl9pZCwgaG9tZUFyZWFLZXkpO1xuICBpZiAocGVybWlzc2lvbkVycm9yKSB7XG4gICAgcmV0dXJuIHJlZGlyZWN0V2l0aE1lc3NhZ2UoYC9hZG1pbi9zY2hlZHVsZS8ke2RhdGV9I3NoaWZ0c2AsIHsgZXJyb3I6IHBlcm1pc3Npb25FcnJvciB9KTtcbiAgfVxuICBpZiAocHJlZmVycmVkQ292ZXJlcklkcy5zb21lKChtZW1iZXJJZCkgPT4gbWVtYmVySWQgPT09IGN1cnJlbnQubWVtYmVyX2lkKSkge1xuICAgIHJldHVybiByZWRpcmVjdFdpdGhNZXNzYWdlKGAvYWRtaW4vc2NoZWR1bGUvJHtkYXRlfSNzaGlmdHNgLCB7IGVycm9yOiAnQSBtZW1iZXIgY2Fubm90IGJlIHRoZWlyIG93biBwcmVmZXJyZWQgY292ZXJlcicgfSk7XG4gIH1cblxuICBjb25zdCB1bmlxdWVQcmVmZXJyZWRDb3ZlcmVySWRzID0gcHJlZmVycmVkQ292ZXJlcklkcztcblxuICBjb25zdCBzaWJsaW5nU2hpZnRzID0gKFxuICAgIGF3YWl0IERCLnByZXBhcmUoXG4gICAgICAnU0VMRUNUIGlkLCBtZW1iZXJfaWQsIGhvbWVfYXJlYV9rZXksIHN0YXR1c19rZXksIHN0YXJ0X3RpbWUsIGVuZF90aW1lIEZST00gc2hpZnRzIFdIRVJFIHNjaGVkdWxlX2lkPT8gQU5EIG1lbWJlcl9pZD0/J1xuICAgIClcbiAgICAgIC5iaW5kKGN1cnJlbnQuc2NoZWR1bGVfaWQsIGN1cnJlbnQubWVtYmVyX2lkKVxuICAgICAgLmFsbCgpXG4gICkucmVzdWx0cyBhcyBBcnJheTx7XG4gICAgaWQ6IG51bWJlcjtcbiAgICBtZW1iZXJfaWQ6IG51bWJlcjtcbiAgICBob21lX2FyZWFfa2V5OiBzdHJpbmc7XG4gICAgc3RhdHVzX2tleTogc3RyaW5nO1xuICAgIHN0YXJ0X3RpbWU6IHN0cmluZztcbiAgICBlbmRfdGltZTogc3RyaW5nIHwgbnVsbDtcbiAgfT47XG5cbiAgY29uc3Qgb3ZlcmxhcCA9IGZpbmRPdmVybGFwcGluZ1NoaWZ0KHNpYmxpbmdTaGlmdHMsIHsgc3RhcnQ6IHN0YXJ0TWluLCBlbmQ6IGVuZE1pbiB9LCB7IGV4Y2x1ZGVTaGlmdElkOiBzaGlmdElkIH0pO1xuICBpZiAob3ZlcmxhcCkge1xuICAgIHJldHVybiByZWRpcmVjdFdpdGhNZXNzYWdlKGAvYWRtaW4vc2NoZWR1bGUvJHtkYXRlfSNzaGlmdHNgLCB7XG4gICAgICBlcnJvcjogYFNoaWZ0IG92ZXJsYXBzIGFub3RoZXIgc2hpZnQgZm9yIHRoaXMgbWVtYmVyICgke292ZXJsYXAuc3RhcnRfdGltZX0tJHtvdmVybGFwLmVuZF90aW1lID8/ICdcdTIwMTQnfSkuYFxuICAgIH0pO1xuICB9XG5cbiAgYXdhaXQgREIucHJlcGFyZShcbiAgICAnVVBEQVRFIHNoaWZ0cyBTRVQgaG9tZV9hcmVhX2tleT0/LCBzdGF0dXNfa2V5PT8sIHNoaWZ0X3JvbGU9Pywgc3RhcnRfdGltZT0/LCBlbmRfdGltZT0/LCBzaGlmdF9taW51dGVzPT8gV0hFUkUgaWQ9PydcbiAgKVxuICAgIC5iaW5kKGhvbWVBcmVhS2V5LCBzdGF0dXNLZXksIHNoaWZ0Um9sZSwgc3RhcnRUaW1lLCBlbmRUaW1lLCBzaGlmdE1pbnV0ZXMsIHNoaWZ0SWQpXG4gICAgLnJ1bigpO1xuXG4gIGF3YWl0IHJlY29tcHV0ZVdvcmtCbG9ja3NGb3JTY2hlZHVsZShEQiwgY3VycmVudC5zY2hlZHVsZV9pZCk7XG4gIGF3YWl0IGNsZWFyTWVtYmVyQnJlYWtQbGFuRm9yU2NoZWR1bGUoREIsIGN1cnJlbnQuc2NoZWR1bGVfaWQsIGN1cnJlbnQubWVtYmVyX2lkKTtcblxuICBjb25zdCBwcmlvcml0eVN0YXRlbWVudHMgPSBbREIucHJlcGFyZSgnREVMRVRFIEZST00gc2hpZnRfY292ZXJfcHJpb3JpdGllcyBXSEVSRSBzaGlmdF9pZD0/JykuYmluZChzaGlmdElkKV07XG4gIGZvciAoY29uc3QgW2luZGV4LCBtZW1iZXJJZF0gb2YgdW5pcXVlUHJlZmVycmVkQ292ZXJlcklkcy5lbnRyaWVzKCkpIHtcbiAgICBwcmlvcml0eVN0YXRlbWVudHMucHVzaChcbiAgICAgIERCLnByZXBhcmUoJ0lOU0VSVCBJTlRPIHNoaWZ0X2NvdmVyX3ByaW9yaXRpZXMgKHNoaWZ0X2lkLCBtZW1iZXJfaWQsIHByaW9yaXR5KSBWQUxVRVMgKD8sID8sID8pJylcbiAgICAgICAgLmJpbmQoc2hpZnRJZCwgbWVtYmVySWQsIGluZGV4ICsgMSlcbiAgICApO1xuICB9XG4gIGF3YWl0IERCLmJhdGNoKHByaW9yaXR5U3RhdGVtZW50cyk7XG5cbiAgaWYgKHN0YXR1c0tleSA9PT0gJ3NpY2snKSB7XG4gICAgLy8gQ2xlYXIgYW55IGNvdmVyIGFzc2lnbm1lbnRzIHRoYXQgb3ZlcmxhcCB0aGUgbm93LXNpY2sgc2hpZnQgd2luZG93LlxuICAgIGNvbnN0IHNpY2tSYW5nZSA9IHNoaWZ0UmFuZ2UoeyBzdGFydF90aW1lOiBzdGFydFRpbWUsIGVuZF90aW1lOiBlbmRUaW1lIH0pO1xuICAgIGlmIChzaWNrUmFuZ2UpIHtcbiAgICAgIGNvbnN0IGNvdmVyQXNzaWdubWVudHMgPSAoXG4gICAgICAgIGF3YWl0IERCLnByZXBhcmUoXG4gICAgICAgICAgYFNFTEVDVCBiLmlkLCBiLnN0YXJ0X3RpbWUsIGIuZHVyYXRpb25fbWludXRlc1xuICAgICAgICAgICBGUk9NIGJyZWFrcyBiXG4gICAgICAgICAgIEpPSU4gc2hpZnRzIHMgT04gcy5pZCA9IGIuc2hpZnRfaWRcbiAgICAgICAgICAgV0hFUkUgcy5zY2hlZHVsZV9pZD0/IEFORCBiLmNvdmVyX21lbWJlcl9pZD0/YFxuICAgICAgICApXG4gICAgICAgICAgLmJpbmQoY3VycmVudC5zY2hlZHVsZV9pZCwgY3VycmVudC5tZW1iZXJfaWQpXG4gICAgICAgICAgLmFsbCgpXG4gICAgICApLnJlc3VsdHMgYXMgQXJyYXk8eyBpZDogbnVtYmVyOyBzdGFydF90aW1lOiBzdHJpbmc7IGR1cmF0aW9uX21pbnV0ZXM6IG51bWJlciB9PjtcblxuICAgICAgY29uc3QgY2xlYXJpbmdTdGF0ZW1lbnRzID0gW107XG4gICAgICBmb3IgKGNvbnN0IGFzc2lnbm1lbnQgb2YgY292ZXJBc3NpZ25tZW50cykge1xuICAgICAgICBjb25zdCBzdGFydCA9IHBhcnNlSEhNTShhc3NpZ25tZW50LnN0YXJ0X3RpbWUpO1xuICAgICAgICBpZiAoc3RhcnQgPT0gbnVsbCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGVuZCA9IHN0YXJ0ICsgTnVtYmVyKGFzc2lnbm1lbnQuZHVyYXRpb25fbWludXRlcyk7XG4gICAgICAgIGlmIChzdGFydCA8IHNpY2tSYW5nZS5lbmQgJiYgc2lja1JhbmdlLnN0YXJ0IDwgZW5kKSB7XG4gICAgICAgICAgY2xlYXJpbmdTdGF0ZW1lbnRzLnB1c2goREIucHJlcGFyZSgnVVBEQVRFIGJyZWFrcyBTRVQgY292ZXJfbWVtYmVyX2lkPU5VTEwgV0hFUkUgaWQ9PycpLmJpbmQoYXNzaWdubWVudC5pZCkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoY2xlYXJpbmdTdGF0ZW1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXdhaXQgREIuYmF0Y2goY2xlYXJpbmdTdGF0ZW1lbnRzKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVkaXJlY3RXaXRoTWVzc2FnZShgL2FkbWluL3NjaGVkdWxlLyR7ZGF0ZX0jc2hpZnRzYCwge1xuICAgIG5vdGljZTogc3RhdHVzS2V5ID09PSAnc2ljaycgPyAnU2hpZnQgdXBkYXRlZCAoU2ljayBhcHBsaWVkKS4gQnJlYWsgcGxhbiBjbGVhcmVkIGZvciB0aGF0IG1lbWJlci4nIDogJ1NoaWZ0IHVwZGF0ZWQuIEJyZWFrIHBsYW4gY2xlYXJlZCBmb3IgdGhhdCBtZW1iZXIuJ1xuICB9KTtcbn07XG4iLCAiZXhwb3J0IGNsYXNzIEZha2VTdGF0ZW1lbnQge1xuICBzcWw6IHN0cmluZztcbiAgaGFuZGxlcnM6IFJvdXRlREI7XG4gIGFyZ3M6IGFueVtdID0gW107XG5cbiAgY29uc3RydWN0b3Ioc3FsOiBzdHJpbmcsIGhhbmRsZXJzOiBSb3V0ZURCKSB7XG4gICAgdGhpcy5zcWwgPSBzcWw7XG4gICAgdGhpcy5oYW5kbGVycyA9IGhhbmRsZXJzO1xuICB9XG5cbiAgYmluZCguLi5hcmdzOiBhbnlbXSkge1xuICAgIHRoaXMuYXJncyA9IGFyZ3M7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhc3luYyBmaXJzdCgpIHtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVycy5maXJzdCh0aGlzLnNxbCwgdGhpcy5hcmdzKTtcbiAgfVxuXG4gIGFzeW5jIGFsbCgpIHtcbiAgICByZXR1cm4geyByZXN1bHRzOiBhd2FpdCB0aGlzLmhhbmRsZXJzLmFsbCh0aGlzLnNxbCwgdGhpcy5hcmdzKSB9O1xuICB9XG5cbiAgYXN5bmMgcnVuKCkge1xuICAgIHJldHVybiB0aGlzLmhhbmRsZXJzLnJ1bih0aGlzLnNxbCwgdGhpcy5hcmdzKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUm91dGVEQiB7XG4gIGZpcnN0SGFuZGxlcnMgPSBuZXcgTWFwPHN0cmluZywgYW55PigpO1xuICBhbGxIYW5kbGVycyA9IG5ldyBNYXA8c3RyaW5nLCBhbnk+KCk7XG4gIHJ1bnM6IEFycmF5PHsgc3FsOiBzdHJpbmc7IGFyZ3M6IGFueVtdIH0+ID0gW107XG4gIGJhdGNoZXM6IEFycmF5PEFycmF5PHsgc3FsOiBzdHJpbmc7IGFyZ3M6IGFueVtdIH0+PiA9IFtdO1xuXG4gIHByZXBhcmUoc3FsOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gbmV3IEZha2VTdGF0ZW1lbnQoc3FsLCB0aGlzKTtcbiAgfVxuXG4gIGFzeW5jIGZpcnN0KHNxbDogc3RyaW5nLCBhcmdzOiBhbnlbXSkge1xuICAgIGNvbnN0IGVudHJ5ID0gWy4uLnRoaXMuZmlyc3RIYW5kbGVycy5lbnRyaWVzKCldLmZpbmQoKFtrZXldKSA9PiBzcWwuaW5jbHVkZXMoa2V5KSk7XG4gICAgaWYgKCFlbnRyeSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHR5cGVvZiBlbnRyeVsxXSA9PT0gJ2Z1bmN0aW9uJyA/IGVudHJ5WzFdKGFyZ3MsIHNxbCkgOiBlbnRyeVsxXTtcbiAgfVxuXG4gIGFzeW5jIGFsbChzcWw6IHN0cmluZywgYXJnczogYW55W10pIHtcbiAgICBjb25zdCBlbnRyeSA9IFsuLi50aGlzLmFsbEhhbmRsZXJzLmVudHJpZXMoKV0uZmluZCgoW2tleV0pID0+IHNxbC5pbmNsdWRlcyhrZXkpKTtcbiAgICBpZiAoIWVudHJ5KSByZXR1cm4gW107XG4gICAgcmV0dXJuIHR5cGVvZiBlbnRyeVsxXSA9PT0gJ2Z1bmN0aW9uJyA/IGVudHJ5WzFdKGFyZ3MsIHNxbCkgOiBlbnRyeVsxXTtcbiAgfVxuXG4gIGFzeW5jIHJ1bihzcWw6IHN0cmluZywgYXJnczogYW55W10pIHtcbiAgICB0aGlzLnJ1bnMucHVzaCh7IHNxbCwgYXJncyB9KTtcbiAgICByZXR1cm4geyBtZXRhOiB7IGNoYW5nZXM6IDEsIGxhc3Rfcm93X2lkOiAxIH0gfTtcbiAgfVxuXG4gIGFzeW5jIGJhdGNoKHN0YXRlbWVudHM6IEZha2VTdGF0ZW1lbnRbXSkge1xuICAgIHRoaXMuYmF0Y2hlcy5wdXNoKHN0YXRlbWVudHMubWFwKChzdGF0ZW1lbnQpID0+ICh7IHNxbDogc3RhdGVtZW50LnNxbCwgYXJnczogc3RhdGVtZW50LmFyZ3MgfSkpKTtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkbWluUmVxdWVzdCh1cmw6IHN0cmluZywgZm9ybTogUmVjb3JkPHN0cmluZywgc3RyaW5nPikge1xuICBjb25zdCBib2R5ID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhmb3JtKTtcbiAgcmV0dXJuIG5ldyBSZXF1ZXN0KHVybCwge1xuICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24veC13d3ctZm9ybS11cmxlbmNvZGVkJyxcbiAgICAgIGNvb2tpZTogJ2J1bnJ1bl9yb2xlPWFkbWluJ1xuICAgIH0sXG4gICAgYm9keVxuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxUZXN0REIoZGI6IFJvdXRlREIpIHtcbiAgKGdsb2JhbFRoaXMgYXMgYW55KS5fX2J1bnJ1blRlc3REQiA9IGRiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFdvcmtCbG9ja0hvb2tzKGhvb2tzOiB7XG4gIHJlY29tcHV0ZVdvcmtCbG9ja3NGb3JTY2hlZHVsZT86IChEQjogRDFEYXRhYmFzZSwgc2NoZWR1bGVJZDogbnVtYmVyKSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZDtcbiAgY2xlYXJNZW1iZXJCcmVha1BsYW5Gb3JTY2hlZHVsZT86IChEQjogRDFEYXRhYmFzZSwgc2NoZWR1bGVJZDogbnVtYmVyLCBtZW1iZXJJZDogbnVtYmVyKSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZDtcbn0pIHtcbiAgKGdsb2JhbFRoaXMgYXMgYW55KS5fX2J1bnJ1bldvcmtCbG9ja1Rlc3RIb29rcyA9IGhvb2tzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRSb3V0ZVRlc3RHbG9iYWxzKCkge1xuICBkZWxldGUgKGdsb2JhbFRoaXMgYXMgYW55KS5fX2J1bnJ1blRlc3REQjtcbiAgZGVsZXRlIChnbG9iYWxUaGlzIGFzIGFueSkuX19idW5ydW5Xb3JrQmxvY2tUZXN0SG9va3M7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDR25CLFNBQVMsYUFBYSxjQUFxRDtBQUN6RSxNQUFJLENBQUMsYUFBYyxRQUFPLENBQUM7QUFDM0IsUUFBTSxNQUE4QixDQUFDO0FBQ3JDLGFBQVcsUUFBUSxhQUFhLE1BQU0sR0FBRyxHQUFHO0FBQzFDLFVBQU0sQ0FBQyxHQUFHLEdBQUcsSUFBSSxJQUFJLEtBQUssS0FBSyxFQUFFLE1BQU0sR0FBRztBQUMxQyxRQUFJLENBQUMsRUFBRztBQUNSLFFBQUksQ0FBQyxJQUFJLG1CQUFtQixLQUFLLEtBQUssR0FBRyxDQUFDO0FBQUEsRUFDNUM7QUFDQSxTQUFPO0FBQ1Q7QUFFTyxTQUFTLG1CQUFtQixTQUFtQztBQUNwRSxRQUFNLFVBQVUsYUFBYSxRQUFRLFFBQVEsSUFBSSxRQUFRLENBQUM7QUFDMUQsUUFBTSxPQUFPLFFBQVEsYUFBYTtBQUNsQyxN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
