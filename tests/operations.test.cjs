const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const baseline = 'a57ce4cc3ba4264f9a2260b4c8546293daa10afa';
const source = fs.readFileSync('backend/Code.gs', 'utf8').replace(/\r\n/g, '\n');
const original = cp.execFileSync('git', ['show', `${baseline}:backend/Code.gs`], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
const production = cp.execFileSync('git', ['show', 'c5b7bf0d6c1bf5b8b277b07f37abeac43750b7e9:backend/Code.gs'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
const phaseOne = cp.execFileSync('git', ['show', 'ea513ae283caaf365b2ac023d26f9ca105fa9e17:backend/Code.gs'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
const staff = { ok: true, login_id: 'TEST001', team: 'CSP', status: 'ACTIVE' };
function backend(code) {
  const ctx = vm.createContext({ console });
  vm.runInContext(code, ctx);
  let scoreCalls = 0;
  const rows = [{ login_id: 'TEST001', attendance_score: 5, kpi_score: 3, final_score: 3.8, rank: 1 }];
  Object.assign(ctx, {
    clean: v => String(v ?? '').trim(), safeUpper: v => String(v).toUpperCase(), safeNumber: (v, d) => v ?? d,
    requireAllowedIp: ip => ip === 'denied' ? { ok: false, message: 'IP denied' } : null,
    getStaffByLogin: () => staff, getTeamTimezone: () => 'Asia/Colombo', todayDateForTimezone: () => '2026-11-16',
    todayDate: () => '2026-11-16', resolveScoreMonth: v => v || '2026-05', addDays: () => '2026-11-17',
    getScheduleForDate: () => ({ ok: true, shift_code: 'AM', status: 'WORKING' }),
    getAttendanceState: () => ({ hasCheckIn: true, counts: { BREAK: 1 } }), getMonthlySchedule: () => [], getNextSchedule: () => [],
    getCanonicalScores: () => { scoreCalls++; return { rows, dailyRows: [], kpiRows: [], debug: {} }; },
    getOwnKPI: () => null, listAttendanceRows: () => [], listDailyScoreRows: () => [],
    getStaffDeductionDetailsFromDailyScore: () => ({ rows: [], debug: {} }), listQuarterScoreRows: () => [],
    rowMatchesStaffIdentity: () => true, getQuarterLabelForMonth: () => 'Q4', getGrade: () => 'A',
    getAdminAccess: () => ({ allowed_team: 'CSP' }), listStaffRows: () => [staff], buildStaffAccessIndex: () => ({}),
    filterRowsForAdmin: rows => rows, listScheduleRows: () => [], getActiveBreakRows: () => [],
    listAuditRows: () => [], listTelegramRows: () => [], listIpRows: () => [], getNextShiftStaffRows: () => [],
    getTodaySummary: () => ({ currently_working: 0, summary_details: {} }), mergePerformanceIntoStaffRows: s => s
  });
  return { ctx, scoreCalls: () => scoreCalls };
}
for (const name of ['getStaffDashboard', 'getAdminDashboardFull']) {
  test(`${name}: operational read skips score builders; full contract unchanged`, () => {
    const before = backend(original), after = backend(source);
    const fullBefore = before.ctx[name]({ ip: 'allowed' });
    const fullAfter = after.ctx[name]({ ip: 'allowed' });
    assert.equal(JSON.stringify(fullAfter), JSON.stringify(fullBefore));
    assert.equal(after.scoreCalls(), 1);
    const light = after.ctx[name]({ ip: 'allowed', dashboard_mode: 'operations' });
    assert.equal(after.scoreCalls(), 1);
    assert.equal(light.ok, true);
    assert.equal(light.selected_month, '2026-05');
    for (const key of ['performance_details', 'daily_scores', 'quarter_scores', 'deduction_details', 'leaderboard']) assert.equal(key in light, false);
    const operationalKeys = name === 'getStaffDashboard'
      ? ['staff', 'today_schedule', 'attendance_state', 'monthly_schedule', 'upcoming_schedule']
      : ['summary', 'staff_list', 'schedule_list', 'attendance_events', 'breakBoard', 'audit_logs', 'telegram_logs', 'ip_allowlist'];
    for (const key of operationalKeys) assert.equal(JSON.stringify(light[key]), JSON.stringify(fullBefore[key]));
    assert.equal(after.ctx[name]({ ip: 'denied', dashboard_mode: 'operations' }).ok, false);
  });
}
test('protected production backend functions remain byte-identical', () => {
  const functions = s => new Map([...s.matchAll(/^function (\w+)\(/gm)].map(m => [m[1], s.slice(m.index, s.indexOf('\n}', m.index) + 2)]));
  const old = functions(phaseOne), next = functions(source);
  const changed = ['getScheduleForDate', 'resolveAttendanceSchedule', 'buildStaffAttendanceDashboard', 'getStaffAttendanceHistory',
    'getActiveBreakRows', 'getAdminDashboardFull', 'getTodaySummary', 'listScheduleRows'];
  assert.deepEqual([...next.keys()], [...old.keys()]);
  for (const [name, body] of old) if (!changed.includes(name)) assert.equal(next.get(name), body, name);
});
test('attendance-first responses skip unrelated work and preserve legacy operations mode', t => {
  const before = backend(production), after = backend(source);
  const payload = { ip: 'allowed', dashboard_mode: 'operations' };
  for (const name of ['getStaffDashboard', 'getAdminDashboardFull']) {
    const old = before.ctx[name](payload);
    assert.equal(JSON.stringify(after.ctx[name](payload)), JSON.stringify(old));
    const skipped = ['resolveScoreMonth', 'getMonthlySchedule', 'getNextSchedule', 'getCanonicalScores', 'listAuditRows', 'listTelegramRows', 'listIpRows'];
    skipped.forEach(key => { after.ctx[key] = () => { throw Error(key); }; });
    const light = after.ctx[name]({ ...payload, dashboard_mode: 'attendance_first' });
    assert.equal(light.ok, true);
    assert.equal(after.ctx[name]({ ip: 'denied', dashboard_mode: 'attendance_first' }).ok, false);
    const beforeBytes = Buffer.byteLength(JSON.stringify(old));
    const afterBytes = Buffer.byteLength(JSON.stringify(light));
    assert.ok(afterBytes < beforeBytes);
    t.diagnostic(JSON.stringify({ endpoint: name, fixtureBytesBefore: beforeBytes, fixtureBytesAfter: afterBytes }));
    for (const key of ['monthly_schedule', 'upcoming_schedule', 'staff_list', 'audit_logs', 'ip_allowlist', 'attendance_events']) assert.equal(key in light, false);
    Object.assign(after.ctx, Object.fromEntries(skipped.map(key => [key, before.ctx[key]])));
  }
});

test('login opt-in builds authorized bootstrap without changing legacy login', () => {
  const { ctx } = backend(source);
  let audits = 0;
  ctx.appendAudit = () => audits++;
  assert.equal(ctx.staffLogin({ login_id: staff.login_id, ip: 'denied', dashboard_mode: 'attendance_first' }).ok, false);
  assert.equal(audits, 0);
  assert.equal(ctx.staffLogin({ login_id: staff.login_id, ip: 'allowed' }).attendance_bootstrap, undefined);
  const result = ctx.staffLogin({ login_id: staff.login_id, ip: 'allowed', dashboard_mode: 'attendance_first' });
  assert.equal(result.attendance_bootstrap.staff.login_id, staff.login_id);
  assert.equal(result.attendance_bootstrap.ip.allowed, true);
  assert.equal(audits, 2);
});

test('overnight attendance-first uses the existing previous-day active-session fallback', () => {
  const { ctx } = backend(source);
  ctx.addDays = () => '2026-11-15';
  ctx.getScheduleForDate = (_, date) => date === '2026-11-15'
    ? { ok: true, shift_code: 'PM', status: 'WORKING' } : { ok: false };
  const response = ctx.getStaffDashboard({ ip: 'allowed', dashboard_mode: 'attendance_first' });
  assert.equal(response.today_schedule.schedule_date, '2026-11-15');
  assert.equal(response.attendance_state.hasCheckIn, true);
});

test('attendance history is IP-gated, staff-scoped and excludes raw event metadata', () => {
  const { ctx } = backend(source);
  ctx.getStaffByLogin = key => key === 'TEST001' ? { ...staff, staff_id: 'TEST-ID', full_name: 'Shared Name' } : { ok: false };
  let reads = 0;
  ctx.getValues = () => {
    reads++;
    return [
      ['login_id', 'staff_id', 'full_name', 'event_date', 'event_time', 'event_type', 'ip'],
      ['OTHER', 'TEST-ID', 'Shared Name', '2026-11-16', '08:00', 'CHECK_OUT', 'private'],
      ['', '', 'Shared Name', '2026-11-16', '08:00', 'CHECK_OUT', 'private'],
      ['', 'TEST-ID', 'Shared Name', '2026-11-16', '08:00', 'CHECK_IN', 'private'],
      [' test001 ', 'OLD-ID', 'Other casing', '2026-11-16', '09:00', 'BREAK_START', 'private']
    ];
  };
  assert.equal(ctx.getStaffAttendanceHistory({ ip: 'denied' }).ok, false);
  assert.equal(ctx.getStaffAttendanceHistory({ ip: 'allowed', login_id: 'UNKNOWN' }).ok, false);
  assert.equal(reads, 0);
  const result = ctx.getStaffAttendanceHistory({ ip: 'allowed', login_id: 'TEST001' });
  assert.equal(reads, 1);
  assert.equal(result.attendance_events.length, 2);
  assert.equal(result.attendance_events[0].event_type, 'BREAK_START');
  assert.equal(result.attendance_events[1].event_type, 'CHECK_IN');
  assert.equal('ip' in result.attendance_events[0], false);
});

test('attendance-first schedule prefilter returns the same date rows with less mapping', t => {
  const fixture = [['schedule_date', 'shift_code'], ...Array.from({ length: 1000 }, (_, i) =>
    [i === 600 ? '2026-11-16' : '2026-11-15', 'AM'])];
  const counts = [];
  const results = [];
  for (const [code, fast] of [[phaseOne, false], [source, true]]) {
    const ctx = vm.createContext({ console });
    vm.runInContext(code, ctx);
    let mapped = 0;
    const map = ctx.mapScheduleRow;
    ctx.getValues = () => fixture;
    ctx.mapScheduleRow = (...args) => { mapped++; return map(...args); };
    const started = performance.now();
    results.push(JSON.stringify(ctx.listScheduleRows('', '2026-11-16', fast)));
    counts.push(mapped);
    t.diagnostic(JSON.stringify({ version: fast ? 'phase-2' : 'baseline', mapped, mockedMs: +(performance.now() - started).toFixed(2) }));
  }
  assert.equal(results[0], results[1]);
  assert.deepEqual(counts, [1000, 1]);
});

test('admin attendance-first shares the event parse without changing scoped summary or break rows', t => {
  const snapshots = [];
  const parsing = [];
  for (const code of [phaseOne, source]) {
    const ctx = vm.createContext({ console });
    vm.runInContext(code, ctx);
    let parses = 0;
    let staffBuilds = 0;
    const people = [{ full_name: 'CSP Person', login_id: 'CSP1', team: 'CSP', status: 'ACTIVE' },
      { full_name: 'Affiliate Person', login_id: 'AFF1', team: 'Affiliate', status: 'ACTIVE' }];
    Object.assign(ctx, {
      requireAllowedIp: () => null, getAdminAccess: () => ({ allowed_team: 'CSP' }),
      todayDate: () => '2026-11-16', nowTime: () => '12:00:00',
      listStaffRows: () => { staffBuilds++; return people; },
      listScheduleRows: () => [], getNextShiftStaffRows: () => [],
      listAttendanceRows: () => {
        parses++;
        return people.map(row => ({ ...row, event_date: '2026-11-16', event_time: '11:00:00', event_type: 'BREAK_START' }));
      }
    });
    const result = ctx.getAdminDashboardFull({ dashboard_mode: 'attendance_first' });
    assert.deepEqual(Array.from(result.breakBoard, row => row.login_id), ['CSP1']);
    const { generated_at, ...snapshot } = result;
    snapshots.push(JSON.stringify(snapshot));
    parsing.push([parses, staffBuilds]);
  }
  assert.equal(snapshots[0], snapshots[1]);
  assert.deepEqual(parsing, [[2, 3], [1, 1]]);
  t.diagnostic('Admin fixture event parses 2 -> 1; staff list builds 3 -> 1. Physical Sheet reads unchanged.');
});
