// tests/break-generation.test.ts
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
function toHHMM(totalMinutes) {
  const hh = Math.floor(totalMinutes / 60) % 24;
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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

// src/lib/autogen.ts
function generateBreakTemplate(shiftMinutes, preference = "15+30") {
  let template;
  if (shiftMinutes < 4 * 60) {
    template = [];
  } else if (shiftMinutes <= 5 * 60) {
    template = [15];
  } else if (shiftMinutes < 7 * 60) {
    template = [15, 30];
  } else if (shiftMinutes < 10 * 60) {
    template = [15, 30, 15];
  } else {
    template = [15, 30, 15, 30];
  }
  if (preference === "15+30") return template;
  const thirties = template.filter((minutes) => minutes === 30);
  const fifteens = template.filter((minutes) => minutes === 15);
  if (thirties.length === 0) return template;
  if (thirties.length === 1) return [30, ...fifteens];
  return [30, 15, 30, ...fifteens.slice(1)];
}
function proposeBreakTimes(shift, durations, opts) {
  const startMin = parseHHMM(shift.start_time);
  const endMin = shift.end_time ? parseHHMM(shift.end_time) : null;
  if (startMin == null || endMin == null) return [];
  const out = [];
  if (durations.length === 0) return out;
  let previousStart = null;
  const offset = opts?.offsetMinutes ?? 0;
  const existingBreaks = opts?.existingBreaks ?? [];
  const planned = [];
  for (let index = 0; index < durations.length; index += 1) {
    const dur = durations[index];
    const earliestStart = (previousStart ?? startMin) + 120 + (index === 0 ? offset : 0);
    const preferredStart = (previousStart ?? startMin) + 150 + (index === 0 ? offset : 0);
    const latestByCadence = (previousStart ?? startMin) + 180 + (index === 0 ? offset : 0);
    const latestByShift = endMin - dur - 60;
    const latestStart = Math.min(latestByCadence, latestByShift);
    if (latestStart < earliestStart) break;
    let bestStart = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let candidate = earliestStart; candidate <= latestStart; candidate += 15) {
      const candidateBreak = { start_time: toHHMM(candidate), duration_minutes: dur };
      const overlapCount = [...existingBreaks, ...planned].reduce((count, row) => {
        return count + (breaksOverlap(candidateBreak, row) ? 1 : 0);
      }, 0);
      const score = overlapCount * 1e3 + Math.abs(candidate - preferredStart);
      if (score < bestScore) {
        bestScore = score;
        bestStart = candidate;
      }
    }
    if (bestStart == null) break;
    const nextBreak = { start_time: toHHMM(bestStart), duration_minutes: dur };
    out.push(nextBreak);
    planned.push(nextBreak);
    previousStart = bestStart;
  }
  return out;
}
function candidateOffsets(baseOffsetMinutes) {
  return [
    .../* @__PURE__ */ new Set([
      baseOffsetMinutes - 60,
      baseOffsetMinutes - 45,
      baseOffsetMinutes - 30,
      baseOffsetMinutes - 15,
      baseOffsetMinutes,
      baseOffsetMinutes + 15,
      baseOffsetMinutes + 30,
      baseOffsetMinutes + 45
    ])
  ];
}
function rangeFor(b) {
  const s = parseHHMM(b.start_time);
  if (s == null) return null;
  const duration = Number(b.duration_minutes);
  if (!Number.isFinite(duration)) return null;
  return { start: s, end: s + duration };
}
function breaksOverlap(a, b) {
  const ar = rangeFor(a);
  const br = rangeFor(b);
  if (!ar || !br) return false;
  return overlap(ar.start, ar.end, br.start, br.end);
}

// src/lib/work-blocks.ts
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

// src/lib/break-generation.ts
function generateBestBreakPlanForBlock(input) {
  const { block, blockShifts, planner, existingBreaks, excludeWorkBlockId = block.id } = input;
  const durations = generateBreakTemplate(Number(block.total_minutes ?? 0), block.break_preference ?? "15+30");
  const blockAreaKeys = new Set(blockShifts.map((shift) => shift.home_area_key));
  const lockedBreaks = existingBreaks.filter((row) => row.work_block_id !== excludeWorkBlockId);
  let bestPendingBreaks = [];
  let bestAssignments = /* @__PURE__ */ new Map();
  let bestMissingCount = Number.POSITIVE_INFINITY;
  let bestGeneratedCount = -1;
  for (const offset of candidateOffsets(0)) {
    const areaBreaks = lockedBreaks.filter((row) => blockAreaKeys.has(row.off_area_key)).map((row) => ({ start_time: row.start_time, duration_minutes: row.duration_minutes }));
    const proposed = proposeBreakTimes(block, durations, { offsetMinutes: offset, existingBreaks: areaBreaks });
    const pendingBreaks = proposed.flatMap((row, index) => {
      const activeShift = activeShiftAtTime(blockShifts, block.member_id, row.start_time);
      if (!activeShift) return [];
      return [{
        id: -(block.id * 10 + index + 1),
        work_block_id: block.id,
        shift_id: activeShift.id,
        start_time: row.start_time,
        duration_minutes: row.duration_minutes,
        cover_member_id: null,
        off_member_id: block.member_id,
        off_shift_id: activeShift.id,
        off_area_key: activeShift.home_area_key
      }];
    });
    const assignments = assignBestCovers(planner, lockedBreaks, pendingBreaks);
    const candidateBreaks = pendingBreaks.map((row) => ({
      ...row,
      cover_member_id: assignments.get(row.id) ?? null
    }));
    const missingCount = durations.length - pendingBreaks.length + candidateBreaks.reduce(
      (count, row) => count + (isCoverAssignmentValid(planner, [...lockedBreaks, ...candidateBreaks], row, row.cover_member_id) ? 0 : 1),
      0
    );
    if (pendingBreaks.length > bestGeneratedCount || pendingBreaks.length === bestGeneratedCount && missingCount < bestMissingCount) {
      bestPendingBreaks = pendingBreaks;
      bestAssignments = assignments;
      bestMissingCount = missingCount;
      bestGeneratedCount = pendingBreaks.length;
      if (pendingBreaks.length === durations.length && missingCount === 0) break;
    }
  }
  return {
    pendingBreaks: bestPendingBreaks,
    assignments: bestAssignments,
    generatedCount: bestGeneratedCount,
    missingCount: bestMissingCount,
    requestedBreakCount: durations.length
  };
}

// tests/break-generation.test.ts
test("generateBestBreakPlanForBlock maps breaks onto the active shift within a multi-shift work block", () => {
  const planner = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 100,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "09:00"
      },
      {
        id: 2,
        member_id: 100,
        home_area_key: "service-desk",
        status_key: "working",
        shift_role: "normal",
        start_time: "09:00",
        end_time: "13:00"
      },
      {
        id: 3,
        member_id: 200,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "floater",
        start_time: "06:00",
        end_time: "13:00"
      }
    ],
    members: [
      { id: 100, all_areas: 1 },
      { id: 200, all_areas: 1 }
    ],
    perms: [],
    minByArea: /* @__PURE__ */ new Map([
      ["registers", 1],
      ["service-desk", 0]
    ])
  });
  const result = generateBestBreakPlanForBlock({
    block: {
      id: 10,
      member_id: 100,
      start_time: "06:00",
      end_time: "13:00",
      total_minutes: 420,
      break_preference: "15+30"
    },
    blockShifts: [
      {
        id: 1,
        schedule_id: 1,
        member_id: 100,
        status_key: "working",
        home_area_key: "registers",
        start_time: "06:00",
        end_time: "09:00",
        shift_minutes: 180,
        work_block_id: 10
      },
      {
        id: 2,
        schedule_id: 1,
        member_id: 100,
        status_key: "working",
        home_area_key: "service-desk",
        start_time: "09:00",
        end_time: "13:00",
        shift_minutes: 240,
        work_block_id: 10
      }
    ],
    planner,
    existingBreaks: []
  });
  assert.equal(result.pendingBreaks.length, 2);
  assert.equal(result.pendingBreaks[0]?.shift_id, 1);
  assert.equal(result.pendingBreaks[1]?.shift_id, 2);
});
test("generateBestBreakPlanForBlock prefers floater coverage when valid", () => {
  const planner = buildPlannerContext({
    shifts: [
      {
        id: 1,
        member_id: 100,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "normal",
        start_time: "06:00",
        end_time: "12:00"
      },
      {
        id: 2,
        member_id: 200,
        home_area_key: "registers",
        status_key: "working",
        shift_role: "floater",
        start_time: "06:00",
        end_time: "12:00"
      }
    ],
    members: [
      { id: 100, all_areas: 1 },
      { id: 200, all_areas: 1 }
    ],
    perms: [],
    minByArea: /* @__PURE__ */ new Map([["registers", 1]])
  });
  const result = generateBestBreakPlanForBlock({
    block: {
      id: 11,
      member_id: 100,
      start_time: "06:00",
      end_time: "12:00",
      total_minutes: 360,
      break_preference: "15+30"
    },
    blockShifts: [
      {
        id: 1,
        schedule_id: 1,
        member_id: 100,
        status_key: "working",
        home_area_key: "registers",
        start_time: "06:00",
        end_time: "12:00",
        shift_minutes: 360,
        work_block_id: 11
      }
    ],
    planner,
    existingBreaks: []
  });
  assert.ok(result.pendingBreaks.length > 0);
  assert.equal(result.assignments.get(result.pendingBreaks[0].id), 200);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vdGVzdHMvYnJlYWstZ2VuZXJhdGlvbi50ZXN0LnRzIiwgIi4uL3NyYy9saWIvdGltZS50cyIsICIuLi9zcmMvbGliL2JyZWFrcy50cyIsICIuLi9zcmMvbGliL3NoaWZ0cy50cyIsICIuLi9zcmMvbGliL2JyZWFrLXBsYW5uZXIudHMiLCAiLi4vc3JjL2xpYi9hdXRvZ2VuLnRzIiwgIi4uL3NyYy9saWIvd29yay1ibG9ja3MudHMiLCAiLi4vc3JjL2xpYi9icmVhay1nZW5lcmF0aW9uLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuXG5pbXBvcnQgeyBidWlsZFBsYW5uZXJDb250ZXh0IH0gZnJvbSAnLi4vc3JjL2xpYi9icmVhay1wbGFubmVyLnRzJztcbmltcG9ydCB7IGdlbmVyYXRlQmVzdEJyZWFrUGxhbkZvckJsb2NrIH0gZnJvbSAnLi4vc3JjL2xpYi9icmVhay1nZW5lcmF0aW9uLnRzJztcblxudGVzdCgnZ2VuZXJhdGVCZXN0QnJlYWtQbGFuRm9yQmxvY2sgbWFwcyBicmVha3Mgb250byB0aGUgYWN0aXZlIHNoaWZ0IHdpdGhpbiBhIG11bHRpLXNoaWZ0IHdvcmsgYmxvY2snLCAoKSA9PiB7XG4gIGNvbnN0IHBsYW5uZXIgPSBidWlsZFBsYW5uZXJDb250ZXh0KHtcbiAgICBzaGlmdHM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IDEsXG4gICAgICAgIG1lbWJlcl9pZDogMTAwLFxuICAgICAgICBob21lX2FyZWFfa2V5OiAncmVnaXN0ZXJzJyxcbiAgICAgICAgc3RhdHVzX2tleTogJ3dvcmtpbmcnLFxuICAgICAgICBzaGlmdF9yb2xlOiAnbm9ybWFsJyxcbiAgICAgICAgc3RhcnRfdGltZTogJzA2OjAwJyxcbiAgICAgICAgZW5kX3RpbWU6ICcwOTowMCdcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiAyLFxuICAgICAgICBtZW1iZXJfaWQ6IDEwMCxcbiAgICAgICAgaG9tZV9hcmVhX2tleTogJ3NlcnZpY2UtZGVzaycsXG4gICAgICAgIHN0YXR1c19rZXk6ICd3b3JraW5nJyxcbiAgICAgICAgc2hpZnRfcm9sZTogJ25vcm1hbCcsXG4gICAgICAgIHN0YXJ0X3RpbWU6ICcwOTowMCcsXG4gICAgICAgIGVuZF90aW1lOiAnMTM6MDAnXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogMyxcbiAgICAgICAgbWVtYmVyX2lkOiAyMDAsXG4gICAgICAgIGhvbWVfYXJlYV9rZXk6ICdyZWdpc3RlcnMnLFxuICAgICAgICBzdGF0dXNfa2V5OiAnd29ya2luZycsXG4gICAgICAgIHNoaWZ0X3JvbGU6ICdmbG9hdGVyJyxcbiAgICAgICAgc3RhcnRfdGltZTogJzA2OjAwJyxcbiAgICAgICAgZW5kX3RpbWU6ICcxMzowMCdcbiAgICAgIH1cbiAgICBdLFxuICAgIG1lbWJlcnM6IFtcbiAgICAgIHsgaWQ6IDEwMCwgYWxsX2FyZWFzOiAxIH0sXG4gICAgICB7IGlkOiAyMDAsIGFsbF9hcmVhczogMSB9XG4gICAgXSxcbiAgICBwZXJtczogW10sXG4gICAgbWluQnlBcmVhOiBuZXcgTWFwKFtcbiAgICAgIFsncmVnaXN0ZXJzJywgMV0sXG4gICAgICBbJ3NlcnZpY2UtZGVzaycsIDBdXG4gICAgXSlcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gZ2VuZXJhdGVCZXN0QnJlYWtQbGFuRm9yQmxvY2soe1xuICAgIGJsb2NrOiB7XG4gICAgICBpZDogMTAsXG4gICAgICBtZW1iZXJfaWQ6IDEwMCxcbiAgICAgIHN0YXJ0X3RpbWU6ICcwNjowMCcsXG4gICAgICBlbmRfdGltZTogJzEzOjAwJyxcbiAgICAgIHRvdGFsX21pbnV0ZXM6IDQyMCxcbiAgICAgIGJyZWFrX3ByZWZlcmVuY2U6ICcxNSszMCdcbiAgICB9LFxuICAgIGJsb2NrU2hpZnRzOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiAxLFxuICAgICAgICBzY2hlZHVsZV9pZDogMSxcbiAgICAgICAgbWVtYmVyX2lkOiAxMDAsXG4gICAgICAgIHN0YXR1c19rZXk6ICd3b3JraW5nJyxcbiAgICAgICAgaG9tZV9hcmVhX2tleTogJ3JlZ2lzdGVycycsXG4gICAgICAgIHN0YXJ0X3RpbWU6ICcwNjowMCcsXG4gICAgICAgIGVuZF90aW1lOiAnMDk6MDAnLFxuICAgICAgICBzaGlmdF9taW51dGVzOiAxODAsXG4gICAgICAgIHdvcmtfYmxvY2tfaWQ6IDEwXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogMixcbiAgICAgICAgc2NoZWR1bGVfaWQ6IDEsXG4gICAgICAgIG1lbWJlcl9pZDogMTAwLFxuICAgICAgICBzdGF0dXNfa2V5OiAnd29ya2luZycsXG4gICAgICAgIGhvbWVfYXJlYV9rZXk6ICdzZXJ2aWNlLWRlc2snLFxuICAgICAgICBzdGFydF90aW1lOiAnMDk6MDAnLFxuICAgICAgICBlbmRfdGltZTogJzEzOjAwJyxcbiAgICAgICAgc2hpZnRfbWludXRlczogMjQwLFxuICAgICAgICB3b3JrX2Jsb2NrX2lkOiAxMFxuICAgICAgfVxuICAgIF0sXG4gICAgcGxhbm5lcixcbiAgICBleGlzdGluZ0JyZWFrczogW11cbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wZW5kaW5nQnJlYWtzLmxlbmd0aCwgMik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucGVuZGluZ0JyZWFrc1swXT8uc2hpZnRfaWQsIDEpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnBlbmRpbmdCcmVha3NbMV0/LnNoaWZ0X2lkLCAyKTtcbn0pO1xuXG50ZXN0KCdnZW5lcmF0ZUJlc3RCcmVha1BsYW5Gb3JCbG9jayBwcmVmZXJzIGZsb2F0ZXIgY292ZXJhZ2Ugd2hlbiB2YWxpZCcsICgpID0+IHtcbiAgY29uc3QgcGxhbm5lciA9IGJ1aWxkUGxhbm5lckNvbnRleHQoe1xuICAgIHNoaWZ0czogW1xuICAgICAge1xuICAgICAgICBpZDogMSxcbiAgICAgICAgbWVtYmVyX2lkOiAxMDAsXG4gICAgICAgIGhvbWVfYXJlYV9rZXk6ICdyZWdpc3RlcnMnLFxuICAgICAgICBzdGF0dXNfa2V5OiAnd29ya2luZycsXG4gICAgICAgIHNoaWZ0X3JvbGU6ICdub3JtYWwnLFxuICAgICAgICBzdGFydF90aW1lOiAnMDY6MDAnLFxuICAgICAgICBlbmRfdGltZTogJzEyOjAwJ1xuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IDIsXG4gICAgICAgIG1lbWJlcl9pZDogMjAwLFxuICAgICAgICBob21lX2FyZWFfa2V5OiAncmVnaXN0ZXJzJyxcbiAgICAgICAgc3RhdHVzX2tleTogJ3dvcmtpbmcnLFxuICAgICAgICBzaGlmdF9yb2xlOiAnZmxvYXRlcicsXG4gICAgICAgIHN0YXJ0X3RpbWU6ICcwNjowMCcsXG4gICAgICAgIGVuZF90aW1lOiAnMTI6MDAnXG4gICAgICB9XG4gICAgXSxcbiAgICBtZW1iZXJzOiBbXG4gICAgICB7IGlkOiAxMDAsIGFsbF9hcmVhczogMSB9LFxuICAgICAgeyBpZDogMjAwLCBhbGxfYXJlYXM6IDEgfVxuICAgIF0sXG4gICAgcGVybXM6IFtdLFxuICAgIG1pbkJ5QXJlYTogbmV3IE1hcChbWydyZWdpc3RlcnMnLCAxXV0pXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGdlbmVyYXRlQmVzdEJyZWFrUGxhbkZvckJsb2NrKHtcbiAgICBibG9jazoge1xuICAgICAgaWQ6IDExLFxuICAgICAgbWVtYmVyX2lkOiAxMDAsXG4gICAgICBzdGFydF90aW1lOiAnMDY6MDAnLFxuICAgICAgZW5kX3RpbWU6ICcxMjowMCcsXG4gICAgICB0b3RhbF9taW51dGVzOiAzNjAsXG4gICAgICBicmVha19wcmVmZXJlbmNlOiAnMTUrMzAnXG4gICAgfSxcbiAgICBibG9ja1NoaWZ0czogW1xuICAgICAge1xuICAgICAgICBpZDogMSxcbiAgICAgICAgc2NoZWR1bGVfaWQ6IDEsXG4gICAgICAgIG1lbWJlcl9pZDogMTAwLFxuICAgICAgICBzdGF0dXNfa2V5OiAnd29ya2luZycsXG4gICAgICAgIGhvbWVfYXJlYV9rZXk6ICdyZWdpc3RlcnMnLFxuICAgICAgICBzdGFydF90aW1lOiAnMDY6MDAnLFxuICAgICAgICBlbmRfdGltZTogJzEyOjAwJyxcbiAgICAgICAgc2hpZnRfbWludXRlczogMzYwLFxuICAgICAgICB3b3JrX2Jsb2NrX2lkOiAxMVxuICAgICAgfVxuICAgIF0sXG4gICAgcGxhbm5lcixcbiAgICBleGlzdGluZ0JyZWFrczogW11cbiAgfSk7XG5cbiAgYXNzZXJ0Lm9rKHJlc3VsdC5wZW5kaW5nQnJlYWtzLmxlbmd0aCA+IDApO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFzc2lnbm1lbnRzLmdldChyZXN1bHQucGVuZGluZ0JyZWFrc1swXSEuaWQpLCAyMDApO1xufSk7XG4iLCAiZXhwb3J0IGZ1bmN0aW9uIHBhcnNlSEhNTSh2YWx1ZTogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IG0gPSAvXihbMDFdP1xcZHwyWzAtM10pOihbMC01XVxcZCkkLy5leGVjKHZhbHVlLnRyaW0oKSk7XG4gIGlmICghbSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhoID0gTnVtYmVyKG1bMV0pO1xuICBjb25zdCBtbSA9IE51bWJlcihtWzJdKTtcbiAgcmV0dXJuIGhoICogNjAgKyBtbTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdER1cmF0aW9uTWludXRlcyh0b3RhbDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3Qgc2lnbiA9IHRvdGFsIDwgMCA/ICctJyA6ICcnO1xuICBjb25zdCBtID0gTWF0aC5hYnModG90YWwpO1xuICBjb25zdCBoID0gTWF0aC5mbG9vcihtIC8gNjApO1xuICBjb25zdCByID0gbSAlIDYwO1xuICBpZiAoaCA9PT0gMCkgcmV0dXJuIGAke3NpZ259JHtyfW1gO1xuICBpZiAociA9PT0gMCkgcmV0dXJuIGAke3NpZ259JHtofWhgO1xuICByZXR1cm4gYCR7c2lnbn0ke2h9aCAke3J9bWA7XG59XG5cbi8vIEJyaXNiYW5lIGlzIFVUQysxMCB3aXRoIG5vIERTVC5cbmNvbnN0IEJSSVNCQU5FX09GRlNFVCA9ICcrMTA6MDAnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGF5VHlwZUZvckRhdGUoZGF0ZVlZWVlNTUREOiBzdHJpbmcpOiAnd2Vla2RheScgfCAnd2Vla2VuZCcgfCBudWxsIHtcbiAgaWYgKCEvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdChkYXRlWVlZWU1NREQpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZCA9IG5ldyBEYXRlKGAke2RhdGVZWVlZTU1ERH1UMDA6MDA6MDAke0JSSVNCQU5FX09GRlNFVH1gKTtcbiAgY29uc3QgZG93ID0gZC5nZXRVVENEYXkoKTtcbiAgLy8gMCBTdW4sIDYgU2F0XG4gIHJldHVybiBkb3cgPT09IDAgfHwgZG93ID09PSA2ID8gJ3dlZWtlbmQnIDogJ3dlZWtkYXknO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdG9ISE1NKHRvdGFsTWludXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgaGggPSBNYXRoLmZsb29yKHRvdGFsTWludXRlcyAvIDYwKSAlIDI0O1xuICBjb25zdCBtbSA9IHRvdGFsTWludXRlcyAlIDYwO1xuICByZXR1cm4gYCR7U3RyaW5nKGhoKS5wYWRTdGFydCgyLCAnMCcpfToke1N0cmluZyhtbSkucGFkU3RhcnQoMiwgJzAnKX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gb3BlcmF0aW5nSG91cnNGb3IoZGF0ZVlZWVlNTUREOiBzdHJpbmcpOiB7IG9wZW46IG51bWJlcjsgY2xvc2U6IG51bWJlciB9IHwgbnVsbCB7XG4gIGNvbnN0IGR0ID0gZGF5VHlwZUZvckRhdGUoZGF0ZVlZWVlNTUREKTtcbiAgaWYgKCFkdCkgcmV0dXJuIG51bGw7XG4gIC8vIHdlZWtlbmQgMDY6MDAtMTk6MTUsIHdlZWtkYXkgMDY6MDAtMjE6MTVcbiAgcmV0dXJuIGR0ID09PSAnd2Vla2VuZCdcbiAgICA/IHsgb3BlbjogNiAqIDYwLCBjbG9zZTogMTkgKiA2MCArIDE1IH1cbiAgICA6IHsgb3BlbjogNiAqIDYwLCBjbG9zZTogMjEgKiA2MCArIDE1IH07XG59XG4iLCAiaW1wb3J0IHsgcGFyc2VISE1NIH0gZnJvbSAnLi90aW1lJztcblxuZXhwb3J0IGZ1bmN0aW9uIGJyZWFrQWxsb3dhbmNlTWludXRlcyhzaGlmdE1pbnV0ZXM6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChzaGlmdE1pbnV0ZXMgPCA0ICogNjApIHJldHVybiAwO1xuICBpZiAoc2hpZnRNaW51dGVzIDw9IDUgKiA2MCkgcmV0dXJuIDE1O1xuICBpZiAoc2hpZnRNaW51dGVzIDwgNyAqIDYwKSByZXR1cm4gNDU7XG4gIGlmIChzaGlmdE1pbnV0ZXMgPCAxMCAqIDYwKSByZXR1cm4gNjA7XG4gIHJldHVybiA5MDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG92ZXJsYXAoYVN0YXJ0OiBudW1iZXIsIGFFbmQ6IG51bWJlciwgYlN0YXJ0OiBudW1iZXIsIGJFbmQ6IG51bWJlcik6IGJvb2xlYW4ge1xuICByZXR1cm4gYVN0YXJ0IDwgYkVuZCAmJiBiU3RhcnQgPCBhRW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWludXRlc1JhbmdlKHN0YXJ0SEhNTTogc3RyaW5nLCBkdXJhdGlvbk1pbnV0ZXM6IG51bWJlcik6IHsgc3RhcnQ6IG51bWJlcjsgZW5kOiBudW1iZXIgfSB8IG51bGwge1xuICBjb25zdCBzID0gcGFyc2VISE1NKHN0YXJ0SEhNTSk7XG4gIGlmIChzID09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zdCBkdXJhdGlvbiA9IE51bWJlcihkdXJhdGlvbk1pbnV0ZXMpO1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShkdXJhdGlvbikpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBzdGFydDogcywgZW5kOiBzICsgZHVyYXRpb24gfTtcbn1cbiIsICJpbXBvcnQgeyBwYXJzZUhITU0gfSBmcm9tICcuL3RpbWUnO1xuXG5leHBvcnQgdHlwZSBTaGlmdFRpbWVMaWtlID0ge1xuICBpZD86IG51bWJlcjtcbiAgbWVtYmVyX2lkOiBudW1iZXI7XG4gIGhvbWVfYXJlYV9rZXk6IHN0cmluZztcbiAgc3RhdHVzX2tleTogc3RyaW5nO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGVuZF90aW1lOiBzdHJpbmcgfCBudWxsO1xufTtcblxuZXhwb3J0IHR5cGUgTWludXRlUmFuZ2UgPSB7XG4gIHN0YXJ0OiBudW1iZXI7XG4gIGVuZDogbnVtYmVyO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHNoaWZ0UmFuZ2Uoc2hpZnQ6IFBpY2s8U2hpZnRUaW1lTGlrZSwgJ3N0YXJ0X3RpbWUnIHwgJ2VuZF90aW1lJz4pOiBNaW51dGVSYW5nZSB8IG51bGwge1xuICBjb25zdCBzdGFydCA9IHBhcnNlSEhNTShzaGlmdC5zdGFydF90aW1lKTtcbiAgY29uc3QgZW5kID0gc2hpZnQuZW5kX3RpbWUgPyBwYXJzZUhITU0oc2hpZnQuZW5kX3RpbWUpIDogbnVsbDtcbiAgaWYgKHN0YXJ0ID09IG51bGwgfHwgZW5kID09IG51bGwgfHwgZW5kIDw9IHN0YXJ0KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc3RhcnQsIGVuZCB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmFuZ2VzT3ZlcmxhcChhOiBNaW51dGVSYW5nZSwgYjogTWludXRlUmFuZ2UpOiBib29sZWFuIHtcbiAgcmV0dXJuIGEuc3RhcnQgPCBiLmVuZCAmJiBiLnN0YXJ0IDwgYS5lbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kT3ZlcmxhcHBpbmdTaGlmdChcbiAgc2hpZnRzOiBBcnJheTxTaGlmdFRpbWVMaWtlPixcbiAgdGFyZ2V0OiBNaW51dGVSYW5nZSxcbiAgb3B0cz86IHsgZXhjbHVkZVNoaWZ0SWQ/OiBudW1iZXIgfVxuKTogU2hpZnRUaW1lTGlrZSB8IG51bGwge1xuICBjb25zdCBleGNsdWRlU2hpZnRJZCA9IG9wdHM/LmV4Y2x1ZGVTaGlmdElkID8/IG51bGw7XG4gIGZvciAoY29uc3Qgc2hpZnQgb2Ygc2hpZnRzKSB7XG4gICAgaWYgKGV4Y2x1ZGVTaGlmdElkICE9IG51bGwgJiYgc2hpZnQuaWQgPT09IGV4Y2x1ZGVTaGlmdElkKSBjb250aW51ZTtcbiAgICBjb25zdCByYW5nZSA9IHNoaWZ0UmFuZ2Uoc2hpZnQpO1xuICAgIGlmICghcmFuZ2UpIGNvbnRpbnVlO1xuICAgIGlmIChyYW5nZXNPdmVybGFwKHJhbmdlLCB0YXJnZXQpKSByZXR1cm4gc2hpZnQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzaGlmdHNBY3RpdmVJblJhbmdlKHNoaWZ0czogQXJyYXk8U2hpZnRUaW1lTGlrZT4sIHRhcmdldDogTWludXRlUmFuZ2UsIG9wdHM/OiB7IHdvcmtpbmdPbmx5PzogYm9vbGVhbiB9KSB7XG4gIHJldHVybiBzaGlmdHMuZmlsdGVyKChzaGlmdCkgPT4ge1xuICAgIGlmIChvcHRzPy53b3JraW5nT25seSAmJiBzaGlmdC5zdGF0dXNfa2V5ICE9PSAnd29ya2luZycpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCByYW5nZSA9IHNoaWZ0UmFuZ2Uoc2hpZnQpO1xuICAgIHJldHVybiBCb29sZWFuKHJhbmdlICYmIHJhbmdlc092ZXJsYXAocmFuZ2UsIHRhcmdldCkpO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpcnN0QWN0aXZlU2hpZnRJblJhbmdlKFxuICBzaGlmdHM6IEFycmF5PFNoaWZ0VGltZUxpa2U+LFxuICB0YXJnZXQ6IE1pbnV0ZVJhbmdlLFxuICBvcHRzPzogeyB3b3JraW5nT25seT86IGJvb2xlYW4gfVxuKSB7XG4gIHJldHVybiBzaGlmdHNBY3RpdmVJblJhbmdlKHNoaWZ0cywgdGFyZ2V0LCBvcHRzKVswXSA/PyBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY291bnRXb3JraW5nU2hpZnRzQnlBcmVhSW5SYW5nZShzaGlmdHM6IEFycmF5PFNoaWZ0VGltZUxpa2U+LCB0YXJnZXQ6IE1pbnV0ZVJhbmdlKSB7XG4gIGNvbnN0IGNvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3Qgc2hpZnQgb2Ygc2hpZnRzKSB7XG4gICAgaWYgKHNoaWZ0LnN0YXR1c19rZXkgIT09ICd3b3JraW5nJykgY29udGludWU7XG4gICAgY29uc3QgcmFuZ2UgPSBzaGlmdFJhbmdlKHNoaWZ0KTtcbiAgICBpZiAoIXJhbmdlIHx8ICFyYW5nZXNPdmVybGFwKHJhbmdlLCB0YXJnZXQpKSBjb250aW51ZTtcbiAgICBjb3VudHMuc2V0KHNoaWZ0LmhvbWVfYXJlYV9rZXksIChjb3VudHMuZ2V0KHNoaWZ0LmhvbWVfYXJlYV9rZXkpID8/IDApICsgMSk7XG4gIH1cbiAgcmV0dXJuIGNvdW50cztcbn1cbiIsICJpbXBvcnQgeyBvdmVybGFwLCBtaW51dGVzUmFuZ2UgfSBmcm9tICcuL2JyZWFrcyc7XG5pbXBvcnQgeyBjb3VudFdvcmtpbmdTaGlmdHNCeUFyZWFJblJhbmdlLCBmaXJzdEFjdGl2ZVNoaWZ0SW5SYW5nZSB9IGZyb20gJy4vc2hpZnRzJztcblxuZXhwb3J0IHR5cGUgUGxhbm5lclNoaWZ0ID0ge1xuICBpZDogbnVtYmVyO1xuICBtZW1iZXJfaWQ6IG51bWJlcjtcbiAgaG9tZV9hcmVhX2tleTogc3RyaW5nO1xuICBzdGF0dXNfa2V5OiBzdHJpbmc7XG4gIHNoaWZ0X3JvbGU/OiBzdHJpbmc7XG4gIHN0YXJ0X3RpbWU6IHN0cmluZztcbiAgZW5kX3RpbWU6IHN0cmluZyB8IG51bGw7XG59O1xuXG5leHBvcnQgdHlwZSBQbGFubmVyQnJlYWsgPSB7XG4gIGlkOiBudW1iZXI7XG4gIHdvcmtfYmxvY2tfaWQ6IG51bWJlciB8IG51bGw7XG4gIHNoaWZ0X2lkOiBudW1iZXI7XG4gIHN0YXJ0X3RpbWU6IHN0cmluZztcbiAgZHVyYXRpb25fbWludXRlczogbnVtYmVyO1xuICBjb3Zlcl9tZW1iZXJfaWQ6IG51bWJlciB8IG51bGw7XG4gIG9mZl9tZW1iZXJfaWQ6IG51bWJlcjtcbiAgb2ZmX3NoaWZ0X2lkPzogbnVtYmVyO1xuICBvZmZfYXJlYV9rZXk6IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIFBsYW5uZXJNZW1iZXIgPSB7XG4gIGlkOiBudW1iZXI7XG4gIGFsbF9hcmVhczogbnVtYmVyO1xufTtcblxuZXhwb3J0IHR5cGUgUGxhbm5lckNvbnRleHQgPSB7XG4gIHNoaWZ0czogUGxhbm5lclNoaWZ0W107XG4gIHNoaWZ0c0J5TWVtYmVyOiBNYXA8bnVtYmVyLCBQbGFubmVyU2hpZnRbXT47XG4gIG1lbWJlckJ5SWQ6IE1hcDxudW1iZXIsIFBsYW5uZXJNZW1iZXI+O1xuICBwZXJtc0J5TWVtYmVyOiBNYXA8bnVtYmVyLCBTZXQ8c3RyaW5nPj47XG4gIG1pbkJ5QXJlYTogTWFwPHN0cmluZywgbnVtYmVyPjtcbiAgcHJlZmVycmVkUmFua0J5U2hpZnRJZDogTWFwPG51bWJlciwgTWFwPG51bWJlciwgbnVtYmVyPj47XG59O1xuXG50eXBlIENvdmVyT3B0aW9uID0ge1xuICBtZW1iZXJJZDogbnVtYmVyIHwgbnVsbDtcbiAgc2NvcmU6IG51bWJlcjtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFBsYW5uZXJDb250ZXh0KGlucHV0OiB7XG4gIHNoaWZ0czogUGxhbm5lclNoaWZ0W107XG4gIG1lbWJlcnM6IFBsYW5uZXJNZW1iZXJbXTtcbiAgcGVybXM6IEFycmF5PHsgbWVtYmVyX2lkOiBudW1iZXI7IGFyZWFfa2V5OiBzdHJpbmcgfT47XG4gIG1pbkJ5QXJlYTogTWFwPHN0cmluZywgbnVtYmVyPjtcbiAgcHJlZmVycmVkUmFua0J5U2hpZnRJZD86IE1hcDxudW1iZXIsIE1hcDxudW1iZXIsIG51bWJlcj4+O1xufSk6IFBsYW5uZXJDb250ZXh0IHtcbiAgY29uc3Qgc2hpZnRzQnlNZW1iZXIgPSBuZXcgTWFwPG51bWJlciwgUGxhbm5lclNoaWZ0W10+KCk7XG4gIGZvciAoY29uc3Qgc2hpZnQgb2YgaW5wdXQuc2hpZnRzKSB7XG4gICAgY29uc3Qgcm93cyA9IHNoaWZ0c0J5TWVtYmVyLmdldChzaGlmdC5tZW1iZXJfaWQpID8/IFtdO1xuICAgIHJvd3MucHVzaChzaGlmdCk7XG4gICAgc2hpZnRzQnlNZW1iZXIuc2V0KHNoaWZ0Lm1lbWJlcl9pZCwgcm93cyk7XG4gIH1cblxuICBjb25zdCBtZW1iZXJCeUlkID0gbmV3IE1hcChpbnB1dC5tZW1iZXJzLm1hcCgobWVtYmVyKSA9PiBbbWVtYmVyLmlkLCBtZW1iZXJdKSk7XG4gIGNvbnN0IHBlcm1zQnlNZW1iZXIgPSBuZXcgTWFwPG51bWJlciwgU2V0PHN0cmluZz4+KCk7XG4gIGZvciAoY29uc3QgcGVybSBvZiBpbnB1dC5wZXJtcykge1xuICAgIGNvbnN0IHJvd3MgPSBwZXJtc0J5TWVtYmVyLmdldChwZXJtLm1lbWJlcl9pZCkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgcm93cy5hZGQocGVybS5hcmVhX2tleSk7XG4gICAgcGVybXNCeU1lbWJlci5zZXQocGVybS5tZW1iZXJfaWQsIHJvd3MpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzaGlmdHM6IGlucHV0LnNoaWZ0cyxcbiAgICBzaGlmdHNCeU1lbWJlcixcbiAgICBtZW1iZXJCeUlkLFxuICAgIHBlcm1zQnlNZW1iZXIsXG4gICAgbWluQnlBcmVhOiBpbnB1dC5taW5CeUFyZWEsXG4gICAgcHJlZmVycmVkUmFua0J5U2hpZnRJZDogaW5wdXQucHJlZmVycmVkUmFua0J5U2hpZnRJZCA/PyBuZXcgTWFwKClcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJyZWFrVGFyZ2V0UmFuZ2Uocm93OiBQaWNrPFBsYW5uZXJCcmVhaywgJ3N0YXJ0X3RpbWUnIHwgJ2R1cmF0aW9uX21pbnV0ZXMnPikge1xuICByZXR1cm4gbWludXRlc1JhbmdlKHJvdy5zdGFydF90aW1lLCBOdW1iZXIocm93LmR1cmF0aW9uX21pbnV0ZXMpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNhbk1lbWJlcldvcmtBcmVhKGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LCBtZW1iZXJJZDogbnVtYmVyLCBhcmVhS2V5OiBzdHJpbmcpIHtcbiAgY29uc3QgbWVtYmVyID0gY29udGV4dC5tZW1iZXJCeUlkLmdldChtZW1iZXJJZCk7XG4gIGlmICghbWVtYmVyKSByZXR1cm4gZmFsc2U7XG4gIGlmIChOdW1iZXIobWVtYmVyLmFsbF9hcmVhcykgPT09IDEpIHJldHVybiB0cnVlO1xuICByZXR1cm4gQm9vbGVhbihjb250ZXh0LnBlcm1zQnlNZW1iZXIuZ2V0KG1lbWJlcklkKT8uaGFzKGFyZWFLZXkpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFjdGl2ZVdvcmtpbmdTaGlmdEZvck1lbWJlcihcbiAgY29udGV4dDogUGxhbm5lckNvbnRleHQsXG4gIG1lbWJlcklkOiBudW1iZXIsXG4gIHRhcmdldDogeyBzdGFydDogbnVtYmVyOyBlbmQ6IG51bWJlciB9XG4pIHtcbiAgcmV0dXJuIGZpcnN0QWN0aXZlU2hpZnRJblJhbmdlKGNvbnRleHQuc2hpZnRzQnlNZW1iZXIuZ2V0KG1lbWJlcklkKSA/PyBbXSwgdGFyZ2V0LCB7IHdvcmtpbmdPbmx5OiB0cnVlIH0pIGFzIFBsYW5uZXJTaGlmdCB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBoYXNDb3ZlckNvbmZsaWN0KFxuICBicmVha3M6IFBsYW5uZXJCcmVha1tdLFxuICBtZW1iZXJJZDogbnVtYmVyLFxuICB0YXJnZXQ6IHsgc3RhcnQ6IG51bWJlcjsgZW5kOiBudW1iZXIgfSxcbiAgZXhjbHVkZUJyZWFrSWQ/OiBudW1iZXJcbikge1xuICBmb3IgKGNvbnN0IHJvdyBvZiBicmVha3MpIHtcbiAgICBpZiAoZXhjbHVkZUJyZWFrSWQgIT0gbnVsbCAmJiByb3cuaWQgPT09IGV4Y2x1ZGVCcmVha0lkKSBjb250aW51ZTtcbiAgICBjb25zdCByYW5nZSA9IGJyZWFrVGFyZ2V0UmFuZ2Uocm93KTtcbiAgICBpZiAoIXJhbmdlKSBjb250aW51ZTtcbiAgICBpZiAocm93LmNvdmVyX21lbWJlcl9pZCA9PT0gbWVtYmVySWQgJiYgb3ZlcmxhcCh0YXJnZXQuc3RhcnQsIHRhcmdldC5lbmQsIHJhbmdlLnN0YXJ0LCByYW5nZS5lbmQpKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAocm93Lm9mZl9tZW1iZXJfaWQgPT09IG1lbWJlcklkICYmIG92ZXJsYXAodGFyZ2V0LnN0YXJ0LCB0YXJnZXQuZW5kLCByYW5nZS5zdGFydCwgcmFuZ2UuZW5kKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdmlvbGF0ZXNBcmVhTWluaW11bXMoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBicmVha3M6IFBsYW5uZXJCcmVha1tdLFxuICB0YXJnZXRCcmVhazogUGxhbm5lckJyZWFrLFxuICB0YXJnZXQ6IHsgc3RhcnQ6IG51bWJlcjsgZW5kOiBudW1iZXIgfSxcbiAgY292ZXJNZW1iZXJJZDogbnVtYmVyIHwgbnVsbFxuKSB7XG4gIGNvbnN0IGNvdW50cyA9IGNvdW50V29ya2luZ1NoaWZ0c0J5QXJlYUluUmFuZ2UoY29udGV4dC5zaGlmdHMsIHRhcmdldCk7XG4gIGNvbnN0IG92ZXJsYXBwaW5nQnJlYWtzID0gYnJlYWtzLmZpbHRlcigocm93KSA9PiB7XG4gICAgY29uc3QgcmFuZ2UgPSBicmVha1RhcmdldFJhbmdlKHJvdyk7XG4gICAgaWYgKCFyYW5nZSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBvdmVybGFwKHRhcmdldC5zdGFydCwgdGFyZ2V0LmVuZCwgcmFuZ2Uuc3RhcnQsIHJhbmdlLmVuZCk7XG4gIH0pO1xuXG4gIGZvciAoY29uc3Qgcm93IG9mIG92ZXJsYXBwaW5nQnJlYWtzKSB7XG4gICAgY29uc3QgbmV4dENvdmVyTWVtYmVySWQgPSByb3cuaWQgPT09IHRhcmdldEJyZWFrLmlkID8gY292ZXJNZW1iZXJJZCA6IHJvdy5jb3Zlcl9tZW1iZXJfaWQ7XG4gICAgY291bnRzLnNldChyb3cub2ZmX2FyZWFfa2V5LCAoY291bnRzLmdldChyb3cub2ZmX2FyZWFfa2V5KSA/PyAwKSAtIDEpO1xuXG4gICAgaWYgKG5leHRDb3Zlck1lbWJlcklkID09IG51bGwpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvdmVyU2hpZnQgPSBhY3RpdmVXb3JraW5nU2hpZnRGb3JNZW1iZXIoY29udGV4dCwgbmV4dENvdmVyTWVtYmVySWQsIHRhcmdldCk7XG4gICAgaWYgKCFjb3ZlclNoaWZ0KSBjb250aW51ZTtcbiAgICBpZiAoY292ZXJTaGlmdC5ob21lX2FyZWFfa2V5ICE9PSByb3cub2ZmX2FyZWFfa2V5KSB7XG4gICAgICBjb3VudHMuc2V0KGNvdmVyU2hpZnQuaG9tZV9hcmVhX2tleSwgKGNvdW50cy5nZXQoY292ZXJTaGlmdC5ob21lX2FyZWFfa2V5KSA/PyAwKSAtIDEpO1xuICAgICAgY291bnRzLnNldChyb3cub2ZmX2FyZWFfa2V5LCAoY291bnRzLmdldChyb3cub2ZmX2FyZWFfa2V5KSA/PyAwKSArIDEpO1xuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3QgW2FyZWFLZXksIGFjdGl2ZUNvdW50XSBvZiBjb3VudHMuZW50cmllcygpKSB7XG4gICAgaWYgKGFjdGl2ZUNvdW50IDw9IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IG1pblN0YWZmID0gY29udGV4dC5taW5CeUFyZWEuZ2V0KGFyZWFLZXkpID8/IDA7XG4gICAgaWYgKChjb3VudHMuZ2V0KGFyZWFLZXkpID8/IDApIDwgbWluU3RhZmYpIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQXJlYUNvdmVyZWRXaXRob3V0QXNzaWduZWRDb3ZlcihcbiAgY29udGV4dDogUGxhbm5lckNvbnRleHQsXG4gIGJyZWFrczogUGxhbm5lckJyZWFrW10sXG4gIHRhcmdldEJyZWFrOiBQbGFubmVyQnJlYWtcbikge1xuICBjb25zdCB0YXJnZXQgPSBicmVha1RhcmdldFJhbmdlKHRhcmdldEJyZWFrKTtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuICF2aW9sYXRlc0FyZWFNaW5pbXVtcyhjb250ZXh0LCBicmVha3MsIHRhcmdldEJyZWFrLCB0YXJnZXQsIG51bGwpO1xufVxuXG5mdW5jdGlvbiBjb3Zlck9wdGlvblNjb3JlKFxuICBjb250ZXh0OiBQbGFubmVyQ29udGV4dCxcbiAgdGFyZ2V0QnJlYWs6IFBsYW5uZXJCcmVhayxcbiAgY292ZXJTaGlmdDogUGxhbm5lclNoaWZ0XG4pIHtcbiAgY29uc3QgcHJlZmVycmVkUmFua3MgPSBjb250ZXh0LnByZWZlcnJlZFJhbmtCeVNoaWZ0SWQuZ2V0KHRhcmdldEJyZWFrLnNoaWZ0X2lkKSA/PyBuZXcgTWFwPG51bWJlciwgbnVtYmVyPigpO1xuICBjb25zdCBwcmVmZXJyZWRSYW5rID0gcHJlZmVycmVkUmFua3MuZ2V0KGNvdmVyU2hpZnQubWVtYmVyX2lkKTtcbiAgbGV0IHNjb3JlID0gMDtcblxuICBpZiAoKGNvdmVyU2hpZnQuc2hpZnRfcm9sZSA/PyAnbm9ybWFsJykgPT09ICdmbG9hdGVyJykge1xuICAgIHNjb3JlIC09IDEyMDtcbiAgfVxuXG4gIGlmIChwcmVmZXJyZWRSYW5rID09IG51bGwpIHtcbiAgICBzY29yZSArPSA0MDtcbiAgfSBlbHNlIHtcbiAgICBzY29yZSArPSBwcmVmZXJyZWRSYW5rICogNDtcbiAgfVxuXG4gIGlmIChjb3ZlclNoaWZ0LmhvbWVfYXJlYV9rZXkgIT09IHRhcmdldEJyZWFrLm9mZl9hcmVhX2tleSkgc2NvcmUgKz0gMTI7XG5cbiAgcmV0dXJuIHNjb3JlICsgY292ZXJTaGlmdC5tZW1iZXJfaWQgLyAxMDAwMDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxpc3RFbGlnaWJsZUNvdmVyT3B0aW9ucyhcbiAgY29udGV4dDogUGxhbm5lckNvbnRleHQsXG4gIGJyZWFrczogUGxhbm5lckJyZWFrW10sXG4gIHRhcmdldEJyZWFrOiBQbGFubmVyQnJlYWtcbik6IENvdmVyT3B0aW9uW10ge1xuICBjb25zdCB0YXJnZXQgPSBicmVha1RhcmdldFJhbmdlKHRhcmdldEJyZWFrKTtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiBbeyBtZW1iZXJJZDogbnVsbCwgc2NvcmU6IDEwMDAgfV07XG5cbiAgY29uc3Qgb3B0aW9uczogQ292ZXJPcHRpb25bXSA9IFtdO1xuXG4gIGlmIChpc0FyZWFDb3ZlcmVkV2l0aG91dEFzc2lnbmVkQ292ZXIoY29udGV4dCwgYnJlYWtzLCB0YXJnZXRCcmVhaykpIHtcbiAgICBvcHRpb25zLnB1c2goeyBtZW1iZXJJZDogbnVsbCwgc2NvcmU6IC0yMCB9KTtcbiAgfVxuXG4gIGZvciAoY29uc3Qgc2hpZnQgb2YgY29udGV4dC5zaGlmdHMpIHtcbiAgICBpZiAoc2hpZnQuc3RhdHVzX2tleSAhPT0gJ3dvcmtpbmcnKSBjb250aW51ZTtcbiAgICBpZiAoc2hpZnQubWVtYmVyX2lkID09PSB0YXJnZXRCcmVhay5vZmZfbWVtYmVyX2lkKSBjb250aW51ZTtcbiAgICBpZiAoYWN0aXZlV29ya2luZ1NoaWZ0Rm9yTWVtYmVyKGNvbnRleHQsIHNoaWZ0Lm1lbWJlcl9pZCwgdGFyZ2V0KT8uaWQgIT09IHNoaWZ0LmlkKSBjb250aW51ZTtcbiAgICBpZiAoc2hpZnQuaG9tZV9hcmVhX2tleSAhPT0gdGFyZ2V0QnJlYWsub2ZmX2FyZWFfa2V5ICYmICFjYW5NZW1iZXJXb3JrQXJlYShjb250ZXh0LCBzaGlmdC5tZW1iZXJfaWQsIHRhcmdldEJyZWFrLm9mZl9hcmVhX2tleSkpIGNvbnRpbnVlO1xuICAgIGlmIChoYXNDb3ZlckNvbmZsaWN0KGJyZWFrcywgc2hpZnQubWVtYmVyX2lkLCB0YXJnZXQsIHRhcmdldEJyZWFrLmlkKSkgY29udGludWU7XG4gICAgaWYgKHZpb2xhdGVzQXJlYU1pbmltdW1zKGNvbnRleHQsIGJyZWFrcywgdGFyZ2V0QnJlYWssIHRhcmdldCwgc2hpZnQubWVtYmVyX2lkKSkgY29udGludWU7XG5cbiAgICBvcHRpb25zLnB1c2goe1xuICAgICAgbWVtYmVySWQ6IHNoaWZ0Lm1lbWJlcl9pZCxcbiAgICAgIHNjb3JlOiBjb3Zlck9wdGlvblNjb3JlKGNvbnRleHQsIHRhcmdldEJyZWFrLCBzaGlmdClcbiAgICB9KTtcbiAgfVxuXG4gIG9wdGlvbnMuc29ydCgoYSwgYikgPT4gYS5zY29yZSAtIGIuc2NvcmUpO1xuICBpZiAoIW9wdGlvbnMuc29tZSgocm93KSA9PiByb3cubWVtYmVySWQgPT0gbnVsbCkpIHtcbiAgICBvcHRpb25zLnB1c2goeyBtZW1iZXJJZDogbnVsbCwgc2NvcmU6IDEwMDAgfSk7XG4gIH1cbiAgcmV0dXJuIG9wdGlvbnM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0NvdmVyQXNzaWdubWVudFZhbGlkKFxuICBjb250ZXh0OiBQbGFubmVyQ29udGV4dCxcbiAgYnJlYWtzOiBQbGFubmVyQnJlYWtbXSxcbiAgdGFyZ2V0QnJlYWs6IFBsYW5uZXJCcmVhayxcbiAgY292ZXJNZW1iZXJJZDogbnVtYmVyIHwgbnVsbFxuKSB7XG4gIGNvbnN0IHRhcmdldCA9IGJyZWFrVGFyZ2V0UmFuZ2UodGFyZ2V0QnJlYWspO1xuICBpZiAoIXRhcmdldCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY292ZXJNZW1iZXJJZCA9PSBudWxsKSB7XG4gICAgcmV0dXJuIGlzQXJlYUNvdmVyZWRXaXRob3V0QXNzaWduZWRDb3Zlcihjb250ZXh0LCBicmVha3MsIHRhcmdldEJyZWFrKTtcbiAgfVxuICBjb25zdCBjb3ZlclNoaWZ0ID0gYWN0aXZlV29ya2luZ1NoaWZ0Rm9yTWVtYmVyKGNvbnRleHQsIGNvdmVyTWVtYmVySWQsIHRhcmdldCk7XG4gIGlmICghY292ZXJTaGlmdCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoY292ZXJTaGlmdC5ob21lX2FyZWFfa2V5ICE9PSB0YXJnZXRCcmVhay5vZmZfYXJlYV9rZXkgJiYgIWNhbk1lbWJlcldvcmtBcmVhKGNvbnRleHQsIGNvdmVyTWVtYmVySWQsIHRhcmdldEJyZWFrLm9mZl9hcmVhX2tleSkpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKGhhc0NvdmVyQ29uZmxpY3QoYnJlYWtzLCBjb3Zlck1lbWJlcklkLCB0YXJnZXQsIHRhcmdldEJyZWFrLmlkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodmlvbGF0ZXNBcmVhTWluaW11bXMoY29udGV4dCwgYnJlYWtzLCB0YXJnZXRCcmVhaywgdGFyZ2V0LCBjb3Zlck1lbWJlcklkKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFzc2lnbkJlc3RDb3ZlcnMoXG4gIGNvbnRleHQ6IFBsYW5uZXJDb250ZXh0LFxuICBsb2NrZWRCcmVha3M6IFBsYW5uZXJCcmVha1tdLFxuICBwZW5kaW5nQnJlYWtzOiBQbGFubmVyQnJlYWtbXVxuKTogTWFwPG51bWJlciwgbnVtYmVyIHwgbnVsbD4ge1xuICBjb25zdCBhc3NpZ25tZW50cyA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXIgfCBudWxsPigpO1xuICBpZiAocGVuZGluZ0JyZWFrcy5sZW5ndGggPT09IDApIHJldHVybiBhc3NpZ25tZW50cztcblxuICBjb25zdCBwZW5kaW5nQnlJZCA9IG5ldyBNYXAocGVuZGluZ0JyZWFrcy5tYXAoKHJvdykgPT4gW3Jvdy5pZCwgcm93XSkpO1xuICBsZXQgYmVzdFNjb3JlID0gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xuICBsZXQgYmVzdEFzc2lnbm1lbnRzID0gbmV3IE1hcDxudW1iZXIsIG51bWJlciB8IG51bGw+KCk7XG5cbiAgY29uc3Qgc2VhcmNoID0gKGN1cnJlbnRCcmVha3M6IFBsYW5uZXJCcmVha1tdLCByZW1haW5pbmdJZHM6IG51bWJlcltdLCBydW5uaW5nU2NvcmU6IG51bWJlcikgPT4ge1xuICAgIGlmIChydW5uaW5nU2NvcmUgPj0gYmVzdFNjb3JlKSByZXR1cm47XG4gICAgaWYgKHJlbWFpbmluZ0lkcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGJlc3RTY29yZSA9IHJ1bm5pbmdTY29yZTtcbiAgICAgIGJlc3RBc3NpZ25tZW50cyA9IG5ldyBNYXAoYXNzaWdubWVudHMpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCBuZXh0SWQgPSByZW1haW5pbmdJZHNbMF0hO1xuICAgIGxldCBuZXh0T3B0aW9uczogQ292ZXJPcHRpb25bXSB8IG51bGwgPSBudWxsO1xuXG4gICAgZm9yIChjb25zdCBicmVha0lkIG9mIHJlbWFpbmluZ0lkcykge1xuICAgICAgY29uc3Qgcm93ID0gcGVuZGluZ0J5SWQuZ2V0KGJyZWFrSWQpO1xuICAgICAgaWYgKCFyb3cpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgb3B0aW9ucyA9IGxpc3RFbGlnaWJsZUNvdmVyT3B0aW9ucyhjb250ZXh0LCBjdXJyZW50QnJlYWtzLCByb3cpO1xuICAgICAgaWYgKCFuZXh0T3B0aW9ucyB8fCBvcHRpb25zLmxlbmd0aCA8IG5leHRPcHRpb25zLmxlbmd0aCkge1xuICAgICAgICBuZXh0SWQgPSBicmVha0lkO1xuICAgICAgICBuZXh0T3B0aW9ucyA9IG9wdGlvbnM7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgcm93ID0gcGVuZGluZ0J5SWQuZ2V0KG5leHRJZCk7XG4gICAgaWYgKCFyb3cgfHwgIW5leHRPcHRpb25zKSByZXR1cm47XG5cbiAgICBjb25zdCByZW1haW5pbmdBZnRlciA9IHJlbWFpbmluZ0lkcy5maWx0ZXIoKGlkKSA9PiBpZCAhPT0gbmV4dElkKTtcbiAgICBmb3IgKGNvbnN0IG9wdGlvbiBvZiBuZXh0T3B0aW9ucykge1xuICAgICAgYXNzaWdubWVudHMuc2V0KG5leHRJZCwgb3B0aW9uLm1lbWJlcklkKTtcbiAgICAgIGNvbnN0IG5leHRCcmVha3MgPSBjdXJyZW50QnJlYWtzLm1hcCgoaXRlbSkgPT5cbiAgICAgICAgaXRlbS5pZCA9PT0gbmV4dElkID8geyAuLi5pdGVtLCBjb3Zlcl9tZW1iZXJfaWQ6IG9wdGlvbi5tZW1iZXJJZCB9IDogaXRlbVxuICAgICAgKTtcbiAgICAgIHNlYXJjaChuZXh0QnJlYWtzLCByZW1haW5pbmdBZnRlciwgcnVubmluZ1Njb3JlICsgb3B0aW9uLnNjb3JlKTtcbiAgICB9XG4gICAgYXNzaWdubWVudHMuZGVsZXRlKG5leHRJZCk7XG4gIH07XG5cbiAgc2VhcmNoKFsuLi5sb2NrZWRCcmVha3MsIC4uLnBlbmRpbmdCcmVha3NdLCBwZW5kaW5nQnJlYWtzLm1hcCgocm93KSA9PiByb3cuaWQpLCAwKTtcbiAgcmV0dXJuIGJlc3RBc3NpZ25tZW50cztcbn1cbiIsICJpbXBvcnQgeyBicmVha0FsbG93YW5jZU1pbnV0ZXMsIG92ZXJsYXAgfSBmcm9tICcuL2JyZWFrcyc7XG5pbXBvcnQgeyBwYXJzZUhITU0sIHRvSEhNTSB9IGZyb20gJy4vdGltZSc7XG5pbXBvcnQgdHlwZSB7IEJyZWFrUHJlZmVyZW5jZSB9IGZyb20gJy4vbWVtYmVyLWNvbmZpZyc7XG5cbmV4cG9ydCB0eXBlIFNoaWZ0TGlrZSA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgbWVtYmVyX2lkOiBudW1iZXI7XG4gIGhvbWVfYXJlYV9rZXk6IHN0cmluZztcbiAgc3RhdHVzX2tleTogc3RyaW5nO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGVuZF90aW1lOiBzdHJpbmcgfCBudWxsO1xuICBzaGlmdF9taW51dGVzOiBudW1iZXI7XG59O1xuXG5leHBvcnQgdHlwZSBCcmVha0xpa2UgPSB7XG4gIGlkPzogbnVtYmVyO1xuICBzaGlmdF9pZDogbnVtYmVyO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGR1cmF0aW9uX21pbnV0ZXM6IG51bWJlcjtcbiAgY292ZXJfbWVtYmVyX2lkOiBudW1iZXIgfCBudWxsO1xufTtcblxuZXhwb3J0IHR5cGUgQXJlYUxpa2UgPSB7IGtleTogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBtaW5fc3RhZmY6IG51bWJlciB9O1xuXG5leHBvcnQgdHlwZSBNZW1iZXJMaWtlID0geyBpZDogbnVtYmVyOyBhbGxfYXJlYXM6IG51bWJlciB9O1xuXG5leHBvcnQgZnVuY3Rpb24gY29tcHV0ZVNoaWZ0TWludXRlcyhzaGlmdDogU2hpZnRMaWtlKTogbnVtYmVyIHtcbiAgY29uc3Qgc3RhcnRNaW4gPSBwYXJzZUhITU0oc2hpZnQuc3RhcnRfdGltZSkgPz8gMDtcbiAgY29uc3QgZW5kTWluID0gc2hpZnQuZW5kX3RpbWUgPyBwYXJzZUhITU0oc2hpZnQuZW5kX3RpbWUpIDogbnVsbDtcbiAgcmV0dXJuIGVuZE1pbiAhPSBudWxsID8gZW5kTWluIC0gc3RhcnRNaW4gOiBzaGlmdC5zaGlmdF9taW51dGVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVCcmVha1RlbXBsYXRlKHNoaWZ0TWludXRlczogbnVtYmVyLCBwcmVmZXJlbmNlOiBCcmVha1ByZWZlcmVuY2UgPSAnMTUrMzAnKTogbnVtYmVyW10ge1xuICBsZXQgdGVtcGxhdGU6IG51bWJlcltdO1xuICBpZiAoc2hpZnRNaW51dGVzIDwgNCAqIDYwKSB7XG4gICAgdGVtcGxhdGUgPSBbXTtcbiAgfSBlbHNlIGlmIChzaGlmdE1pbnV0ZXMgPD0gNSAqIDYwKSB7XG4gICAgdGVtcGxhdGUgPSBbMTVdO1xuICB9IGVsc2UgaWYgKHNoaWZ0TWludXRlcyA8IDcgKiA2MCkge1xuICAgIHRlbXBsYXRlID0gWzE1LCAzMF07XG4gIH0gZWxzZSBpZiAoc2hpZnRNaW51dGVzIDwgMTAgKiA2MCkge1xuICAgIHRlbXBsYXRlID0gWzE1LCAzMCwgMTVdO1xuICB9IGVsc2Uge1xuICAgIHRlbXBsYXRlID0gWzE1LCAzMCwgMTUsIDMwXTtcbiAgfVxuXG4gIGlmIChwcmVmZXJlbmNlID09PSAnMTUrMzAnKSByZXR1cm4gdGVtcGxhdGU7XG5cbiAgY29uc3QgdGhpcnRpZXMgPSB0ZW1wbGF0ZS5maWx0ZXIoKG1pbnV0ZXMpID0+IG1pbnV0ZXMgPT09IDMwKTtcbiAgY29uc3QgZmlmdGVlbnMgPSB0ZW1wbGF0ZS5maWx0ZXIoKG1pbnV0ZXMpID0+IG1pbnV0ZXMgPT09IDE1KTtcbiAgaWYgKHRoaXJ0aWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHRlbXBsYXRlO1xuICBpZiAodGhpcnRpZXMubGVuZ3RoID09PSAxKSByZXR1cm4gWzMwLCAuLi5maWZ0ZWVuc107XG4gIHJldHVybiBbMzAsIDE1LCAzMCwgLi4uZmlmdGVlbnMuc2xpY2UoMSldO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcHJvcG9zZUJyZWFrVGltZXMoXG4gIHNoaWZ0OiBTaGlmdExpa2UsXG4gIGR1cmF0aW9uczogbnVtYmVyW10sXG4gIG9wdHM/OiB7XG4gICAgb2Zmc2V0TWludXRlcz86IG51bWJlcjtcbiAgICBleGlzdGluZ0JyZWFrcz86IEFycmF5PHsgc3RhcnRfdGltZTogc3RyaW5nOyBkdXJhdGlvbl9taW51dGVzOiBudW1iZXIgfT47XG4gIH1cbik6IHsgc3RhcnRfdGltZTogc3RyaW5nOyBkdXJhdGlvbl9taW51dGVzOiBudW1iZXIgfVtdIHtcbiAgY29uc3Qgc3RhcnRNaW4gPSBwYXJzZUhITU0oc2hpZnQuc3RhcnRfdGltZSk7XG4gIGNvbnN0IGVuZE1pbiA9IHNoaWZ0LmVuZF90aW1lID8gcGFyc2VISE1NKHNoaWZ0LmVuZF90aW1lKSA6IG51bGw7XG4gIGlmIChzdGFydE1pbiA9PSBudWxsIHx8IGVuZE1pbiA9PSBudWxsKSByZXR1cm4gW107XG5cbiAgY29uc3Qgb3V0OiB7IHN0YXJ0X3RpbWU6IHN0cmluZzsgZHVyYXRpb25fbWludXRlczogbnVtYmVyIH1bXSA9IFtdO1xuICBpZiAoZHVyYXRpb25zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG91dDtcblxuICBsZXQgcHJldmlvdXNTdGFydDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IG9mZnNldCA9IG9wdHM/Lm9mZnNldE1pbnV0ZXMgPz8gMDtcbiAgY29uc3QgZXhpc3RpbmdCcmVha3MgPSBvcHRzPy5leGlzdGluZ0JyZWFrcyA/PyBbXTtcbiAgY29uc3QgcGxhbm5lZDogeyBzdGFydF90aW1lOiBzdHJpbmc7IGR1cmF0aW9uX21pbnV0ZXM6IG51bWJlciB9W10gPSBbXTtcblxuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgZHVyYXRpb25zLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgIGNvbnN0IGR1ciA9IGR1cmF0aW9uc1tpbmRleF07XG4gICAgY29uc3QgZWFybGllc3RTdGFydCA9IChwcmV2aW91c1N0YXJ0ID8/IHN0YXJ0TWluKSArIDEyMCArIChpbmRleCA9PT0gMCA/IG9mZnNldCA6IDApO1xuICAgIGNvbnN0IHByZWZlcnJlZFN0YXJ0ID0gKHByZXZpb3VzU3RhcnQgPz8gc3RhcnRNaW4pICsgMTUwICsgKGluZGV4ID09PSAwID8gb2Zmc2V0IDogMCk7XG4gICAgY29uc3QgbGF0ZXN0QnlDYWRlbmNlID0gKHByZXZpb3VzU3RhcnQgPz8gc3RhcnRNaW4pICsgMTgwICsgKGluZGV4ID09PSAwID8gb2Zmc2V0IDogMCk7XG4gICAgY29uc3QgbGF0ZXN0QnlTaGlmdCA9IGVuZE1pbiAtIGR1ciAtIDYwO1xuICAgIGNvbnN0IGxhdGVzdFN0YXJ0ID0gTWF0aC5taW4obGF0ZXN0QnlDYWRlbmNlLCBsYXRlc3RCeVNoaWZ0KTtcbiAgICBpZiAobGF0ZXN0U3RhcnQgPCBlYXJsaWVzdFN0YXJ0KSBicmVhaztcblxuICAgIGxldCBiZXN0U3RhcnQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIGxldCBiZXN0U2NvcmUgPSBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFk7XG5cbiAgICBmb3IgKGxldCBjYW5kaWRhdGUgPSBlYXJsaWVzdFN0YXJ0OyBjYW5kaWRhdGUgPD0gbGF0ZXN0U3RhcnQ7IGNhbmRpZGF0ZSArPSAxNSkge1xuICAgICAgY29uc3QgY2FuZGlkYXRlQnJlYWsgPSB7IHN0YXJ0X3RpbWU6IHRvSEhNTShjYW5kaWRhdGUpLCBkdXJhdGlvbl9taW51dGVzOiBkdXIgfTtcbiAgICAgIGNvbnN0IG92ZXJsYXBDb3VudCA9IFsuLi5leGlzdGluZ0JyZWFrcywgLi4ucGxhbm5lZF0ucmVkdWNlKChjb3VudCwgcm93KSA9PiB7XG4gICAgICAgIHJldHVybiBjb3VudCArIChicmVha3NPdmVybGFwKGNhbmRpZGF0ZUJyZWFrLCByb3cpID8gMSA6IDApO1xuICAgICAgfSwgMCk7XG4gICAgICBjb25zdCBzY29yZSA9IG92ZXJsYXBDb3VudCAqIDEwMDAgKyBNYXRoLmFicyhjYW5kaWRhdGUgLSBwcmVmZXJyZWRTdGFydCk7XG4gICAgICBpZiAoc2NvcmUgPCBiZXN0U2NvcmUpIHtcbiAgICAgICAgYmVzdFNjb3JlID0gc2NvcmU7XG4gICAgICAgIGJlc3RTdGFydCA9IGNhbmRpZGF0ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoYmVzdFN0YXJ0ID09IG51bGwpIGJyZWFrO1xuICAgIGNvbnN0IG5leHRCcmVhayA9IHsgc3RhcnRfdGltZTogdG9ISE1NKGJlc3RTdGFydCksIGR1cmF0aW9uX21pbnV0ZXM6IGR1ciB9O1xuICAgIG91dC5wdXNoKG5leHRCcmVhayk7XG4gICAgcGxhbm5lZC5wdXNoKG5leHRCcmVhayk7XG4gICAgcHJldmlvdXNTdGFydCA9IGJlc3RTdGFydDtcbiAgfVxuXG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYW5kaWRhdGVPZmZzZXRzKGJhc2VPZmZzZXRNaW51dGVzOiBudW1iZXIpIHtcbiAgcmV0dXJuIFtcbiAgICAuLi5uZXcgU2V0KFtcbiAgICAgIGJhc2VPZmZzZXRNaW51dGVzIC0gNjAsXG4gICAgICBiYXNlT2Zmc2V0TWludXRlcyAtIDQ1LFxuICAgICAgYmFzZU9mZnNldE1pbnV0ZXMgLSAzMCxcbiAgICAgIGJhc2VPZmZzZXRNaW51dGVzIC0gMTUsXG4gICAgICBiYXNlT2Zmc2V0TWludXRlcyxcbiAgICAgIGJhc2VPZmZzZXRNaW51dGVzICsgMTUsXG4gICAgICBiYXNlT2Zmc2V0TWludXRlcyArIDMwLFxuICAgICAgYmFzZU9mZnNldE1pbnV0ZXMgKyA0NVxuICAgIF0pXG4gIF07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByYW5nZUZvcihiOiB7IHN0YXJ0X3RpbWU6IHN0cmluZzsgZHVyYXRpb25fbWludXRlczogbnVtYmVyIH0pOiB7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyIH0gfCBudWxsIHtcbiAgY29uc3QgcyA9IHBhcnNlSEhNTShiLnN0YXJ0X3RpbWUpO1xuICBpZiAocyA9PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZHVyYXRpb24gPSBOdW1iZXIoYi5kdXJhdGlvbl9taW51dGVzKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoZHVyYXRpb24pKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc3RhcnQ6IHMsIGVuZDogcyArIGR1cmF0aW9uIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBicmVha3NPdmVybGFwKGE6IHsgc3RhcnRfdGltZTogc3RyaW5nOyBkdXJhdGlvbl9taW51dGVzOiBudW1iZXIgfSwgYjogeyBzdGFydF90aW1lOiBzdHJpbmc7IGR1cmF0aW9uX21pbnV0ZXM6IG51bWJlciB9KSB7XG4gIGNvbnN0IGFyID0gcmFuZ2VGb3IoYSk7XG4gIGNvbnN0IGJyID0gcmFuZ2VGb3IoYik7XG4gIGlmICghYXIgfHwgIWJyKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBvdmVybGFwKGFyLnN0YXJ0LCBhci5lbmQsIGJyLnN0YXJ0LCBici5lbmQpO1xufVxuIiwgImltcG9ydCB7IHBhcnNlSEhNTSB9IGZyb20gJy4vdGltZSc7XG5cbmZ1bmN0aW9uIHdvcmtCbG9ja1Rlc3RIb29rcygpIHtcbiAgcmV0dXJuIChnbG9iYWxUaGlzIGFzIGFueSkuX19idW5ydW5Xb3JrQmxvY2tUZXN0SG9va3MgYXMge1xuICAgIHJlY29tcHV0ZVdvcmtCbG9ja3NGb3JTY2hlZHVsZT86IChEQjogRDFEYXRhYmFzZSwgc2NoZWR1bGVJZDogbnVtYmVyKSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZDtcbiAgICBjbGVhck1lbWJlckJyZWFrUGxhbkZvclNjaGVkdWxlPzogKERCOiBEMURhdGFiYXNlLCBzY2hlZHVsZUlkOiBudW1iZXIsIG1lbWJlcklkOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD4gfCB2b2lkO1xuICB9IHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgdHlwZSBXb3JrQmxvY2sgPSB7XG4gIGlkOiBudW1iZXI7XG4gIHNjaGVkdWxlX2lkOiBudW1iZXI7XG4gIG1lbWJlcl9pZDogbnVtYmVyO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGVuZF90aW1lOiBzdHJpbmc7XG4gIHRvdGFsX21pbnV0ZXM6IG51bWJlcjtcbn07XG5cbmV4cG9ydCB0eXBlIFdvcmtCbG9ja1NoaWZ0ID0ge1xuICBpZDogbnVtYmVyO1xuICBzY2hlZHVsZV9pZDogbnVtYmVyO1xuICBtZW1iZXJfaWQ6IG51bWJlcjtcbiAgc3RhdHVzX2tleTogc3RyaW5nO1xuICBob21lX2FyZWFfa2V5OiBzdHJpbmc7XG4gIHN0YXJ0X3RpbWU6IHN0cmluZztcbiAgZW5kX3RpbWU6IHN0cmluZyB8IG51bGw7XG4gIHNoaWZ0X21pbnV0ZXM6IG51bWJlcjtcbiAgd29ya19ibG9ja19pZD86IG51bWJlciB8IG51bGw7XG59O1xuXG50eXBlIFBlbmRpbmdXb3JrQmxvY2sgPSB7XG4gIG1lbWJlcl9pZDogbnVtYmVyO1xuICBzdGFydF90aW1lOiBzdHJpbmc7XG4gIGVuZF90aW1lOiBzdHJpbmc7XG4gIHRvdGFsX21pbnV0ZXM6IG51bWJlcjtcbiAgc2hpZnRJZHM6IG51bWJlcltdO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHNoaWZ0Q29udGFpbnNUaW1lKHNoaWZ0OiBQaWNrPFdvcmtCbG9ja1NoaWZ0LCAnc3RhcnRfdGltZScgfCAnZW5kX3RpbWUnPiwgdGltZUhITU06IHN0cmluZykge1xuICBjb25zdCBzdGFydCA9IHBhcnNlSEhNTShzaGlmdC5zdGFydF90aW1lKTtcbiAgY29uc3QgZW5kID0gc2hpZnQuZW5kX3RpbWUgPyBwYXJzZUhITU0oc2hpZnQuZW5kX3RpbWUpIDogbnVsbDtcbiAgY29uc3QgdGltZSA9IHBhcnNlSEhNTSh0aW1lSEhNTSk7XG4gIGlmIChzdGFydCA9PSBudWxsIHx8IGVuZCA9PSBudWxsIHx8IHRpbWUgPT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gc3RhcnQgPD0gdGltZSAmJiB0aW1lIDwgZW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWN0aXZlU2hpZnRBdFRpbWUoc2hpZnRzOiBXb3JrQmxvY2tTaGlmdFtdLCBtZW1iZXJJZDogbnVtYmVyLCB0aW1lSEhNTTogc3RyaW5nKSB7XG4gIHJldHVybiBzaGlmdHMuZmluZCgoc2hpZnQpID0+IHNoaWZ0Lm1lbWJlcl9pZCA9PT0gbWVtYmVySWQgJiYgc2hpZnQuc3RhdHVzX2tleSA9PT0gJ3dvcmtpbmcnICYmIHNoaWZ0Q29udGFpbnNUaW1lKHNoaWZ0LCB0aW1lSEhNTSkpID8/IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFBlbmRpbmdXb3JrQmxvY2tzKHNoaWZ0czogV29ya0Jsb2NrU2hpZnRbXSk6IFBlbmRpbmdXb3JrQmxvY2tbXSB7XG4gIGNvbnN0IHdvcmtpbmcgPSBzaGlmdHNcbiAgICAuZmlsdGVyKChzaGlmdCkgPT4gc2hpZnQuc3RhdHVzX2tleSA9PT0gJ3dvcmtpbmcnKVxuICAgIC5zbGljZSgpXG4gICAgLnNvcnQoKGEsIGIpID0+XG4gICAgICBhLm1lbWJlcl9pZCAtIGIubWVtYmVyX2lkIHx8XG4gICAgICBhLnN0YXJ0X3RpbWUubG9jYWxlQ29tcGFyZShiLnN0YXJ0X3RpbWUpIHx8XG4gICAgICAoYS5lbmRfdGltZSA/PyAnJykubG9jYWxlQ29tcGFyZShiLmVuZF90aW1lID8/ICcnKSB8fFxuICAgICAgYS5pZCAtIGIuaWRcbiAgICApO1xuXG4gIGNvbnN0IGJsb2NrczogUGVuZGluZ1dvcmtCbG9ja1tdID0gW107XG4gIGxldCBjdXJyZW50OiBQZW5kaW5nV29ya0Jsb2NrIHwgbnVsbCA9IG51bGw7XG5cbiAgZm9yIChjb25zdCBzaGlmdCBvZiB3b3JraW5nKSB7XG4gICAgaWYgKCFzaGlmdC5lbmRfdGltZSkgY29udGludWU7XG4gICAgaWYgKFxuICAgICAgIWN1cnJlbnQgfHxcbiAgICAgIGN1cnJlbnQubWVtYmVyX2lkICE9PSBzaGlmdC5tZW1iZXJfaWQgfHxcbiAgICAgIGN1cnJlbnQuZW5kX3RpbWUgIT09IHNoaWZ0LnN0YXJ0X3RpbWVcbiAgICApIHtcbiAgICAgIGN1cnJlbnQgPSB7XG4gICAgICAgIG1lbWJlcl9pZDogc2hpZnQubWVtYmVyX2lkLFxuICAgICAgICBzdGFydF90aW1lOiBzaGlmdC5zdGFydF90aW1lLFxuICAgICAgICBlbmRfdGltZTogc2hpZnQuZW5kX3RpbWUsXG4gICAgICAgIHRvdGFsX21pbnV0ZXM6IE51bWJlcihzaGlmdC5zaGlmdF9taW51dGVzID8/IDApLFxuICAgICAgICBzaGlmdElkczogW3NoaWZ0LmlkXVxuICAgICAgfTtcbiAgICAgIGJsb2Nrcy5wdXNoKGN1cnJlbnQpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY3VycmVudC5lbmRfdGltZSA9IHNoaWZ0LmVuZF90aW1lO1xuICAgIGN1cnJlbnQudG90YWxfbWludXRlcyArPSBOdW1iZXIoc2hpZnQuc2hpZnRfbWludXRlcyA/PyAwKTtcbiAgICBjdXJyZW50LnNoaWZ0SWRzLnB1c2goc2hpZnQuaWQpO1xuICB9XG5cbiAgcmV0dXJuIGJsb2Nrcztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlY29tcHV0ZVdvcmtCbG9ja3NGb3JTY2hlZHVsZShEQjogRDFEYXRhYmFzZSwgc2NoZWR1bGVJZDogbnVtYmVyKSB7XG4gIGNvbnN0IGhvb2sgPSB3b3JrQmxvY2tUZXN0SG9va3MoKT8ucmVjb21wdXRlV29ya0Jsb2Nrc0ZvclNjaGVkdWxlO1xuICBpZiAoaG9vaykge1xuICAgIGF3YWl0IGhvb2soREIsIHNjaGVkdWxlSWQpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzaGlmdHMgPSAoXG4gICAgYXdhaXQgREIucHJlcGFyZShcbiAgICAgIGBTRUxFQ1QgaWQsIHNjaGVkdWxlX2lkLCBtZW1iZXJfaWQsIHN0YXR1c19rZXksIGhvbWVfYXJlYV9rZXksIHN0YXJ0X3RpbWUsIGVuZF90aW1lLCBzaGlmdF9taW51dGVzLCB3b3JrX2Jsb2NrX2lkXG4gICAgICAgRlJPTSBzaGlmdHNcbiAgICAgICBXSEVSRSBzY2hlZHVsZV9pZD0/XG4gICAgICAgT1JERVIgQlkgbWVtYmVyX2lkIEFTQywgc3RhcnRfdGltZSBBU0MsIGlkIEFTQ2BcbiAgICApXG4gICAgICAuYmluZChzY2hlZHVsZUlkKVxuICAgICAgLmFsbCgpXG4gICkucmVzdWx0cyBhcyBXb3JrQmxvY2tTaGlmdFtdO1xuXG4gIGNvbnN0IGJyZWFrcyA9IChcbiAgICBhd2FpdCBEQi5wcmVwYXJlKFxuICAgICAgYFNFTEVDVCBiLmlkLCBiLnNoaWZ0X2lkLCBiLnN0YXJ0X3RpbWVcbiAgICAgICBGUk9NIGJyZWFrcyBiXG4gICAgICAgSk9JTiBzaGlmdHMgcyBPTiBzLmlkID0gYi5zaGlmdF9pZFxuICAgICAgIFdIRVJFIHMuc2NoZWR1bGVfaWQ9P2BcbiAgICApXG4gICAgICAuYmluZChzY2hlZHVsZUlkKVxuICAgICAgLmFsbCgpXG4gICkucmVzdWx0cyBhcyBBcnJheTx7IGlkOiBudW1iZXI7IHNoaWZ0X2lkOiBudW1iZXI7IHN0YXJ0X3RpbWU6IHN0cmluZyB9PjtcblxuICBhd2FpdCBEQi5iYXRjaChbXG4gICAgREIucHJlcGFyZSgnVVBEQVRFIHNoaWZ0cyBTRVQgd29ya19ibG9ja19pZD1OVUxMIFdIRVJFIHNjaGVkdWxlX2lkPT8nKS5iaW5kKHNjaGVkdWxlSWQpLFxuICAgIERCLnByZXBhcmUoXG4gICAgICBgVVBEQVRFIGJyZWFrc1xuICAgICAgIFNFVCB3b3JrX2Jsb2NrX2lkPU5VTExcbiAgICAgICBXSEVSRSBpZCBJTiAoXG4gICAgICAgICBTRUxFQ1QgYi5pZFxuICAgICAgICAgRlJPTSBicmVha3MgYlxuICAgICAgICAgSk9JTiBzaGlmdHMgcyBPTiBzLmlkID0gYi5zaGlmdF9pZFxuICAgICAgICAgV0hFUkUgcy5zY2hlZHVsZV9pZD0/XG4gICAgICAgKWBcbiAgICApLmJpbmQoc2NoZWR1bGVJZCksXG4gICAgREIucHJlcGFyZSgnREVMRVRFIEZST00gd29ya19ibG9ja3MgV0hFUkUgc2NoZWR1bGVfaWQ9PycpLmJpbmQoc2NoZWR1bGVJZClcbiAgXSk7XG5cbiAgY29uc3QgcGVuZGluZ0Jsb2NrcyA9IGJ1aWxkUGVuZGluZ1dvcmtCbG9ja3Moc2hpZnRzKTtcbiAgY29uc3Qgc2hpZnRzQnlJZCA9IG5ldyBNYXA8bnVtYmVyLCBXb3JrQmxvY2tTaGlmdD4oc2hpZnRzLm1hcCgoc2hpZnQpID0+IFtzaGlmdC5pZCwgc2hpZnRdKSk7XG5cbiAgZm9yIChjb25zdCBwZW5kaW5nIG9mIHBlbmRpbmdCbG9ja3MpIHtcbiAgICBjb25zdCBpbnNlcnQgPSBhd2FpdCBEQi5wcmVwYXJlKFxuICAgICAgYElOU0VSVCBJTlRPIHdvcmtfYmxvY2tzIChzY2hlZHVsZV9pZCwgbWVtYmVyX2lkLCBzdGFydF90aW1lLCBlbmRfdGltZSwgdG90YWxfbWludXRlcylcbiAgICAgICBWQUxVRVMgKD8sID8sID8sID8sID8pYFxuICAgIClcbiAgICAgIC5iaW5kKHNjaGVkdWxlSWQsIHBlbmRpbmcubWVtYmVyX2lkLCBwZW5kaW5nLnN0YXJ0X3RpbWUsIHBlbmRpbmcuZW5kX3RpbWUsIHBlbmRpbmcudG90YWxfbWludXRlcylcbiAgICAgIC5ydW4oKTtcbiAgICBjb25zdCB3b3JrQmxvY2tJZCA9IE51bWJlcigoaW5zZXJ0IGFzIGFueSk/Lm1ldGE/Lmxhc3Rfcm93X2lkID8/IDApO1xuICAgIGlmICghd29ya0Jsb2NrSWQpIGNvbnRpbnVlO1xuXG4gICAgY29uc3Qgc2hpZnRVcGRhdGVzID0gW107XG4gICAgZm9yIChjb25zdCBzaGlmdElkIG9mIHBlbmRpbmcuc2hpZnRJZHMpIHtcbiAgICAgIHNoaWZ0VXBkYXRlcy5wdXNoKERCLnByZXBhcmUoJ1VQREFURSBzaGlmdHMgU0VUIHdvcmtfYmxvY2tfaWQ9PyBXSEVSRSBpZD0/JykuYmluZCh3b3JrQmxvY2tJZCwgc2hpZnRJZCkpO1xuICAgICAgY29uc3Qgc2hpZnQgPSBzaGlmdHNCeUlkLmdldChzaGlmdElkKTtcbiAgICAgIGlmIChzaGlmdCkgc2hpZnQud29ya19ibG9ja19pZCA9IHdvcmtCbG9ja0lkO1xuICAgIH1cbiAgICBpZiAoc2hpZnRVcGRhdGVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IERCLmJhdGNoKHNoaWZ0VXBkYXRlcyk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgYnJlYWtVcGRhdGVzID0gW107XG4gIGZvciAoY29uc3Qgcm93IG9mIGJyZWFrcykge1xuICAgIGNvbnN0IG9sZFNoaWZ0ID0gc2hpZnRzQnlJZC5nZXQocm93LnNoaWZ0X2lkKTtcbiAgICBpZiAoIW9sZFNoaWZ0KSBjb250aW51ZTtcbiAgICBjb25zdCBhY3RpdmVTaGlmdCA9IGFjdGl2ZVNoaWZ0QXRUaW1lKHNoaWZ0cywgb2xkU2hpZnQubWVtYmVyX2lkLCByb3cuc3RhcnRfdGltZSkgPz8gb2xkU2hpZnQ7XG4gICAgYnJlYWtVcGRhdGVzLnB1c2goXG4gICAgICBEQi5wcmVwYXJlKCdVUERBVEUgYnJlYWtzIFNFVCBzaGlmdF9pZD0/LCB3b3JrX2Jsb2NrX2lkPT8gV0hFUkUgaWQ9PycpXG4gICAgICAgIC5iaW5kKGFjdGl2ZVNoaWZ0LmlkLCBhY3RpdmVTaGlmdC53b3JrX2Jsb2NrX2lkID8/IG51bGwsIHJvdy5pZClcbiAgICApO1xuICB9XG4gIGlmIChicmVha1VwZGF0ZXMubGVuZ3RoID4gMCkge1xuICAgIGF3YWl0IERCLmJhdGNoKGJyZWFrVXBkYXRlcyk7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyTWVtYmVyQnJlYWtQbGFuRm9yU2NoZWR1bGUoREI6IEQxRGF0YWJhc2UsIHNjaGVkdWxlSWQ6IG51bWJlciwgbWVtYmVySWQ6IG51bWJlcikge1xuICBjb25zdCBob29rID0gd29ya0Jsb2NrVGVzdEhvb2tzKCk/LmNsZWFyTWVtYmVyQnJlYWtQbGFuRm9yU2NoZWR1bGU7XG4gIGlmIChob29rKSB7XG4gICAgYXdhaXQgaG9vayhEQiwgc2NoZWR1bGVJZCwgbWVtYmVySWQpO1xuICAgIHJldHVybjtcbiAgfVxuICBhd2FpdCBEQi5wcmVwYXJlKFxuICAgIGBERUxFVEUgRlJPTSBicmVha3NcbiAgICAgV0hFUkUgaWQgSU4gKFxuICAgICAgIFNFTEVDVCBiLmlkXG4gICAgICAgRlJPTSBicmVha3MgYlxuICAgICAgIEpPSU4gc2hpZnRzIHMgT04gcy5pZCA9IGIuc2hpZnRfaWRcbiAgICAgICBXSEVSRSBzLnNjaGVkdWxlX2lkPT8gQU5EIHMubWVtYmVyX2lkPT9cbiAgICAgKWBcbiAgKS5iaW5kKHNjaGVkdWxlSWQsIG1lbWJlcklkKS5ydW4oKTtcblxuICBhd2FpdCBEQi5wcmVwYXJlKFxuICAgIGBVUERBVEUgYnJlYWtzXG4gICAgIFNFVCBjb3Zlcl9tZW1iZXJfaWQ9TlVMTFxuICAgICBXSEVSRSBpZCBJTiAoXG4gICAgICAgU0VMRUNUIGIuaWRcbiAgICAgICBGUk9NIGJyZWFrcyBiXG4gICAgICAgSk9JTiBzaGlmdHMgcyBPTiBzLmlkID0gYi5zaGlmdF9pZFxuICAgICAgIFdIRVJFIHMuc2NoZWR1bGVfaWQ9PyBBTkQgYi5jb3Zlcl9tZW1iZXJfaWQ9P1xuICAgICApYFxuICApLmJpbmQoc2NoZWR1bGVJZCwgbWVtYmVySWQpLnJ1bigpO1xufVxuIiwgImltcG9ydCB7IGNhbmRpZGF0ZU9mZnNldHMsIGdlbmVyYXRlQnJlYWtUZW1wbGF0ZSwgcHJvcG9zZUJyZWFrVGltZXMgfSBmcm9tICcuL2F1dG9nZW4nO1xuaW1wb3J0IHsgYXNzaWduQmVzdENvdmVycywgaXNDb3ZlckFzc2lnbm1lbnRWYWxpZCwgdHlwZSBQbGFubmVyQnJlYWssIHR5cGUgUGxhbm5lckNvbnRleHQgfSBmcm9tICcuL2JyZWFrLXBsYW5uZXInO1xuaW1wb3J0IHsgYWN0aXZlU2hpZnRBdFRpbWUsIHR5cGUgV29ya0Jsb2NrU2hpZnQgfSBmcm9tICcuL3dvcmstYmxvY2tzJztcbmltcG9ydCB0eXBlIHsgQnJlYWtQcmVmZXJlbmNlIH0gZnJvbSAnLi9tZW1iZXItY29uZmlnJztcblxuZXhwb3J0IHR5cGUgQnJlYWtHZW5lcmF0aW9uQmxvY2sgPSB7XG4gIGlkOiBudW1iZXI7XG4gIG1lbWJlcl9pZDogbnVtYmVyO1xuICB0b3RhbF9taW51dGVzOiBudW1iZXI7XG4gIGJyZWFrX3ByZWZlcmVuY2U/OiBCcmVha1ByZWZlcmVuY2UgfCBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBCcmVha0dlbmVyYXRpb25SZXN1bHQgPSB7XG4gIHBlbmRpbmdCcmVha3M6IFBsYW5uZXJCcmVha1tdO1xuICBhc3NpZ25tZW50czogTWFwPG51bWJlciwgbnVtYmVyIHwgbnVsbD47XG4gIGdlbmVyYXRlZENvdW50OiBudW1iZXI7XG4gIG1pc3NpbmdDb3VudDogbnVtYmVyO1xuICByZXF1ZXN0ZWRCcmVha0NvdW50OiBudW1iZXI7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVCZXN0QnJlYWtQbGFuRm9yQmxvY2soaW5wdXQ6IHtcbiAgYmxvY2s6IEJyZWFrR2VuZXJhdGlvbkJsb2NrO1xuICBibG9ja1NoaWZ0czogV29ya0Jsb2NrU2hpZnRbXTtcbiAgcGxhbm5lcjogUGxhbm5lckNvbnRleHQ7XG4gIGV4aXN0aW5nQnJlYWtzOiBQbGFubmVyQnJlYWtbXTtcbiAgZXhjbHVkZVdvcmtCbG9ja0lkPzogbnVtYmVyO1xufSk6IEJyZWFrR2VuZXJhdGlvblJlc3VsdCB7XG4gIGNvbnN0IHsgYmxvY2ssIGJsb2NrU2hpZnRzLCBwbGFubmVyLCBleGlzdGluZ0JyZWFrcywgZXhjbHVkZVdvcmtCbG9ja0lkID0gYmxvY2suaWQgfSA9IGlucHV0O1xuICBjb25zdCBkdXJhdGlvbnMgPSBnZW5lcmF0ZUJyZWFrVGVtcGxhdGUoTnVtYmVyKGJsb2NrLnRvdGFsX21pbnV0ZXMgPz8gMCksIChibG9jay5icmVha19wcmVmZXJlbmNlIGFzIEJyZWFrUHJlZmVyZW5jZSB8IHVuZGVmaW5lZCkgPz8gJzE1KzMwJyk7XG4gIGNvbnN0IGJsb2NrQXJlYUtleXMgPSBuZXcgU2V0KGJsb2NrU2hpZnRzLm1hcCgoc2hpZnQpID0+IHNoaWZ0LmhvbWVfYXJlYV9rZXkpKTtcbiAgY29uc3QgbG9ja2VkQnJlYWtzID0gZXhpc3RpbmdCcmVha3MuZmlsdGVyKChyb3cpID0+IHJvdy53b3JrX2Jsb2NrX2lkICE9PSBleGNsdWRlV29ya0Jsb2NrSWQpO1xuXG4gIGxldCBiZXN0UGVuZGluZ0JyZWFrczogUGxhbm5lckJyZWFrW10gPSBbXTtcbiAgbGV0IGJlc3RBc3NpZ25tZW50cyA9IG5ldyBNYXA8bnVtYmVyLCBudW1iZXIgfCBudWxsPigpO1xuICBsZXQgYmVzdE1pc3NpbmdDb3VudCA9IE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcbiAgbGV0IGJlc3RHZW5lcmF0ZWRDb3VudCA9IC0xO1xuXG4gIGZvciAoY29uc3Qgb2Zmc2V0IG9mIGNhbmRpZGF0ZU9mZnNldHMoMCkpIHtcbiAgICBjb25zdCBhcmVhQnJlYWtzID0gbG9ja2VkQnJlYWtzXG4gICAgICAuZmlsdGVyKChyb3cpID0+IGJsb2NrQXJlYUtleXMuaGFzKHJvdy5vZmZfYXJlYV9rZXkpKVxuICAgICAgLm1hcCgocm93KSA9PiAoeyBzdGFydF90aW1lOiByb3cuc3RhcnRfdGltZSwgZHVyYXRpb25fbWludXRlczogcm93LmR1cmF0aW9uX21pbnV0ZXMgfSkpO1xuXG4gICAgY29uc3QgcHJvcG9zZWQgPSBwcm9wb3NlQnJlYWtUaW1lcyhibG9jayBhcyBhbnksIGR1cmF0aW9ucywgeyBvZmZzZXRNaW51dGVzOiBvZmZzZXQsIGV4aXN0aW5nQnJlYWtzOiBhcmVhQnJlYWtzIH0pO1xuICAgIGNvbnN0IHBlbmRpbmdCcmVha3M6IFBsYW5uZXJCcmVha1tdID0gcHJvcG9zZWQuZmxhdE1hcCgocm93LCBpbmRleCkgPT4ge1xuICAgICAgY29uc3QgYWN0aXZlU2hpZnQgPSBhY3RpdmVTaGlmdEF0VGltZShibG9ja1NoaWZ0cywgYmxvY2subWVtYmVyX2lkLCByb3cuc3RhcnRfdGltZSk7XG4gICAgICBpZiAoIWFjdGl2ZVNoaWZ0KSByZXR1cm4gW107XG4gICAgICByZXR1cm4gW3tcbiAgICAgICAgaWQ6IC0oYmxvY2suaWQgKiAxMCArIGluZGV4ICsgMSksXG4gICAgICAgIHdvcmtfYmxvY2tfaWQ6IGJsb2NrLmlkLFxuICAgICAgICBzaGlmdF9pZDogYWN0aXZlU2hpZnQuaWQsXG4gICAgICAgIHN0YXJ0X3RpbWU6IHJvdy5zdGFydF90aW1lLFxuICAgICAgICBkdXJhdGlvbl9taW51dGVzOiByb3cuZHVyYXRpb25fbWludXRlcyxcbiAgICAgICAgY292ZXJfbWVtYmVyX2lkOiBudWxsLFxuICAgICAgICBvZmZfbWVtYmVyX2lkOiBibG9jay5tZW1iZXJfaWQsXG4gICAgICAgIG9mZl9zaGlmdF9pZDogYWN0aXZlU2hpZnQuaWQsXG4gICAgICAgIG9mZl9hcmVhX2tleTogYWN0aXZlU2hpZnQuaG9tZV9hcmVhX2tleVxuICAgICAgfV07XG4gICAgfSk7XG5cbiAgICBjb25zdCBhc3NpZ25tZW50cyA9IGFzc2lnbkJlc3RDb3ZlcnMocGxhbm5lciwgbG9ja2VkQnJlYWtzLCBwZW5kaW5nQnJlYWtzKTtcbiAgICBjb25zdCBjYW5kaWRhdGVCcmVha3MgPSBwZW5kaW5nQnJlYWtzLm1hcCgocm93KSA9PiAoe1xuICAgICAgLi4ucm93LFxuICAgICAgY292ZXJfbWVtYmVyX2lkOiBhc3NpZ25tZW50cy5nZXQocm93LmlkKSA/PyBudWxsXG4gICAgfSkpO1xuICAgIGNvbnN0IG1pc3NpbmdDb3VudCA9IChkdXJhdGlvbnMubGVuZ3RoIC0gcGVuZGluZ0JyZWFrcy5sZW5ndGgpICsgY2FuZGlkYXRlQnJlYWtzLnJlZHVjZShcbiAgICAgIChjb3VudCwgcm93KSA9PiBjb3VudCArIChpc0NvdmVyQXNzaWdubWVudFZhbGlkKHBsYW5uZXIsIFsuLi5sb2NrZWRCcmVha3MsIC4uLmNhbmRpZGF0ZUJyZWFrc10sIHJvdywgcm93LmNvdmVyX21lbWJlcl9pZCkgPyAwIDogMSksXG4gICAgICAwXG4gICAgKTtcblxuICAgIGlmIChcbiAgICAgIHBlbmRpbmdCcmVha3MubGVuZ3RoID4gYmVzdEdlbmVyYXRlZENvdW50IHx8XG4gICAgICAocGVuZGluZ0JyZWFrcy5sZW5ndGggPT09IGJlc3RHZW5lcmF0ZWRDb3VudCAmJiBtaXNzaW5nQ291bnQgPCBiZXN0TWlzc2luZ0NvdW50KVxuICAgICkge1xuICAgICAgYmVzdFBlbmRpbmdCcmVha3MgPSBwZW5kaW5nQnJlYWtzO1xuICAgICAgYmVzdEFzc2lnbm1lbnRzID0gYXNzaWdubWVudHM7XG4gICAgICBiZXN0TWlzc2luZ0NvdW50ID0gbWlzc2luZ0NvdW50O1xuICAgICAgYmVzdEdlbmVyYXRlZENvdW50ID0gcGVuZGluZ0JyZWFrcy5sZW5ndGg7XG4gICAgICBpZiAocGVuZGluZ0JyZWFrcy5sZW5ndGggPT09IGR1cmF0aW9ucy5sZW5ndGggJiYgbWlzc2luZ0NvdW50ID09PSAwKSBicmVhaztcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHBlbmRpbmdCcmVha3M6IGJlc3RQZW5kaW5nQnJlYWtzLFxuICAgIGFzc2lnbm1lbnRzOiBiZXN0QXNzaWdubWVudHMsXG4gICAgZ2VuZXJhdGVkQ291bnQ6IGJlc3RHZW5lcmF0ZWRDb3VudCxcbiAgICBtaXNzaW5nQ291bnQ6IGJlc3RNaXNzaW5nQ291bnQsXG4gICAgcmVxdWVzdGVkQnJlYWtDb3VudDogZHVyYXRpb25zLmxlbmd0aFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7OztBQ0RaLFNBQVMsVUFBVSxPQUE4QjtBQUN0RCxRQUFNLElBQUksK0JBQStCLEtBQUssTUFBTSxLQUFLLENBQUM7QUFDMUQsTUFBSSxDQUFDLEVBQUcsUUFBTztBQUNmLFFBQU0sS0FBSyxPQUFPLEVBQUUsQ0FBQyxDQUFDO0FBQ3RCLFFBQU0sS0FBSyxPQUFPLEVBQUUsQ0FBQyxDQUFDO0FBQ3RCLFNBQU8sS0FBSyxLQUFLO0FBQ25CO0FBdUJPLFNBQVMsT0FBTyxjQUE4QjtBQUNuRCxRQUFNLEtBQUssS0FBSyxNQUFNLGVBQWUsRUFBRSxJQUFJO0FBQzNDLFFBQU0sS0FBSyxlQUFlO0FBQzFCLFNBQU8sR0FBRyxPQUFPLEVBQUUsRUFB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
