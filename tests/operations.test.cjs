const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const baseline = 'a57ce4cc3ba4264f9a2260b4c8546293daa10afa';
const source = fs.readFileSync('backend/Code.gs', 'utf8').replace(/\r\n/g, '\n');
const original = cp.execFileSync('git', ['show', `${baseline}:backend/Code.gs`], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
const production = cp.execFileSync('git', ['show', 'c5b7bf0d6c1bf5b8b277b07f37abeac43750b7e9:backend/Code.gs'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
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
  const old = functions(production), next = functions(source);
  const changed = ['doPost', 'staffLogin', 'getAttendanceState', 'getStaffDashboard', 'getAdminDashboardFull'];
  assert.deepEqual([...next.keys()].filter(name => !old.has(name)), ['buildStaffAttendanceDashboard', 'getStaffAttendanceHistory']);
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
  ctx.rowMatchesStaffIdentity = (row, user) => row.login_id === user.login_id;
  ctx.listAttendanceRows = () => [{ login_id: staff.login_id, event_type: 'CHECK_IN', ip: 'private' }, { login_id: 'OTHER' }];
  assert.equal(ctx.getStaffAttendanceHistory({ ip: 'denied' }).ok, false);
  const result = ctx.getStaffAttendanceHistory({ ip: 'allowed' });
  assert.equal(result.attendance_events.length, 1);
  assert.equal(result.attendance_events[0].event_type, 'CHECK_IN');
  assert.equal('ip' in result.attendance_events[0], false);
});
