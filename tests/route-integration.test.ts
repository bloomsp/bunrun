import test from 'node:test';
import assert from 'node:assert/strict';

import { POST as loginPOST } from '../src/pages/api/login.ts';
import { POST as assignCoverPOST } from '../src/pages/api/breaks/assign-cover.ts';
import { POST as areaAddPOST } from '../src/pages/api/areas/add.ts';
import { POST as breakAddPOST } from '../src/pages/api/breaks/add.ts';
import { POST as breakRecordTakenPOST } from '../src/pages/api/breaks/record-taken.ts';
import { POST as autofixPOST } from '../src/pages/api/breaks/autofix.ts';
import { POST as autogenPOST } from '../src/pages/api/breaks/autogen.ts';
import { POST as autogenAllPOST } from '../src/pages/api/breaks/autogen-all.ts';
import { POST as memberAddPOST } from '../src/pages/api/members/add.ts';
import { POST as memberUpdatePOST } from '../src/pages/api/members/update.ts';
import { POST as copyDayPOST } from '../src/pages/api/schedule/copy-day.ts';
import { POST as copyWeekPOST } from '../src/pages/api/schedule/copy-week.ts';
import { POST as shiftUpsertPOST } from '../src/pages/api/shifts/upsert.ts';
import { POST as shiftUpdatePOST } from '../src/pages/api/shifts/update.ts';
import { adminRequest, installTestDB, installWorkBlockHooks, resetRouteTestGlobals, RouteDB } from './helpers/route-test-helpers.ts';

test.afterEach(() => {
  resetRouteTestGlobals();
});

test('login route rejects invalid content type before env checks', async () => {
  const response = await loginPOST({
    request: new Request('https://example.test/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin', password: 'x' })
    })
  } as any);

  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Invalid form submission');
});

test('assign-cover route persists a valid cover selection', async () => {
  const db = new RouteDB();
  db.firstHandlers.set('FROM breaks b', {
    break_id: 5,
    start_time: '09:00',
    duration_minutes: 15,
    off_shift_id: 1,
    schedule_id: 99,
    home_area_key: 'registers',
    off_member_id: 10
  });
  db.allHandlers.set('FROM shifts WHERE schedule_id=?', [
    { id: 1, member_id: 10, home_area_key: 'registers', status_key: 'working', shift_role: 'normal', start_time: '06:00', end_time: '12:00' },
    { id: 2, member_id: 20, home_area_key: 'registers', status_key: 'working', shift_role: 'floater', start_time: '06:00', end_time: '12:00' }
  ]);
  db.allHandlers.set('SELECT id, all_areas FROM members', [
    { id: 10, all_areas: 1 },
    { id: 20, all_areas: 1 }
  ]);
  db.allHandlers.set('SELECT member_id, area_key FROM member_area_permissions', []);
  db.allHandlers.set('SELECT key, min_staff FROM areas', [{ key: 'registers', min_staff: 1 }]);
  db.allHandlers.set('SELECT shift_id, member_id, priority FROM shift_cover_priorities', [{ shift_id: 1, member_id: 20, priority: 1 }]);
  db.allHandlers.set('FROM breaks b\n       JOIN shifts s ON s.id = b.shift_id', [
    { id: 5, work_block_id: 1, shift_id: 1, start_time: '09:00', duration_minutes: 15, cover_member_id: null, off_member_id: 10, off_area_key: 'registers' }
  ]);
  installTestDB(db);

  const response = await assignCoverPOST({
    request: adminRequest('https://example.test/api/breaks/assign-cover', {
      date: '2026-04-07',
      breakId: '5',
      coverMemberId: '20',
      returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/admin/schedule/2026-04-07?panel=breaks&notice=Cover+updated#breaks');
  assert.ok(db.runs.some((run) => run.sql.includes('UPDATE breaks SET cover_member_id=? WHERE id=?') && run.args[0] === 20 && run.args[1] === 5));
});

test('assign-cover route rejects an unavailable cover selection', async () => {
  const db = new RouteDB();
  db.firstHandlers.set('FROM breaks b', {
    break_id: 5,
    start_time: '09:00',
    duration_minutes: 15,
    off_shift_id: 1,
    schedule_id: 99,
    home_area_key: 'registers',
    off_member_id: 10
  });
  db.allHandlers.set('FROM shifts WHERE schedule_id=?', [
    { id: 1, member_id: 10, home_area_key: 'registers', status_key: 'working', shift_role: 'normal', start_time: '06:00', end_time: '12:00' },
    { id: 2, member_id: 20, home_area_key: 'service-desk', status_key: 'sick', shift_role: 'normal', start_time: '06:00', end_time: '12:00' }
  ]);
  db.allHandlers.set('SELECT id, all_areas FROM members', [
    { id: 10, all_areas: 1 },
    { id: 20, all_areas: 0 }
  ]);
  db.allHandlers.set('SELECT member_id, area_key FROM member_area_permissions', []);
  db.allHandlers.set('SELECT key, min_staff FROM areas', [{ key: 'registers', min_staff: 1 }]);
  db.allHandlers.set('SELECT shift_id, member_id, priority FROM shift_cover_priorities', [{ shift_id: 1, member_id: 20, priority: 1 }]);
  db.allHandlers.set('FROM breaks b\n       JOIN shifts s ON s.id = b.shift_id', [
    { id: 5, work_block_id: 1, shift_id: 1, start_time: '09:00', duration_minutes: 15, cover_member_id: null, off_member_id: 10, off_area_key: 'registers' }
  ]);
  installTestDB(db);

  const response = await assignCoverPOST({
    request: adminRequest('https://example.test/api/breaks/assign-cover', {
      date: '2026-04-07',
      breakId: '5',
      coverMemberId: '20',
      returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Selected\+cover\+member\+is\+not\+available/);
  assert.equal(db.runs.length, 0);
});

test('areas-add route reports duplicate key/name insert failures', async () => {
  const db = new RouteDB();
  db.run = async (sql: string, args: any[]) => {
    db.runs.push({ sql, args });
    if (sql.includes('INSERT INTO areas')) {
      throw new Error('UNIQUE constraint failed: areas.key');
    }
    return { meta: { changes: 1, last_row_id: 1 } };
  };
  installTestDB(db);

  const response = await areaAddPOST({
    request: adminRequest('https://example.test/api/areas/add', {
      key: 'registers',
      label: 'Registers',
      minStaff: '2'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=That\+area\+key\+or\+name\+is\+already\+in\+use/);
});

test('members-add route rejects unknown areas', async () => {
  const db = new RouteDB();
  db.allHandlers.set('SELECT key FROM areas', [{ key: 'registers' }]);
  installTestDB(db);

  const response = await memberAddPOST({
    request: adminRequest('https://example.test/api/members/add', {
      name: 'Jamie',
      defaultAreaKey: 'registers',
      breakPreference: '15+30',
      returnTo: '/admin/members',
      areas: 'service-desk'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Unknown\+area/);
});

test('breaks-add route rejects invalid times', async () => {
  const response = await breakAddPOST({
    request: adminRequest('https://example.test/api/breaks/add', {
      date: '2026-04-07',
      workBlockId: '12',
      hh: '99',
      mm: '00',
      duration: '15',
      returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Invalid\+hour/);
});

test('breaks-record-taken route persists actual break time', async () => {
  const db = new RouteDB();
  db.firstHandlers.set('FROM breaks b', { id: 55 });
  installTestDB(db);

  const response = await breakRecordTakenPOST({
    request: adminRequest('https://example.test/api/breaks/record-taken', {
      date: '2026-04-07',
      breakId: '55',
      hh: '09',
      mm: '12',
      returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/admin/schedule/2026-04-07?panel=breaks&notice=Actual+break+time+recorded#breaks');
  assert.ok(db.runs.some((run) => run.sql.includes('UPDATE breaks SET actual_start_time=?, actual_start_source=? WHERE id=?') && run.args[0] === '09:12' && run.args[1] === 'manual' && run.args[2] === 55));
});

test('breaks-record-taken route supports taken-now stamping', async () => {
  const db = new RouteDB();
  db.firstHandlers.set('FROM breaks b', { id: 56 });
  installTestDB(db);

  const realDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = class extends realDateTimeFormat {
    formatToParts() {
      return [
        { type: 'hour', value: '10' },
        { type: 'literal', value: ':' },
        { type: 'minute', value: '34' }
      ] as Intl.DateTimeFormatPart[];
    }
  } as typeof Intl.DateTimeFormat;

  try {
    const response = await breakRecordTakenPOST({
      request: adminRequest('https://example.test/api/breaks/record-taken', {
        date: '2026-04-07',
        breakId: '56',
        takenNow: '1',
        returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
      })
    } as any);
    
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/admin/schedule/2026-04-07?panel=breaks&notice=Actual+break+time+set+to+now#breaks');
    assert.ok(db.runs.some((run) => run.sql.includes('UPDATE breaks SET actual_start_time=?, actual_start_source=? WHERE id=?') && run.args[0] === '10:34' && run.args[1] === 'live' && run.args[2] === 56));
  } finally {
    Intl.DateTimeFormat = realDateTimeFormat;
  }
});

test('members-update route persists member changes and permission batch updates', async () => {
  const db = new RouteDB();
  db.allHandlers.set('SELECT key FROM areas', [{ key: 'registers' }, { key: 'service-desk' }]);
  installTestDB(db);

  const response = await memberUpdatePOST({
    request: adminRequest('https://example.test/api/members/update', {
      memberId: '42',
      name: 'Alex',
      defaultAreaKey: 'registers',
      breakPreference: '15+30',
      returnTo: '/admin/members'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/admin/members?notice=Member+updated');
  assert.ok(db.runs.some((run) => run.sql.includes('UPDATE members SET name=?, all_areas=?, default_area_key=?, break_preference=? WHERE id=?') && run.args[0] === 'Alex'));
  assert.ok(db.batches.some((batch) => batch.some((stmt) => stmt.sql.includes('DELETE FROM member_area_permissions WHERE member_id=?') && stmt.args[0] === 42)));
});

test('breaks-autofix route rejects invalid dates before DB access', async () => {
  const response = await autofixPOST({
    request: adminRequest('https://example.test/api/breaks/autofix', {
      date: 'not-a-date',
      returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Invalid\+date/);
});

test('breaks-autogen route rejects a work block with no working shifts', async () => {
  const db = new RouteDB();
  db.firstHandlers.set('FROM work_blocks wb', {
    id: 15,
    schedule_id: 99,
    member_id: 10,
    start_time: '06:00',
    end_time: '12:00',
    total_minutes: 360,
    break_preference: '15+30'
  });
  db.allHandlers.set('FROM shifts WHERE schedule_id=?', [
    { id: 1, work_block_id: 15, member_id: 10, home_area_key: 'registers', status_key: 'sick', shift_role: 'normal', start_time: '06:00', end_time: '12:00' }
  ]);
  db.allHandlers.set('SELECT id, all_areas FROM members', [{ id: 10, all_areas: 1 }]);
  db.allHandlers.set('SELECT member_id, area_key FROM member_area_permissions', []);
  db.allHandlers.set('SELECT key, min_staff FROM areas', [{ key: 'registers', min_staff: 1 }]);
  db.allHandlers.set('FROM breaks b\n       JOIN shifts s ON s.id = b.shift_id', []);
  db.allHandlers.set('SELECT shift_id, member_id, priority FROM shift_cover_priorities', []);
  installTestDB(db);

  const response = await autogenPOST({
    request: adminRequest('https://example.test/api/breaks/autogen', {
      date: '2026-04-07',
      workBlockId: '15',
      returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=No\+working\+shifts\+found\+for\+this\+work\+block/);
});

test('copy-day route rejects same source and target date', async () => {
  installTestDB(new RouteDB());

  const response = await copyDayPOST({
    request: adminRequest('https://example.test/api/schedule/copy-day', {
      sourceDate: '2026-04-07',
      targetDate: '2026-04-07'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Source\+and\+target\+day\+must\+be\+different/);
});

test('autogen-all route rejects invalid mode values', async () => {
  const response = await autogenAllPOST({
    request: adminRequest('https://example.test/api/breaks/autogen-all', {
      date: '2026-04-07',
      mode: 'bad-mode',
      returnTo: '/admin/schedule/2026-04-07?panel=breaks#breaks'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Invalid\+mode/);
});

test('copy-week route rejects when source and target are in the same week', async () => {
  installTestDB(new RouteDB());

  const response = await copyWeekPOST({
    request: adminRequest('https://example.test/api/schedule/copy-week', {
      sourceWeekDate: '2026-04-07',
      targetWeekDate: '2026-04-09'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Source\+and\+target\+week\+must\+be\+different/);
});

test('shifts-upsert route rejects overlapping shifts for the same member', async () => {
  const db = new RouteDB();
  db.firstHandlers.set('SELECT all_areas FROM members WHERE id=?', { all_areas: 1 });
  db.firstHandlers.set('SELECT id FROM schedules WHERE date=?', { id: 50 });
  db.allHandlers.set('SELECT id, member_id, home_area_key, status_key, start_time, end_time FROM shifts WHERE schedule_id=? AND member_id=?', [
    { id: 1, member_id: 7, home_area_key: 'registers', status_key: 'working', start_time: '09:00', end_time: '12:00' }
  ]);
  installTestDB(db);

  const response = await shiftUpsertPOST({
    request: adminRequest('https://example.test/api/shifts/upsert', {
      date: '2026-04-07',
      memberId: '7',
      homeAreaKey: 'registers',
      statusKey: 'working',
      shiftRole: 'normal',
      startTime: '11:00',
      endTime: '14:00'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /error=Shift\+overlaps\+an\+existing\+shift/);
});

test('shift-update route clears overlapping cover assignments when marking a shift sick', async () => {
  const db = new RouteDB();
  db.firstHandlers.set('SELECT schedule_id, member_id, start_time, end_time, work_block_id FROM shifts WHERE id=?', {
    schedule_id: 77,
    member_id: 20,
    start_time: '06:00',
    end_time: '12:00',
    work_block_id: 10
  });
  db.firstHandlers.set('SELECT all_areas FROM members WHERE id=?', { all_areas: 1 });
  db.allHandlers.set('SELECT id, member_id, home_area_key, status_key, start_time, end_time FROM shifts WHERE schedule_id=? AND member_id=?', [
    { id: 12, member_id: 20, home_area_key: 'registers', status_key: 'working', start_time: '06:00', end_time: '12:00' }
  ]);
  db.allHandlers.set('FROM breaks b\n           JOIN shifts s ON s.id = b.shift_id\n           WHERE s.schedule_id=? AND b.cover_member_id=?', [
    { id: 300, start_time: '09:00', duration_minutes: 30 },
    { id: 301, start_time: '12:30', duration_minutes: 15 }
  ]);
  installTestDB(db);
  installWorkBlockHooks({
    recomputeWorkBlocksForSchedule: () => {},
    clearMemberBreakPlanForSchedule: () => {}
  });

  const response = await shiftUpdatePOST({
    request: adminRequest('https://example.test/api/shifts/update', {
      date: '2026-04-07',
      shiftId: '12',
      homeAreaKey: 'registers',
      statusKey: 'sick',
      shiftRole: 'normal',
      startTime: '08:00',
      endTime: '11:00'
    })
  } as any);

  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /notice=Shift\+updated\+%28Sick\+applied%29\.\+Break\+plan\+cleared\+for\+that\+member\./);
  assert.ok(db.batches.some((batch) => batch.some((stmt) => stmt.sql.includes('DELETE FROM shift_cover_priorities'))));
  assert.ok(db.batches.some((batch) => batch.some((stmt) => stmt.sql.includes('UPDATE breaks SET cover_member_id=NULL WHERE id=?') && stmt.args[0] === 300)));
  assert.ok(!db.batches.some((batch) => batch.some((stmt) => stmt.sql.includes('UPDATE breaks SET cover_member_id=NULL WHERE id=?') && stmt.args[0] === 301)));
});
