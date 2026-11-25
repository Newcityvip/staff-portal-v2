const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cp = require('node:child_process');
const baseline = 'a57ce4cc3ba4264f9a2260b4c8546293daa10afa';
const source = fs.readFileSync('backend/Code.gs', 'utf8').replace(/\r\n/g, '\n');
const original = cp.execFileSync('git', ['show', `${baseline}:backend/Code.gs`], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
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
test('legacy action routing and functions outside the dashboard and roster changes remain byte-identical', () => {
  const functions = s => new Map([...s.matchAll(/^function (\w+)\(/gm)].map((m, i, all) => [m[1], s.slice(m.index, all[i + 1]?.index ?? s.length)]));
  const old = functions(original), next = functions(source);
  assert.equal(old.size, next.size);
  const sharedActions = '      case "v2_dispatch_verified_leave":\n      case "v2_verify_leave_receipt":\n        result = verifiedRosterRequest_(body);\n        break;\n';
  assert.ok(next.get('doPost').includes(sharedActions));
  assert.equal(next.get('doPost').replace(sharedActions,''),old.get('doPost'));
  for (const [name, body] of old) {
    if (!['doPost','getStaffDashboard','getAdminDashboardFull','uploadScheduleCsv','updateSingleStaffSchedule'].includes(name)) {
      assert.equal(next.get(name),body,name);
    }
  }
});
test('attendance write routing, session code and action handler remain unchanged', () => {
  for (const [file, from, to] of [
    ['js/staff.js', '  const bindActions =', '  const applyDisplayOnlyLabels'],
    ['js/app.js', '    async action(', '  const getSession'],
    ['js/app.js', '  const getSession', '  const normalizeSession']
  ]) {
    const old = cp.execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
    const next = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const section = s => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));
    assert.equal(section(next), section(old), file);
  }
});
