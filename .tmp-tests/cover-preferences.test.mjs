// tests/cover-preferences.test.ts
import test from "node:test";
import assert from "node:assert/strict";

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
function assignBestCovers(context, lockedBreaks, pendingBreaks) {
  const assignments = /* @__PURE__ */ new Map();
  if (pendingBreaks.length === 0) return assignments;
  const pendingById = new Map(pendingBreaks.map((row) => [row.id, row]));
  let bestScore = Number.POSITIVE_INFINITY;
  let bestAssignments = /* @__PURE__ */ new Map();
  const search = (currentBreaks, remainingIds, runningScore) => {
    if (runningScore >= bestScore) return;
    if (remainingIds.length === 0) {
      bestScore = runningScore;
      bestAssignments = new Map(assignments);
      return;
    }
    let nextId = remainingIds[0];
    let nextOptions = null;
    for (const breakId of remainingIds) {
      const row2 = pendingById.get(breakId);
      if (!row2) continue;
      const options = listEligibleCoverOptions(context, currentBreaks, row2);
      if (!nextOptions || options.length < nextOptions.length) {
        nextId = breakId;
        nextOptions = options;
      }
    }
    const row = pendingById.get(nextId);
    if (!row || !nextOptions) return;
    const remainingAfter = remainingIds.filter((id) => id !== nextId);
    for (const option of nextOptions) {
      assignments.set(nextId, option.memberId);
      const nextBreaks = currentBreaks.map(
        (item) => item.id === nextId ? { ...item, cover_member_id: option.memberId } : item
      );
      search(nextBreaks, remainingAfter, runningScore + option.score);
    }
    assignments.delete(nextId);
  };
  search([...lockedBreaks, ...pendingBreaks], pendingBreaks.map((row) => row.id), 0);
  return bestAssignments;
}

// tests/cover-preferences.test.ts
test("preferred coverer outranks other non-floater valid coverers", () => {
  const context = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 10,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      },
      {
        id: 2,
        member_id: 20,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      },
      {
        id: 3,
        member_id: 30,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      }
    ],
    members: [
      { id: 10, all_areas: 1 },
      { id: 20, all_areas: 1 },
      { id: 30, all_areas: 1 }
    ],
    perms: [],
    minByArea: /* @__PURE__ */ new Map([["registers", 1]]),
    preferredRankByShiftId: /* @__PURE__ */ new Map([[1, /* @__PURE__ */ new Map([[30, 0], [20, 1]])]])
  });
  const targetBreak = {
    id: 99,
    work_block_id: 1,
    shift_id: 1,
    start_time: "09:00",
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 10,
    off_shift_id: 1,
    off_area_key: "registers"
  };
  const options = listEligibleCoverOptions(context, [], targetBreak).filter((row) => row.memberId != null);
  assert.equal(options[0]?.memberId, 30);
  assert.equal(options[1]?.memberId, 20);
});
test("sick shifts are not eligible as preferred coverers", () => {
  const context = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 10,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      },
      {
        id: 2,
        member_id: 20,
        home_area_key: "registers",
        status_key: "sick",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      },
      {
        id: 3,
        member_id: 30,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      }
    ],
    members: [
      { id: 10, all_areas: 1 },
      { id: 20, all_areas: 1 },
      { id: 30, all_areas: 1 }
    ],
    perms: [],
    minByArea: /* @__PURE__ */ new Map([["registers", 1]]),
    preferredRankByShiftId: /* @__PURE__ */ new Map([[1, /* @__PURE__ */ new Map([[20, 0], [30, 1]])]])
  });
  const targetBreak = {
    id: 98,
    work_block_id: 1,
    shift_id: 1,
    start_time: "09:00",
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 10,
    off_shift_id: 1,
    off_area_key: "registers"
  };
  const options = listEligibleCoverOptions(context, [], targetBreak).filter((row) => row.memberId != null);
  assert.equal(options[0]?.memberId, 30);
  assert.ok(!options.some((row) => row.memberId === 20));
});
test("existing conflicting cover assignment blocks a preferred coverer", () => {
  const context = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 10,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      },
      {
        id: 2,
        member_id: 20,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      },
      {
        id: 3,
        member_id: 30,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      }
    ],
    members: [
      { id: 10, all_areas: 1 },
      { id: 20, all_areas: 1 },
      { id: 30, all_areas: 1 }
    ],
    perms: [],
    minByArea: /* @__PURE__ */ new Map([["registers", 1]]),
    preferredRankByShiftId: /* @__PURE__ */ new Map([[1, /* @__PURE__ */ new Map([[20, 0]])]])
  });
  const existingBreaks = [{
    id: 50,
    work_block_id: 2,
    shift_id: 3,
    start_time: "09:00",
    duration_minutes: 15,
    cover_member_id: 20,
    off_member_id: 30,
    off_shift_id: 3,
    off_area_key: "registers"
  }];
  const pendingBreaks = [{
    id: 99,
    work_block_id: 1,
    shift_id: 1,
    start_time: "09:00",
    duration_minutes: 15,
    cover_member_id: null,
    off_member_id: 10,
    off_shift_id: 1,
    off_area_key: "registers"
  }];
  const assignments = assignBestCovers(context, existingBreaks, pendingBreaks);
  assert.equal(assignments.get(99), null);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvY292ZXItcHJlZmVyZW5jZXMudGVzdC50cyIsICIuLi9zcmMvbGliL3RpbWUudHMiLCAiLi4vc3JjL2xpYi9icmVha3MudHMiLCAiLi4vc3JjL2xpYi9zaGlmdHMudHMiLCAiLi4vc3JjL2xpYi9icmVhay1wbGFubmVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuXG5pbXBvcnQgeyBhc3NpZ25CZXN0Q292ZXJzLCBidWlsZFBsYW5uZXJDb250ZXh0LCBsaXN0RWxpZ2libGVDb3Zlck9wdGlvbnMsIHR5cGUgUGxhbm5lckJyZWFrIH0gZnJvbSAnLi4vc3JjL2xpYi9icmVhay1wbGFubmVyLnRzJztcblxudGVzdCgncHJlZmVycmVkIGNvdmVyZXIgb3V0cmFua3Mgb3RoZXIgbm9uLWZsb2F0ZXIgdmFsaWQgY292ZXJlcnMnLCAoKSA9PiB7XG4gIGNvbnN0IGNvbnRleHQgPSBidWlsZFBsYW5uZXJDb250ZXh0KHtcbiAgICBzaGlmdHM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IDEsXG4gICAgICAgIG1lbWJlcl9pZDogMTAsXG4gICAgICAgIGhvbWVfYXJlYV9rZXk6ICdyZWdpc3RlcnMnLFxuICAgICAgICBzdGF0dXNfa2V5OiAnd29ya2luZycsXG4gICAgICAgIHNoaWZ0X3JvbGU6ICdub3JtYWwnLFxuICAgICAgICBzdGFydF90aW1lOiAnMDY6MDAnLFxuICAgICAgICBlbmRfdGltZTogJzEyOjAwJ1xuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IDIsXG4gICAgICAgIG1lbWJlcl9pZDogMjAsXG4gICAgICAgIGhvbWVfYXJlYV9rZXk6ICdyZWdpc3RlcnMnLFxuICAgICAgICBzdGF0dXNfa2V5OiAnd29ya2luZycsXG4gICAgICAgIHNoaWZ0X3JvbGU6ICdub3JtYWwnLFxuICAgICAgICBzdGFydF90aW1lOiAnMDY6MDAnLFxuICAgICAgICBlbmRfdGltZTogJzEyOjAwJ1xuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IDMsXG4gICAgICAgIG1lbWJlcl9pZDogMzAsXG4gICAgICAgIGhvbWVfYXJlYV9rZXk6ICdyZWdpc3RlcnMnLFxuICAgICAgICBzdGF0dXNfa2V5OiAnd29ya2luZycsXG4gICAgICAgIHNoaWZ0X3JvbGU6ICdub3JtYWwnLFxuICAgICAgICBzdGFydF90aW1lOiAnMDY6MDAnLFxuICAgICAgICBlbmRfdGltZTogJzEyOjAwJ1xuICAgICAgfVxuICAgIF0sXG4gICAgbWVtYmVyczogW1xuICAgICAgeyBpZDogMTAsIGFsbF9hcmVhczogMSB9LFxuICAgICAgeyBpZDogMjAsIGFsbF9hcmVhczogMSB9LFxuICAgICAgeyBpZDogMzAsIGFsbF9hcmVhczogMSB9XG4gICAgXSxcbiAgICBwZXJtczogW10sXG4gICAgbWluQnlBcmVhOiBuZXcgTWFwKFtbJ3JlZ2lzdGVycycsIDFdXSksXG4gICAgcHJlZmVycmVkUmFua0J5U2hpZnRJZDogbmV3IE1hcChbWzEsIG5ldyBNYXAoW1szMCwgMF0sIFsyMCwgMV1dKV1dKVxuICB9KTtcblxuICBjb25zdCB0YXJnZXRCcmVhazogUGxhbm5lckJyZWFrID0ge1xuICAgIGlkOiA5OSxcbiAgICB3b3JrX2Jsb2NrX2lkOiAxLFxuICAgIHNoaWZ0X2lkOiAxLFxuICAgIHN0YXJ0X3RpbWU6ICcwOTowMCcsXG4gICAgZHVyYXRpb25fbWludXRlczogMTUsXG4gICAgY292ZXJfbWVtYmVyX2lkOiBudWxsLFxuICAgIG9mZl9tZW1iZXJfaWQ6IDEwLFxuICAgIG9mZl9zaGlmdF9pZDogMSxcbiAgICBvZmZfYXJlYV9rZXk6ICdyZWdpc3RlcnMnXG4gIH07XG5cbiAgY29uc3Qgb3B0aW9ucyA9IGxpc3RFbGlnaWJsZUNvdmVyT3B0aW9ucyhjb250ZXh0LCBbXSwgdGFyZ2V0QnJlYWspLmZpbHRlcigocm93KSA9PiByb3cubWVtYmVySWQgIT0gbnVsbCk7XG4gIGFzc2VydC5lcXVhbChvcHRpb25zWzBdPy5tZW1iZXJJZCwgMzApO1xuICBhc3NlcnQuZXF1YWwob3B0aW9uc1sxXT8ubWVtYmVySWQsIDIwKTtcbn0pO1xuXG50ZXN0KCdzaWNrIHNoaWZ0cyBhcmUgbm90IGVsaWdpYmxlIGFzIHByZWZlcnJlZCBjb3ZlcmVycycsICgpID0+IHtcbiAgY29uc3QgY29udGV4dCA9IGJ1aWxkUGxhbm5lckNvbnRleHQoe1xuICAgIHNoaWZ0czogW1xuICAgICAge1xuICAgICAgICBpZDogMSxcbiAgICAgICAgbWVtYmVyX2lkOiAxMCxcbiAgICAgICAgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsXG4gICAgICAgIHN0YXR1c19rZXk6ICd3b3JraW5nJyxcbiAgICAgICAgc2hpZnRfcm9sZTogJ25vcm1hbCcsXG4gICAgICAgIHN0YXJ0X3RpbWU6ICcwNjowMCcsXG4gICAgICAgIGVuZF90aW1lOiAnMTI6MDAnXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogMixcbiAgICAgICAgbWVtYmVyX2lkOiAyMCxcbiAgICAgICAgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsXG4gICAgICAgIHN0YXR1c19rZXk6ICdzaWNrJyxcbiAgICAgICAgc2hpZnRfcm9sZTogJ25vcm1hbCcsXG4gICAgICAgIHN0YXJ0X3RpbWU6ICcwNjowMCcsXG4gICAgICAgIGVuZF90aW1lOiAnMTI6MDAnXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogMyxcbiAgICAgICAgbWVtYmVyX2lkOiAzMCxcbiAgICAgICAgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsXG4gICAgICAgIHN0YXR1c19rZXk6ICd3b3JraW5nJyxcbiAgICAgICAgc2hpZnRfcm9sZTogJ25vcm1hbCcsXG4gICAgICAgIHN0YXJ0X3RpbWU6ICcwNjowMCcsXG4gICAgICAgIGVuZF90aW1lOiAnMTI6MDAnXG4gICAgICB9XG4gICAgXSxcbiAgICBtZW1iZXJzOiBbXG4gICAgICB7IGlkOiAxMCwgYWxsX2FyZWFzOiAxIH0sXG4gICAgICB7IGlkOiAyMCwgYWxsX2FyZWFzOiAxIH0sXG4gICAgICB7IGlkOiAzMCwgYWxsX2FyZWFzOiAxIH1cbiAgICBdLFxuICAgIHBlcm1zOiBbXSxcbiAgICBtaW5CeUFyZWE6IG5ldyBNYXAoW1sncmVnaXN0ZXJzJywgMV1dKSxcbiAgICBwcmVmZXJyZWRSYW5rQnlTaGlmdElkOiBuZXcgTWFwKFtbMSwgbmV3IE1hcChbWzIwLCAwXSwgWzMwLCAxXV0pXV0pXG4gIH0pO1xuXG4gIGNvbnN0IHRhcmdldEJyZWFrOiBQbGFubmVyQnJlYWsgPSB7XG4gICAgaWQ6IDk4LFxuICAgIHdvcmtfYmxvY2tfaWQ6IDEsXG4gICAgc2hpZnRfaWQ6IDEsXG4gICAgc3RhcnRfdGltZTogJzA5OjAwJyxcbiAgICBkdXJhdGlvbl9taW51dGVzOiAxNSxcbiAgICBjb3Zlcl9tZW1iZXJfaWQ6IG51bGwsXG4gICAgb2ZmX21lbWJlcl9pZDogMTAsXG4gICAgb2ZmX3NoaWZ0X2lkOiAxLFxuICAgIG9mZl9hcmVhX2tleTogJ3JlZ2lzdGVycydcbiAgfTtcblxuICBjb25zdCBvcHRpb25zID0gbGlzdEVsaWdpYmxlQ292ZXJPcHRpb25zKGNvbnRleHQsIFtdLCB0YXJnZXRCcmVhaykuZmlsdGVyKChyb3cpID0+IHJvdy5tZW1iZXJJZCAhPSBudWxsKTtcbiAgYXNzZXJ0LmVxdWFsKG9wdGlvbnNbMF0/Lm1lbWJlcklkLCAzMCk7XG4gIGFzc2VydC5vayghb3B0aW9ucy5zb21lKChyb3cpID0+IHJvdy5tZW1iZXJJZCA9PT0gMjApKTtcbn0pO1xuXG50ZXN0KCdleGlzdGluZyBjb25mbGljdGluZyBjb3ZlciBhc3NpZ25tZW50IGJsb2NrcyBhIHByZWZlcnJlZCBjb3ZlcmVyJywgKCkgPT4ge1xuICBjb25zdCBjb250ZXh0ID0gYnVpbGRQbGFubmVyQ29udGV4dCh7XG4gICAgc2hpZnRzOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiAxLFxuICAgICAgICBtZW1iZXJfaWQ6IDEwLFxuICAgICAgICBob21lX2FyZWFfa2V5OiAncmVnaXN0ZXJzJyxcbiAgICAgICAgc3RhdHVzX2tleTogJ3dvcmtpbmcnLFxuICAgICAgICBzaGlmdF9yb2xlOiAnbm9ybWFsJyxcbiAgICAgICAgc3RhcnRfdGltZTogJzA2OjAwJyxcbiAgICAgICAgZW5kX3RpbWU6ICcxMjowMCdcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAyLFxuICAgICAgICBtZW1iZXJfaWQ6IDIwLFxuICAgICAgICBob21lX2FyZWFfa2V5OiAncmVnaXN0ZXJzJyxcbiAgICAgICAgc3RhdHVzX2tleTogJ3dvcmtpbmcnLFxuICAgICAgICBzaGlmdF9yb2xlOiAnbm9ybWFsJyxcbiAgICAgICAgc3RhcnRfdGltZTogJzA2OjAwJyxcbiAgICAgICAgZW5kX3RpbWU6ICcxMjowMCdcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAzLFxuICAgICAgICBtZW1iZXJfaWQ6IDMwLFxuICAgICAgICBob21lX2FyZWFfa2V5OiAncmVnaXN0ZXJzJyxcbiAgICAgICAgc3RhdHVzX2tleTogJ3dvcmtpbmcnLFxuICAgICAgICBzaGlmdF9yb2xlOiAnbm9ybWFsJyxcbiAgICAgICAgc3RhcnRfdGltZTogJzA2OjAwJyxcbiAgICAgICAgZW5kX3RpbWU6ICcxMjowMCdcbiAgICAgIH1cbiAgICBdLFxuICAgIG1lbWJlcnM6IFtcbiAgICAgIHsgaWQ6IDEwLCBhbGxfYXJlYXM6IDEgfSxcbiAgICAgIHsgaWQ6IDIwLCBhbGxfYXJlYXM6IDEgfSxcbiAgICAgIHsgaWQ6IDMwLCBhbGxfYXJlYXM6IDEgfVxuICAgIF0sXG4gICAgcGVybXM6IFtdLFxuICAgIG1pbkJ5QXJlYTogbmV3IE1hcChbWydyZWdpc3RlcnMnLCAxXV0pLFxuICAgIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ6IG5ldyBNYXAoW1sxLCBuZXcgTWFwKFtbMjAsIDBdXSldXSlcbiAgfSk7XG5cbiAgY29uc3QgZXhpc3RpbmdCcmVha3M6IFBsYW5uZXJCcmVha1tdID0gW3tcbiAgICBpZDogNTAsXG4gICAgd29ya19ibG9ja19pZDogMixcbiAgICBzaGlmdF9pZDogMyxcbiAgICBzdGFydF90aW1lOiAnMDk6MDAnLFxuICAgIGR1cmF0aW9uX21pbnV0ZXM6IDE1LFxuICAgIGNvdmVyX21lbWJlcl9pZDogMjAsXG4gICAgb2ZmX21lbWJlcl9pZDogMzAsXG4gICAgb2ZmX3NoaWZ0X2lkOiAzLFxuICAgIG9mZl9hcmVhX2tleTogJ3JlZ2lzdGVycydcbiAgfV07XG5cbiAgY29uc3QgcGVuZGluZ0JyZWFrczogUGxhbm5lckJyZWFrW10gPSBbe1xuICAgIGlkOiA5OSxcbiAgICB3b3JrX2Jsb2NrX2lkOiAxLFxuICAgIHNoaWZ0X2lkOiAxLFxuICAgIHN0YXJ0X3RpbWU6ICcwOTowMCcsXG4gICAgZHVyYXRpb25fbWludXRlczogMTUsXG4gICAgY292ZXJfbWVtYmVyX2lkOiBudWxsLFxuICAgIG9mZl9tZW1iZXJfaWQ6IDEwLFxuICAgIG9mZl9zaGlmdF9pZDogMSxcbiAgICBvZmZfYXJlYV9rZXk6ICdyZWdpc3RlcnMnXG4gIH1dO1xuXG4gIGNvbnN0IGFzc2lnbm1lbnRzID0gYXNzaWduQmVzdENvdmVycyhjb250ZXh0LCBleGlzdGluZ0JyZWFrcywgcGVuZGluZ0JyZWFrcyk7XG4gIGFzc2VydC5lcXVhbChhc3NpZ25tZW50cy5nZXQoOTkpLCBudWxsKTtcbn0pO1xuIiwgImV4cG9ydCBmdW5jdGlvbiBwYXJzZUhITU0odmFsdWU6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtID0gL14oWzAxXT9cXGR8MlswLTNdKTooWzAtNV1cXGQpJC8uZXhlYyh2YWx1ZS50cmltKCkpO1xuICBpZiAoIW0pIHJldHVybiBudWxsO1xuICBjb25zdCBoaCA9IE51bWJlcihtWzFdKTtcbiAgY29uc3QgbW0gPSBOdW1iZXIobVsyXSk7XG4gIHJldHVybiBoaCAqIDYwICsgbW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREdXJhdGlvbk1pbnV0ZXModG90YWw6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHNpZ24gPSB0b3RhbCA8IDAgPyAnLScgOiAnJztcbiAgY29uc3QgbSA9IE1hdGguYWJzKHRvdGFsKTtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3IobSAvIDYwKTtcbiAgY29uc3QgciA9IG0gJSA2MDtcbiAgaWYgKGggPT09IDApIHJldHVybiBgJHtzaWdufSR7cn1tYDtcbiAgaWYgKHIgPT09IDApIHJldHVybiBgJHtzaWdufSR7aH1oYDtcbiAgcmV0dXJuIGAke3NpZ259JHtofWggJHtyfW1gO1xufVxuXG4vLyBCcmlzYmFuZSBpcyBVVEMrMTAgd2l0aCBubyBEU1QuXG5jb25zdCBCUklTQkFORV9PRkZTRVQgPSAnKzEwOjAwJztcblxuZXhwb3J0IGZ1bmN0aW9uIGRheVR5cGVGb3JEYXRlKGRhdGVZWVlZTU1ERDogc3RyaW5nKTogJ3dlZWtkYXknIHwgJ3dlZWtlbmQnIHwgbnVsbCB7XG4gIGlmICghL15cXGR7NH0tXFxkezJ9LVxcZHsyfSQvLnRlc3QoZGF0ZVlZWVlNTUREKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGQgPSBuZXcgRGF0ZShgJHtkYXRlWVlZWU1NRER9VDAwOjAwOjAwJHtCUklTQkFORV9PRkZTRVR9YCk7XG4gIGNvbnN0IGRvdyA9IGQuZ2V0VVRDRGF5KCk7XG4gIC8vIDAgU3VuLCA2IFNhdFxuICByZXR1cm4gZG93ID09PSAwIHx8IGRvdyA9PT0gNiA/ICd3ZWVrZW5kJyA6ICd3ZWVrZGF5Jztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHRvSEhNTSh0b3RhbE1pbnV0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGhoID0gTWF0aC5mbG9vcih0b3RhbE1pbnV0ZXMgLyA2MCkgJSAyNDtcbiAgY29uc3QgbW0gPSB0b3RhbE1pbnV0ZXMgJSA2MDtcbiAgcmV0dXJuIGAke1N0cmluZyhoaCkucGFkU3RhcnQoMiwgJzAnKX06JHtTdHJpbmcobW0pLnBhZFN0YXJ0KDIsICcwJyl9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9wZXJhdGluZ0hvdXJzRm9yKGRhdGVZWVlZTU1ERDogc3RyaW5nKTogeyBvcGVuOiBudW1iZXI7IGNsb3NlOiBudW1iZXIgfSB8IG51bGwge1xuICBjb25zdCBkdCA9IGRheVR5cGVGb3JEYXRlKGRhdGVZWVlZTU1ERCk7XG4gIGlmICghZHQpIHJldHVybiBudWxsO1xuICAvLyB3ZWVrZW5kIDA2OjAwLTE5OjE1LCB3ZWVrZGF5IDA2OjAwLTIxOjE1XG4gIHJldHVybiBkdCA9PT0gJ3dlZWtlbmQnXG4gICAgPyB7IG9wZW46IDYgKiA2MCwgY2xvc2U6IDE5ICogNjAgKyAxNSB9XG4gICAgOiB7IG9wZW46IDYgKiA2MCwgY2xvc2U6IDIxICogNjAgKyAxNSB9O1xufVxuIiwgImltcG9ydCB7IHBhcnNlSEhNTSB9IGZyb20gJy4vdGltZSc7XG5cbmV4cG9ydCBmdW5jdGlvbiBicmVha0FsbG93YW5jZU1pbnV0ZXMoc2hpZnRNaW51dGVzOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAoc2hpZnRNaW51dGVzIDwgNCAqIDYwKSByZXR1cm4gMDtcbiAgaWYgKHNoaWZ0TWludXRlcyA8PSA1ICogNjApIHJldHVybiAxNTtcbiAgaWYgKHNoaWZ0TWludXRlcyA8IDcgKiA2MCkgcmV0dXJuIDQ1O1xuICBpZiAoc2hpZnRNaW51dGVzIDwgMTAgKiA2MCkgcmV0dXJuIDYwO1xuICByZXR1cm4gOTA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvdmVybGFwKGFTdGFydDogbnVtYmVyLCBhRW5kOiBudW1iZXIsIGJTdGFydDogbnVtYmVyLCBiRW5kOiBudW1iZXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIGFTdGFydCA8IGJFbmQgJiYgYlN0YXJ0IDwgYUVuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1pbnV0ZXNSYW5nZShzdGFydEhITU06IHN0cmluZywgZHVyYXRpb25NaW51dGVzOiBudW1iZXIpOiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0gfCBudWxsIHtcbiAgY29uc3QgcyA9IHBhcnNlSEhNTShzdGFydEhITU0pO1xuICBpZiAocyA9PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZHVyYXRpb24gPSBOdW1iZXIoZHVyYXRpb25NaW51dGVzKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoZHVyYXRpb24pKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc3RhcnQ6IHMsIGVuZDogcyArIGR1cmF0aW9uIH07XG59XG4iLCAiaW1wb3J0IHsgcGFyc2VISE1NIH0gZnJvbSAnLi90aW1lJztcblxuZXhwb3J0IHR5cGUgU2hpZnRUaW1lTGlrZSA9IHtcbiAgaWQ/OiBudW1iZXI7XG4gIG1lbWJlcl9pZDogbnVtYmVyO1xuICBob21lX2FyZWFfa2V5OiBzdHJpbmc7XG4gIHN0YXR1c19rZXk6IHN0cmluZztcbiAgc3RhcnRfdGltZTogc3RyaW5nO1xuICBlbmRfdGltZTogc3RyaW5nIHwgbnVsbDtcbn07XG5cbmV4cG9ydCB0eXBlIE1pbnV0ZVJhbmdlID0ge1xuICBzdGFydDogbnVtYmVyO1xuICBlbmQ6IG51bWJlcjtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBzaGlmdFJhbmdlKHNoaWZ0OiBQaWNrPFNoaWZ0VGltZUxpa2UsICdzdGFydF90aW1lJyB8ICdlbmRfdGltZSc+KTogTWludXRlUmFuZ2UgfCBudWxsIHtcbiAgY29uc3Qgc3RhcnQgPSBwYXJzZUhITU0oc2hpZnQuc3RhcnRfdGltZSk7XG4gIGNvbnN0IGVuZCA9IHNoaWZ0LmVuZF90aW1lID8gcGFyc2VISE1NKHNoaWZ0LmVuZF90aW1lKSA6IG51bGw7XG4gIGlmIChzdGFydCA9PSBudWxsIHx8IGVuZCA9PSBudWxsIHx8IGVuZCA8PSBzdGFydCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHN0YXJ0LCBlbmQgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJhbmdlc092ZXJsYXAoYTogTWludXRlUmFuZ2UsIGI6IE1pbnV0ZVJhbmdlKTogYm9vbGVhbiB7XG4gIHJldHVybiBhLnN0YXJ0IDwgYi5lbmQgJiYgYi5zdGFydCA8IGEuZW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZmluZE92ZXJsYXBwaW5nU2hpZnQoXG4gIHNoaWZ0czogQXJyYXk8U2hpZnRUaW1lTGlrZT4sXG4gIHRhcmdldDogTWludXRlUmFuZ2UsXG4gIG9wdHM/OiB7IGV4Y2x1ZGVTaGlmdElkPzogbnVtYmVyIH1cbik6IFNoaWZ0VGltZUxpa2UgfCBudWxsIHtcbiAgY29uc3QgZXhjbHVkZVNoaWZ0SWQgPSBvcHRzPy5leGNsdWRlU2hpZnRJZCA/PyBudWxsO1xuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIHNoaWZ0cykge1xuICAgIGlmIChleGNsdWRlU2hpZnRJZCAhPSBudWxsICYmIHNoaWZ0LmlkID09PSBleGNsdWRlU2hpZnRJZCkgY29udGludWU7XG4gICAgY29uc3QgcmFuZ2UgPSBzaGlmdFJhbmdlKHNoaWZ0KTtcbiAgICBpZiAoIXJhbmdlKSBjb250aW51ZTtcbiAgICBpZiAocmFuZ2VzT3ZlcmxhcChyYW5nZSwgdGFyZ2V0KSkgcmV0dXJuIHNoaWZ0O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hpZnRzQWN0aXZlSW5SYW5nZShzaGlmdHM6IEFycmF5PFNoaWZ0VGltZUxpa2U+LCB0YXJnZXQ6IE1pbnV0ZVJhbmdlLCBvcHRzPzogeyB3b3JraW5nT25seT86IGJvb2xlYW4gfSkge1xuICByZXR1cm4gc2hpZnRzLmZpbHRlcigoc2hpZnQpID0+IHtcbiAgICBpZiAob3B0cz8ud29ya2luZ09ubHkgJiYgc2hpZnQuc3RhdHVzX2tleSAhPT0gJ3dvcmtpbmcnKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcmFuZ2UgPSBzaGlmdFJhbmdlKHNoaWZ0KTtcbiAgICByZXR1cm4gQm9vbGVhbihyYW5nZSAmJiByYW5nZXNPdmVybGFwKHJhbmdlLCB0YXJnZXQpKTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaXJzdEFjdGl2ZVNoaWZ0SW5SYW5nZShcbiAgc2hpZnRzOiBBcnJheTxTaGlmdFRpbWVMaWtlPixcbiAgdGFyZ2V0OiBNaW51dGVSYW5nZSxcbiAgb3B0cz86IHsgd29ya2luZ09ubHk/OiBib29sZWFuIH1cbikge1xuICByZXR1cm4gc2hpZnRzQWN0aXZlSW5SYW5nZShzaGlmdHMsIHRhcmdldCwgb3B0cylbMF0gPz8gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvdW50V29ya2luZ1NoaWZ0c0J5QXJlYUluUmFuZ2Uoc2hpZnRzOiBBcnJheTxTaGlmdFRpbWVMaWtlPiwgdGFyZ2V0OiBNaW51dGVSYW5nZSkge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIHNoaWZ0cykge1xuICAgIGlmIChzaGlmdC5zdGF0dXNfa2V5ICE9PSAnd29ya2luZycpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJhbmdlID0gc2hpZnRSYW5nZShzaGlmdCk7XG4gICAgaWYgKCFyYW5nZSB8fCAhcmFuZ2VzT3ZlcmxhcChyYW5nZSwgdGFyZ2V0KSkgY29udGludWU7XG4gICAgY291bnRzLnNldChzaGlmdC5ob21lX2FyZWFfa2V5LCAoY291bnRzLmdldChzaGlmdC5ob21lX2FyZWFfa2V5KSA/PyAwKSArIDEpO1xuICB9XG4gIHJldHVybiBjb3VudHM7XG59XG4iLCAiaW1wb3J0IHsgb3ZlcmxhcCwgbWludXRlc1JhbmdlIH0gZnJvbSAnLi9icmVha3MnO1xuaW1wb3J0IHsgY291bnRXb3JraW5nU2hpZnRzQnlBcmVhSW5SYW5nZSwgZmlyc3RBY3RpdmVTaGlmdEluUmFuZ2UgfSBmcm9tICcuL3NoaWZ0cyc7XG5cbmV4cG9ydCB0eXBlIFBsYW5uZXJTaGlmdCA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgbWVtYmVyX2lkOiBudW1iZXI7XG4gIGhvbWVfYXJlYV9rZXk6IHN0cmluZztcbiAgc3RhdHVzX2tleTogc3RyaW5nO1xuICBzaGlmdF9yb2xlPzogc3RyaW5nO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGVuZF90aW1lOiBzdHJpbmcgfCBudWxsO1xufTtcblxuZXhwb3J0IHR5cGUgUGxhbm5lckJyZWFrID0ge1xuICBpZDogbnVtYmVyO1xuICB3b3JrX2Jsb2NrX2lkOiBudW1iZXIgfCBudWxsO1xuICBzaGlmdF9pZDogbnVtYmVyO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGR1cmF0aW9uX21pbnV0ZXM6IG51bWJlcjtcbiAgY292ZXJfbWVtYmVyX2lkOiBudW1iZXIgfCBudWxsO1xuICBvZmZfbWVtYmVyX2lkOiBudW1iZXI7XG4gIG9mZl9zaGlmdF9pZD86IG51bWJlcjtcbiAgb2ZmX2FyZWFfa2V5OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBQbGFubmVyTWVtYmVyID0ge1xuICBpZDogbnVtYmVyO1xuICBhbGxfYXJlYXM6IG51bWJlcjtcbn07XG5cbmV4cG9ydCB0eXBlIFBsYW5uZXJDb250ZXh0ID0ge1xuICBzaGlmdHM6IFBsYW5uZXJTaGlmdFtdO1xuICBzaGlmdHNCeU1lbWJlcjogTWFwPG51bWJlciwgUGxhbm5lclNoaWZ0W10+O1xuICBtZW1iZXJCeUlkOiBNYXA8bnVtYmVyLCBQbGFubmVyTWVtYmVyPjtcbiAgcGVybXNCeU1lbWJlcjogTWFwPG51bWJlciwgU2V0PHN0cmluZz4+O1xuICBtaW5CeUFyZWE6IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ6IE1hcDxudW1iZXIsIE1hcDxudW1iZXIsIG51bWJlcj4+O1xufTtcblxudHlwZSBDb3Zlck9wdGlvbiA9IHtcbiAgbWVtYmVySWQ6IG51bWJlciB8IG51bGw7XG4gIHNjb3JlOiBudW1iZXI7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRQbGFubmVyQ29udGV4dChpbnB1dDoge1xuICBzaGlmdHM6IFBsYW5uZXJTaGlmdFtdO1xuICBtZW1iZXJzOiBQbGFubmVyTWVtYmVyW107XG4gIHBlcm1zOiBBcnJheTx7IG1lbWJlcl9pZDogbnVtYmVyOyBhcmVhX2tleTogc3RyaW5nIH0+O1xuICBtaW5CeUFyZWE6IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ/OiBNYXA8bnVtYmVyLCBNYXA8bnVtYmVyLCBudW1iZXI+Pjtcbn0pOiBQbGFubmVyQ29udGV4dCB7XG4gIGNvbnN0IHNoaWZ0c0J5TWVtYmVyID0gbmV3IE1hcDxudW1iZXIsIFBsYW5uZXJTaGlmdFtdPigpO1xuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIGlucHV0LnNoaWZ0cykge1xuICAgIGNvbnN0IHJvd3MgPSBzaGlmdHNCeU1lbWJlci5nZXQoc2hpZnQubWVtYmVyX2lkKSA/PyBbXTtcbiAgICByb3dzLnB1c2goc2hpZnQpO1xuICAgIHNoaWZ0c0J5TWVtYmVyLnNldChzaGlmdC5tZW1iZXJfaWQsIHJvd3MpO1xuICB9XG5cbiAgY29uc3QgbWVtYmVyQnlJZCA9IG5ldyBNYXAoaW5wdXQubWVtYmVycy5tYXAoKG1lbWJlcikgPT4gW21lbWJlci5pZCwgbWVtYmVyXSkpO1xuICBjb25zdCBwZXJtc0J5TWVtYmVyID0gbmV3IE1hcDxudW1iZXIsIFNldDxzdHJpbmc+PigpO1xuICBmb3IgKGNvbnN0IHBlcm0gb2YgaW5wdXQucGVybXMpIHtcbiAgICBjb25zdCByb3dzID0gcGVybXNCeU1lbWJlci5nZXQocGVybS5tZW1iZXJfaWQpID8/IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIHJvd3MuYWRkKHBlcm0uYXJlYV9rZXkpO1xuICAgIHBlcm1zQnlNZW1iZXIuc2V0KHBlcm0ubWVtYmVyX2lkLCByb3dzKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc2hpZnRzOiBpbnB1dC5zaGlmdHMsXG4gICAgc2hpZnRzQnlNZW1iZXIsXG4gICAgbWVtYmVyQnlJZCxcbiAgICBwZXJtc0J5TWVtYmVyLFxuICAgIG1pbkJ5QXJlYTogaW5wdXQubWluQnlBcmVhLFxuICAgIHByZWZlcnJlZFJhbmtCeVNoaWZ0SWQ6IGlucHV0LnByZWZlcnJlZFJhbmtCeVNoaWZ0SWQgPz8gbmV3IE1hcCgpXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBicmVha1RhcmdldFJhbmdlKHJvdzogUGljazxQbGFubmVyQnJlYWssICdzdGFydF90aW1lJyB8ICdkdXJhdGlvbl9taW51dGVzJz4pIHtcbiAgcmV0dXJuIG1pbnV0ZXNSYW5nZShyb3cuc3RhcnRfdGltZSwgTnVtYmVyKHJvdy5kdXJhdGlvbl9taW51dGVzKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYW5NZW1iZXJXb3JrQXJlYShjb250ZXh0OiBQbGFubmVyQ29udGV4dCwgbWVtYmVySWQ6IG51bWJlciwgYXJlYUtleTogc3RyaW5nKSB7XG4gIGNvbnN0IG1lbWJlciA9IGNvbnRleHQubWVtYmVyQnlJZC5nZXQobWVtYmVySWQpO1xuICBpZiAoIW1lbWJlcikgcmV0dXJuIGZhbHNlO1xuICBpZiAoTnVtYmVyKG1lbWJlci5hbGxfYXJlYXMpID09PSAxKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIEJvb2xlYW4oY29udGV4dC5wZXJtc0J5TWVtYmVyLmdldChtZW1iZXJJZCk/LmhhcyhhcmVhS2V5KSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhY3RpdmVXb3JraW5nU2hpZnRGb3JNZW1iZXIoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBtZW1iZXJJZDogbnVtYmVyLFxuICB0YXJnZXQ6IHsgc3RhcnQ6IG51bWJlcjsgZW5kOiBudW1iZXIgfVxuKSB7XG4gIHJldHVybiBmaXJzdEFjdGl2ZVNoaWZ0SW5SYW5nZShjb250ZXh0LnNoaWZ0c0J5TWVtYmVyLmdldChtZW1iZXJJZCkgPz8gW10sIHRhcmdldCwgeyB3b3JraW5nT25seTogdHJ1ZSB9KSBhcyBQbGFubmVyU2hpZnQgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzQ292ZXJDb25mbGljdChcbiAgYnJlYWtzOiBQbGFubmVyQnJlYWtbXSxcbiAgbWVtYmVySWQ6IG51bWJlcixcbiAgdGFyZ2V0OiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0sXG4gIGV4Y2x1ZGVCcmVha0lkPzogbnVtYmVyXG4pIHtcbiAgZm9yIChjb25zdCByb3cgb2YgYnJlYWtzKSB7XG4gICAgaWYgKGV4Y2x1ZGVCcmVha0lkICE9IG51bGwgJiYgcm93LmlkID09PSBleGNsdWRlQnJlYWtJZCkgY29udGludWU7XG4gICAgY29uc3QgcmFuZ2UgPSBicmVha1RhcmdldFJhbmdlKHJvdyk7XG4gICAgaWYgKCFyYW5nZSkgY29udGludWU7XG4gICAgaWYgKHJvdy5jb3Zlcl9tZW1iZXJfaWQgPT09IG1lbWJlcklkICYmIG92ZXJsYXAodGFyZ2V0LnN0YXJ0LCB0YXJnZXQuZW5kLCByYW5nZS5zdGFydCwgcmFuZ2UuZW5kKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHJvdy5vZmZfbWVtYmVyX2lkID09PSBtZW1iZXJJZCAmJiBvdmVybGFwKHRhcmdldC5zdGFydCwgdGFyZ2V0LmVuZCwgcmFuZ2Uuc3RhcnQsIHJhbmdlLmVuZCkpIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZpb2xhdGVzQXJlYU1pbmltdW1zKFxuICBjb250ZXh0OiBQbGFubmVyQ29udGV4dCxcbiAgYnJlYWtzOiBQbGFubmVyQnJlYWtbXSxcbiAgdGFyZ2V0QnJlYWs6IFBsYW5uZXJCcmVhayxcbiAgdGFyZ2V0OiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0sXG4gIGNvdmVyTWVtYmVySWQ6IG51bWJlciB8IG51bGxcbikge1xuICBjb25zdCBjb3VudHMgPSBjb3VudFdvcmtpbmdTaGlmdHNCeUFyZWFJblJhbmdlKGNvbnRleHQuc2hpZnRzLCB0YXJnZXQpO1xuICBjb25zdCBvdmVybGFwcGluZ0JyZWFrcyA9IGJyZWFrcy5maWx0ZXIoKHJvdykgPT4ge1xuICAgIGNvbnN0IHJhbmdlID0gYnJlYWtUYXJnZXRSYW5nZShyb3cpO1xuICAgIGlmICghcmFuZ2UpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gb3ZlcmxhcCh0YXJnZXQuc3RhcnQsIHRhcmdldC5lbmQsIHJhbmdlLnN0YXJ0LCByYW5nZS5lbmQpO1xuICB9KTtcblxuICBmb3IgKGNvbnN0IHJvdyBvZiBvdmVybGFwcGluZ0JyZWFrcykge1xuICAgIGNvbnN0IG5leHRDb3Zlck1lbWJlcklkID0gcm93LmlkID09PSB0YXJnZXRCcmVhay5pZCA/IGNvdmVyTWVtYmVySWQgOiByb3cuY292ZXJfbWVtYmVyX2lkO1xuICAgIGNvdW50cy5zZXQocm93Lm9mZl9hcmVhX2tleSwgKGNvdW50cy5nZXQocm93Lm9mZl9hcmVhX2tleSkgPz8gMCkgLSAxKTtcblxuICAgIGlmIChuZXh0Q292ZXJNZW1iZXJJZCA9PSBudWxsKSBjb250aW51ZTtcbiAgICBjb25zdCBjb3ZlclNoaWZ0ID0gYWN0aXZlV29ya2luZ1NoaWZ0Rm9yTWVtYmVyKGNvbnRleHQsIG5leHRDb3Zlck1lbWJlcklkLCB0YXJnZXQpO1xuICAgIGlmICghY292ZXJTaGlmdCkgY29udGludWU7XG4gICAgaWYgKGNvdmVyU2hpZnQuaG9tZV9hcmVhX2tleSAhPT0gcm93Lm9mZl9hcmVhX2tleSkge1xuICAgICAgY291bnRzLnNldChjb3ZlclNoaWZ0LmhvbWVfYXJlYV9rZXksIChjb3VudHMuZ2V0KGNvdmVyU2hpZnQuaG9tZV9hcmVhX2tleSkgPz8gMCkgLSAxKTtcbiAgICAgIGNvdW50cy5zZXQocm93Lm9mZl9hcmVhX2tleSwgKGNvdW50cy5nZXQocm93Lm9mZl9hcmVhX2tleSkgPz8gMCkgKyAxKTtcbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IFthcmVhS2V5LCBhY3RpdmVDb3VudF0gb2YgY291bnRzLmVudHJpZXMoKSkge1xuICAgIGlmIChhY3RpdmVDb3VudCA8PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCBtaW5TdGFmZiA9IGNvbnRleHQubWluQnlBcmVhLmdldChhcmVhS2V5KSA/PyAwO1xuICAgIGlmICgoY291bnRzLmdldChhcmVhS2V5KSA/PyAwKSA8IG1pblN0YWZmKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0FyZWFDb3ZlcmVkV2l0aG91dEFzc2lnbmVkQ292ZXIoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBicmVha3M6IFBsYW5uZXJCcmVha1tdLFxuICB0YXJnZXRCcmVhazogUGxhbm5lckJyZWFrXG4pIHtcbiAgY29uc3QgdGFyZ2V0ID0gYnJlYWtUYXJnZXRSYW5nZSh0YXJnZXRCcmVhayk7XG4gIGlmICghdGFyZ2V0KSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAhdmlvbGF0ZXNBcmVhTWluaW11bXMoY29udGV4dCwgYnJlYWtzLCB0YXJnZXRCcmVhaywgdGFyZ2V0LCBudWxsKTtcbn1cblxuZnVuY3Rpb24gY292ZXJPcHRpb25TY29yZShcbiAgY29udGV4dDogUGxhbm5lckNvbnRleHQsXG4gIHRhcmdldEJyZWFrOiBQbGFubmVyQnJlYWssXG4gIGNvdmVyU2hpZnQ6IFBsYW5uZXJTaGlmdFxuKSB7XG4gIGNvbnN0IHByZWZlcnJlZFJhbmtzID0gY29udGV4dC5wcmVmZXJyZWRSYW5rQnlTaGlmdElkLmdldCh0YXJnZXRCcmVhay5zaGlmdF9pZCkgPz8gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcbiAgY29uc3QgcHJlZmVycmVkUmFuayA9IHByZWZlcnJlZFJhbmtzLmdldChjb3ZlclNoaWZ0Lm1lbWJlcl9pZCk7XG4gIGxldCBzY29yZSA9IDA7XG5cbiAgaWYgKChjb3ZlclNoaWZ0LnNoaWZ0X3JvbGUgPz8gJ25vcm1hbCcpID09PSAnZmxvYXRlcicpIHtcbiAgICBzY29yZSAtPSAxMjA7XG4gIH1cblxuICBpZiAocHJlZmVycmVkUmFuayA9PSBudWxsKSB7XG4gICAgc2NvcmUgKz0gNDA7XG4gIH0gZWxzZSB7XG4gICAgc2NvcmUgKz0gcHJlZmVycmVkUmFuayAqIDQ7XG4gIH1cblxuICBpZiAoY292ZXJTaGlmdC5ob21lX2FyZWFfa2V5ICE9PSB0YXJnZXRCcmVhay5vZmZfYXJlYV9rZXkpIHNjb3JlICs9IDEyO1xuXG4gIHJldHVybiBzY29yZSArIGNvdmVyU2hpZnQubWVtYmVyX2lkIC8gMTAwMDA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RWxpZ2libGVDb3Zlck9wdGlvbnMoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBicmVha3M6IFBsYW5uZXJCcmVha1tdLFxuICB0YXJnZXRCcmVhazogUGxhbm5lckJyZWFrXG4pOiBDb3Zlck9wdGlvbltdIHtcbiAgY29uc3QgdGFyZ2V0ID0gYnJlYWtUYXJnZXRSYW5nZSh0YXJnZXRCcmVhayk7XG4gIGlmICghdGFyZ2V0KSByZXR1cm4gW3sgbWVtYmVySWQ6IG51bGwsIHNjb3JlOiAxMDAwIH1dO1xuXG4gIGNvbnN0IG9wdGlvbnM6IENvdmVyT3B0aW9uW10gPSBbXTtcblxuICBpZiAoaXNBcmVhQ292ZXJlZFdpdGhvdXRBc3NpZ25lZENvdmVyKGNvbnRleHQsIGJyZWFrcywgdGFyZ2V0QnJlYWspKSB7XG4gICAgb3B0aW9ucy5wdXNoKHsgbWVtYmVySWQ6IG51bGwsIHNjb3JlOiAtMjAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IHNoaWZ0IG9mIGNvbnRleHQuc2hpZnRzKSB7XG4gICAgaWYgKHNoaWZ0LnN0YXR1c19rZXkgIT09ICd3b3JraW5nJykgY29udGludWU7XG4gICAgaWYgKHNoaWZ0Lm1lbWJlcl9pZCA9PT0gdGFyZ2V0QnJlYWsub2ZmX21lbWJlcl9pZCkgY29udGludWU7XG4gICAgaWYgKGFjdGl2ZVdvcmtpbmdTaGlmdEZvck1lbWJlcihjb250ZXh0LCBzaGlmdC5tZW1iZXJfaWQsIHRhcmdldCk/LmlkICE9PSBzaGlmdC5pZCkgY29udGludWU7XG4gICAgaWYgKHNoaWZ0LmhvbWVfYXJlYV9rZXkgIT09IHRhcmdldEJyZWFrLm9mZl9hcmVhX2tleSAmJiAhY2FuTWVtYmVyV29ya0FyZWEoY29udGV4dCwgc2hpZnQubWVtYmVyX2lkLCB0YXJnZXRCcmVhay5vZmZfYXJlYV9rZXkpKSBjb250aW51ZTtcbiAgICBpZiAoaGFzQ292ZXJDb25mbGljdChicmVha3MsIHNoaWZ0Lm1lbWJlcl9pZCwgdGFyZ2V0LCB0YXJnZXRCcmVhay5pZCkpIGNvbnRpbnVlO1xuICAgIGlmICh2aW9sYXRlc0FyZWFNaW5pbXVtcyhjb250ZXh0LCBicmVha3MsIHRhcmdldEJyZWFrLCB0YXJnZXQsIHNoaWZ0Lm1lbWJlcl9pZCkpIGNvbnRpbnVlO1xuXG4gICAgb3B0aW9ucy5wdXNoKHtcbiAgICAgIG1lbWJlcklkOiBzaGlmdC5tZW1iZXJfaWQsXG4gICAgICBzY29yZTogY292ZXJPcHRpb25TY29yZShjb250ZXh0LCB0YXJnZXRCcmVhaywgc2hpZnQpXG4gICAgfSk7XG4gIH1cblxuICBvcHRpb25zLnNvcnQoKGEsIGIpID0+IGEuc2NvcmUgLSBiLnNjb3JlKTtcbiAgaWYgKCFvcHRpb25zLnNvbWUoKHJvdykgPT4gcm93Lm1lbWJlcklkID09IG51bGwpKSB7XG4gICAgb3B0aW9ucy5wdXNoKHsgbWVtYmVySWQ6IG51bGwsIHNjb3JlOiAxMDAwIH0pO1xuICB9XG4gIHJldHVybiBvcHRpb25zO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNDb3ZlckFzc2lnbm1lbnRWYWxpZChcbiAgY29udGV4dDogUGxhbm5lckNvbnRleHQsXG4gIGJyZWFrczogUGxhbm5lckJyZWFrW10sXG4gIHRhcmdldEJyZWFrOiBQbGFubmVyQnJlYWssXG4gIGNvdmVyTWVtYmVySWQ6IG51bWJlciB8IG51bGxcbikge1xuICBjb25zdCB0YXJnZXQgPSBicmVha1RhcmdldFJhbmdlKHRhcmdldEJyZWFrKTtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNvdmVyTWVtYmVySWQgPT0gbnVsbCkge1xuICAgIHJldHVybiBpc0FyZWFDb3ZlcmVkV2l0aG91dEFzc2lnbmVkQ292ZXIoY29udGV4dCwgYnJlYWtzLCB0YXJnZXRCcmVhayk7XG4gIH1cbiAgY29uc3QgY292ZXJTaGlmdCA9IGFjdGl2ZVdvcmtpbmdTaGlmdEZvck1lbWJlcihjb250ZXh0LCBjb3Zlck1lbWJlcklkLCB0YXJnZXQpO1xuICBpZiAoIWNvdmVyU2hpZnQpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNvdmVyU2hpZnQuaG9tZV9hcmVhX2tleSAhPT0gdGFyZ2V0QnJlYWsub2ZmX2FyZWFfa2V5ICYmICFjYW5NZW1iZXJXb3JrQXJlYShjb250ZXh0LCBjb3Zlck1lbWJlcklkLCB0YXJnZXRCcmVhay5vZmZfYXJlYV9rZXkpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChoYXNDb3ZlckNvbmZsaWN0KGJyZWFrcywgY292ZXJNZW1iZXJJZCwgdGFyZ2V0LCB0YXJnZXRCcmVhay5pZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHZpb2xhdGVzQXJlYU1pbmltdW1zKGNvbnRleHQsIGJyZWFrcywgdGFyZ2V0QnJlYWssIHRhcmdldCwgY292ZXJNZW1iZXJJZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhc3NpZ25CZXN0Q292ZXJzKFxuICBjb250ZXh0OiBQbGFubmVyQ29udGV4dCxcbiAgbG9ja2VkQnJlYWtzOiBQbGFubmVyQnJlYWtbXSxcbiAgcGVuZGluZ0JyZWFrczogUGxhbm5lckJyZWFrW11cbik6IE1hcDxudW1iZXIsIG51bWJlciB8IG51bGw+IHtcbiAgY29uc3QgYXNzaWdubWVudHMgPSBuZXcgTWFwPG51bWJlciwgbnVtYmVyIHwgbnVsbD4oKTtcbiAgaWYgKHBlbmRpbmdCcmVha3MubGVuZ3RoID09PSAwKSByZXR1cm4gYXNzaWdubWVudHM7XG5cbiAgY29uc3QgcGVuZGluZ0J5SWQgPSBuZXcgTWFwKHBlbmRpbmdCcmVha3MubWFwKChyb3cpID0+IFtyb3cuaWQsIHJvd10pKTtcbiAgbGV0IGJlc3RTY29yZSA9IE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcbiAgbGV0IGJlc3RBc3NpZ25tZW50cyA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXIgfCBudWxsPigpO1xuXG4gIGNvbnN0IHNlYXJjaCA9IChjdXJyZW50QnJlYWtzOiBQbGFubmVyQnJlYWtbXSwgcmVtYWluaW5nSWRzOiBudW1iZXJbXSwgcnVubmluZ1Njb3JlOiBudW1iZXIpID0+IHtcbiAgICBpZiAocnVubmluZ1Njb3JlID49IGJlc3RTY29yZSkgcmV0dXJuO1xuICAgIGlmIChyZW1haW5pbmdJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBiZXN0U2NvcmUgPSBydW5uaW5nU2NvcmU7XG4gICAgICBiZXN0QXNzaWdubWVudHMgPSBuZXcgTWFwKGFzc2lnbm1lbnRzKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsZXQgbmV4dElkID0gcmVtYWluaW5nSWRzWzBdITtcbiAgICBsZXQgbmV4dE9wdGlvbnM6IENvdmVyT3B0aW9uW10gfCBudWxsID0gbnVsbDtcblxuICAgIGZvciAoY29uc3QgYnJlYWtJZCBvZiByZW1haW5pbmdJZHMpIHtcbiAgICAgIGNvbnN0IHJvdyA9IHBlbmRpbmdCeUlkLmdldChicmVha0lkKTtcbiAgICAgIGlmICghcm93KSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG9wdGlvbnMgPSBsaXN0RWxpZ2libGVDb3Zlck9wdGlvbnMoY29udGV4dCwgY3VycmVudEJyZWFrcywgcm93KTtcbiAgICAgIGlmICghbmV4dE9wdGlvbnMgfHwgb3B0aW9ucy5sZW5ndGggPCBuZXh0T3B0aW9ucy5sZW5ndGgpIHtcbiAgICAgICAgbmV4dElkID0gYnJlYWtJZDtcbiAgICAgICAgbmV4dE9wdGlvbnMgPSBvcHRpb25zO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHJvdyA9IHBlbmRpbmdCeUlkLmdldChuZXh0SWQpO1xuICAgIGlmICghcm93IHx8ICFuZXh0T3B0aW9ucykgcmV0dXJuO1xuXG4gICAgY29uc3QgcmVtYWluaW5nQWZ0ZXIgPSByZW1haW5pbmdJZHMuZmlsdGVyKChpZCkgPT4gaWQgIT09IG5leHRJZCk7XG4gICAgZm9yIChjb25zdCBvcHRpb24gb2YgbmV4dE9wdGlvbnMpIHtcbiAgICAgIGFzc2lnbm1lbnRzLnNldChuZXh0SWQsIG9wdGlvbi5tZW1iZXJJZCk7XG4gICAgICBjb25zdCBuZXh0QnJlYWtzID0gY3VycmVudEJyZWFrcy5tYXAoKGl0ZW0pID0+XG4gICAgICAgIGl0ZW0uaWQgPT09IG5leHRJZCA/IHsgLi4uaXRlbSwgY292ZXJfbWVtYmVyX2lkOiBvcHRpb24ubWVtYmVySWQgfSA6IGl0ZW1cbiAgICAgICk7XG4gICAgICBzZWFyY2gobmV4dEJyZWFrcywgcmVtYWluaW5nQWZ0ZXIsIHJ1bm5pbmdTY29yZSArIG9wdGlvbi5zY29yZSk7XG4gICAgfVxuICAgIGFzc2lnbm1lbnRzLmRlbGV0ZShuZXh0SWQpO1xuICB9O1xuXG4gIHNlYXJjaChbLi4ubG9ja2VkQnJlYWtzLCAuLi5wZW5kaW5nQnJlYWtzXSwgcGVuZGluZ0JyZWFrcy5tYXAoKHJvdykgPT4gcm93LmlkKSwgMCk7XG4gIHJldHVybiBiZXN0QXNzaWdubWVudHM7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTs7O0FDRFosU0FBUyxVQUFVLE9BQThCO0FBQ3RELFFBQU0sSUFBSSwrQkFBK0IsS0FBSyxNQUFNLEtBQUssQ0FBQztBQUMxRCxNQUFJLENBQUMsRUFBRyxRQUFPO0FBQ2YsUUFBTSxLQUFLLE9BQU8sRUFBRSxDQUFDLENBQUM7QUFDdEIsUUFBTSxLQUFLLE9BQU8sRUFBRSxDQUFDLENBQUM7QUFDdEIsU0FBTyxLQUFLLEtBQUs7QUFDbkI7OztBQ0lPLFNBQVMsUUFBUSxRQUFnQixNQUFjLFFBQWdCLE1BQXVCO0FBQzNGLFNBQU8sU0FBUyxRQUFRLFNBQVM7QUFDbkM7QUFFTyxTQUFTLGFBQWEsV0FBbUIsaUJBQWdFO0FBQzlHLFFBQU0sSUFBSSxVQUFVLFNBQVM7QUFDN0IsTUFBSSxLQUFLLEtBQU0sUUFBTztBQUN0QixRQUFNLFdBQVcsT0FBTyxlQUFlO0FBQ3ZDLE1BQUksQ0FBQyxPQUFPLFNBQVMsUUFBUSxFQUFHLFFBQU87QUFDdkMsU0FBTyxFQUFFLE9BQU8sR0FBRyxLQUFLLElB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
