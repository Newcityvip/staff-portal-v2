// Uses an already installed Playwright runtime; no production requests or writes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, channel: process.env.PORTAL_TEST_BROWSER || 'chrome' }); });
after(async () => { await browser?.close(); });
const day = new Date().toISOString().slice(0, 10);
const staff = { full_name: 'Test Staff', login_id: 'TEST001', team: 'CSP', role: 'Agent', status: 'ACTIVE' };
const shift = { ok: true, schedule_date: day, shift_code: 'AM', status: 'WORKING', start_time: '06:30', end_time: '15:30' };
function payload(role, code = 'AM', baseline = false) {
  const schedule = { ...shift, shift_code: code, status: code === 'AM' ? 'WORKING' : code };
  const metadata = { ok: true, dashboard_mode: 'attendance_first', generated_at: new Date().toISOString() };
  return role === 'staff' ? { ...metadata, staff, today: day, timezone: 'UTC', ip: { allowed: true, address: '192.0.2.1' }, today_schedule: schedule,
    attendance_state: { hasCheckIn: false, hasCheckOut: false, activeBreak: '', counts: { BREAK: 0, BIO_BREAK: 0, PRAYER_BREAK: 0 } },
    ...(baseline ? { selected_month: day.slice(0, 7), monthly_schedule: [schedule], upcoming_schedule: [schedule] } : {}) }
    : { ...metadata, summary: { total_staff: 1, summary_details: { total_staff: [staff] } },
      breakBoard: [], next_shift_staff_all: [],
      ...(baseline ? { staff_list: [staff], schedule_list: [schedule], attendance_events: [], audit_logs: [], telegram_logs: [], ip_allowlist: [] } : {}) };
}
async function fixture(role, options = {}) {
  const context = await browser.newContext(options.viewport ? { viewport: options.viewport } : {});
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  const control = { response: payload(role, 'AM', options.baseline), status: 200, fail: false, hold: null, ...options };
  let lastAdminTimestamp = 0;
  const responseSnapshot = action => {
    const data = control.response;
    if (role !== 'admin' || !/^get_.*dashboard/.test(action) || !data?.generated_at || control.fixedAdminTimestamp) return data;
    lastAdminTimestamp = Math.max(lastAdminTimestamp + 1, Date.now(), Date.parse(data.generated_at));
    return { ...data, generated_at: new Date(lastAdminTimestamp).toISOString() };
  };
  await context.addInitScript(({ role, handoff, sessionIp, login }) => {
    if (location.pathname.endsWith('/index.html')) return;
    if (login) return;
    const createdAt = Date.now();
    localStorage.setItem('staffPortalV2.session', JSON.stringify({ role, loginId: 'TEST001', staffId: 'TEST-ID', name: 'Test Staff', createdAt, ip: sessionIp || '192.0.2.1' }));
    localStorage.setItem('staffPortalV2.clientIp', '192.0.2.1');
    if (handoff && !sessionStorage.getItem('test.handoffSeeded')) {
      sessionStorage.setItem('test.handoffSeeded', '1');
      sessionStorage.setItem('spv2_staff_attendance_bootstrap', JSON.stringify({ data: handoff, createdAt }));
    }
  }, { role, handoff: options.handoff, sessionIp: options.sessionIp, login: options.login });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.cloudflare.com' && url.pathname === '/cdn-cgi/trace') {
      requests.push({ action: 'trace' });
      return route.fulfill({ status: options.traceUnavailable ? 503 : 200, body: 'ip=192.0.2.1\n',
        headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (url.hostname === 'staff-portal-api-v2.mdrobiulislam.workers.dev') {
      const body = route.request().postDataJSON() || {};
      requests.push(body);
      if (options.login && route.request().method() === 'GET') return route.fulfill({ json: { ok: true } });
      if (options.login && ['clientIp', 'getClientIp', 'ipStatus', 'checkIp', 'getIp'].includes(body.action)) {
        return route.fulfill({ json: options.unsupportedIpAliases ? { ok: false, message: 'Invalid action' } : { ok: true, ip: '192.0.2.1' } });
      }
      if (options.login && body.action === 'staff_login') return route.fulfill({ json: {
        ok: true, staff, attendance_bootstrap: { ...payload(role), generated_at: new Date().toISOString() }
      } });
      if (body.action === 'get_staff_attendance_history') {
        if (control.historyHold) await control.historyHold;
        return route.fulfill({ status: control.historyStatus || 200,
          json: control.historyResult ?? { ok: true, attendance_events: [{ event_type: 'CHECK_IN' }] } });
      }
      if (body.action === 'attendance_action' && control.dropWrite) return route.abort('failed');
      if (body.action === 'save_monthly_kpi') return route.fulfill({ json: { ok: true } });
      if (role === 'admin' && /^get_.*dashboard/.test(body.action) && control.adminRead) {
        return control.adminRead(route, responseSnapshot(body.action));
      }
      if (/^get_.*dashboard/.test(body.action) && control.holdDashboard) {
        const snapshot = structuredClone(responseSnapshot(body.action));
        await control.holdDashboard;
        return route.fulfill({ json: snapshot });
      }
      if (control.hold) await control.hold;
      if (control.fail) return route.abort('failed');
      if (body.action === 'attendance_action') {
        if (control.actionResult) return route.fulfill({ json: control.actionResult });
        const state = control.response.attendance_state;
        if (body.event_type === 'CHECK_IN') state.hasCheckIn = true;
        if (body.event_type === 'CHECK_OUT') state.hasCheckOut = true;
        if (body.event_type === 'BREAK_START') { state.activeBreak = body.break_type; state.breakStartedAt = new Date(Date.now() - 60000).toISOString(); }
        if (body.event_type === 'BREAK_END') { state.activeBreak = ''; state.breakStartedAt = null; }
        return route.fulfill({ json: { ok: true, event_id: "test-event", state } });
      }
      return route.fulfill({ status: control.status, json: responseSnapshot(body.action) });
    }
    if (url.hostname !== 'portal.test') throw Error('Unexpected external request: ' + url.hostname);
    const file = url.pathname.replace(/^\/(?:staff-portal-v2\/)?/, '') || 'index.html';
    const ref = options.phaseTwo ? 'cc49017d9e3f4b9402b28510312647f15c335350' :
      options.phaseOne ? 'ea513ae283caaf365b2ac023d26f9ca105fa9e17' :
      options.baseline ? 'c5b7bf0d6c1bf5b8b277b07f37abeac43750b7e9' : null;
    let body = ref ? cp.execFileSync('git', ['show', `${ref}:${file}`]) : fs.readFileSync(file);
    const ext = path.extname(file);
    return route.fulfill({ body, contentType: ext === '.js' ? 'application/javascript' :
      ext === '.css' ? 'text/css' : ext === '.svg' ? 'image/svg+xml' : 'text/html' });
  });
  const started = performance.now();
  await page.goto(`https://portal.test/${options.repoPath ? 'staff-portal-v2/' : ''}${options.login ? 'index' : role}.html`);
  return { context, page, control, requests, errors, started };
}
for (const role of ['staff', 'admin']) {
  test(`${role}: successful operational rendering, safe link, empty data and recovery`, async () => {
    const f = await fixture(role);
    try {
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].dashboard_mode, 'attendance_first');
      const link = f.page.locator('a[href="https://staff-performance-score.pages.dev/"]');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await f.page.locator('#leaderboardPreview, #topPerformers, #kpiChart, #upcomingSchedule, #scheduleTable, #staffTable, #attendanceBoard, #dailyLogs, #telegramLogs, #auditLogs, #saveIpBtn, #singleScheduleForm').count(), 0);
      assert.equal(await f.page.locator('a[href="https://staff-leave-management-v1.pages.dev/"]').getAttribute('rel'), 'noopener noreferrer');
      if (role === 'admin') {
        await f.page.locator('#totalStaff').click();
        assert.match(await f.page.locator('#dataModalBody').textContent(), /Test Staff/);
        await f.page.locator('#dataModal [data-modal-close]').click();
        for (const id of ['scheduleUploadForm', 'kpiInputForm', 'breakBoard', 'nextShiftStaff', 'lastDashboardUpdate']) assert.equal(await f.page.locator('#' + id).count(), 1);
      }
      await f.page.clock.install();
      f.control.response = {};
      await f.page.clock.runFor(15001);
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent.includes('Stale'));
      assert.equal(await f.page.locator('#dashboardRetry').isVisible(), true);
      f.control.response = payload(role);
      await f.page.locator('#dashboardRetry').click();
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      for (let i = 0; i < 3; i++) {
        await f.page.clock.runFor(15001);
        await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      }
      assert.deepEqual(f.errors, []);
      await f.page.screenshot({ path: path.join(require('node:os').tmpdir(), `portal-${role}-operations.png`), fullPage: true });
    } finally { await f.context.close(); }
  });
}

test('admin dashboard links to the independently authenticated Monthly Roster Builder under the repository path', async () => {
  const admin = await fixture('admin', { repoPath: true });
  const staff = await fixture('staff', { repoPath: true });
  try {
    const roster = admin.page.getByRole('link', { name: 'Monthly Roster Builder' });
    await roster.waitFor();
    assert.equal(await roster.evaluate(link => link.href), 'https://portal.test/staff-portal-v2/admin-roster-source.html?source=live');
    await roster.click();
    await admin.page.getByText('Live roster access is disabled.', { exact: true }).waitFor();
    assert.equal(admin.requests.filter(r => r.action === 'admin_login' || r.action === 'roster_v1').length, 0);
    await staff.page.goto('https://portal.test/staff-portal-v2/admin.html');
    await staff.page.waitForURL('**/staff.html');
    assert.equal(await staff.page.getByRole('link', { name: 'Monthly Roster Builder' }).count(), 0);
  } finally {
    await admin.context.close();
    await staff.context.close();
  }
});
for (const code of ['OFF', 'AL', 'UL']) {
  test(`staff ${code}: valid schedule, attendance remains blocked`, async () => {
    const f = await fixture('staff', { response: payload('staff', code) });
    try {
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      assert.equal(await f.page.locator('[data-action="checkIn"]').isDisabled(), true);
      assert.equal(await f.page.locator('#shiftName').textContent(), code);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
}
for (const scenario of ['empty', 'denied', 'network', 'timeout']) {
  test(`initial ${scenario}: actionable error rather than endless Loading`, async () => {
    const f = await fixture('staff', { response: scenario === 'denied' ? { ok: false, message: 'IP denied' } : {}, fail: scenario === 'network' });
    try {
      if (scenario === 'timeout') {
        await f.page.clock.install();
        f.control.hold = new Promise(() => {});
        // Retry starts a deliberately unresolved read; advance the original timeout budget.
        await f.page.locator('#dashboardRetry').waitFor({ state: 'visible' });
        await f.page.locator('#dashboardRetry').click();
        await f.page.clock.runFor(32000);
      }
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent.includes('unavailable'));
      assert.equal(await f.page.locator('#dashboardRetry').isVisible(), true);
      assert.equal(await f.page.locator('[data-action="checkIn"]').isDisabled(), true);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
}
test('mock writes: authoritative action results, single-flight clicks, break timer and logout', async () => {
  const f = await fixture('staff');
  try {
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
    for (const [action, event] of [['checkIn', 'CHECK_IN'], ['breakStart', 'BREAK_START'], ['breakEnd', 'BREAK_END'], ['checkOut', 'CHECK_OUT']]) {
      const actionStarted = performance.now();
      await f.page.locator(`[data-action="${action}"]`).click();
      await f.page.waitForFunction(event => [...document.querySelectorAll('.toast')].length > 0, event);
      await f.page.waitForFunction(() => !document.querySelector('[data-action="checkIn"] span').textContent.includes('Saving'));
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      assert.equal(f.requests.filter(r => r.event_type === event).length, 1);
      await f.page.waitForFunction(event => {
        if (event === 'CHECK_IN') return document.getElementById('attendanceStatus').textContent === 'Checked in';
        if (event === 'CHECK_OUT') return document.getElementById('attendanceStatus').textContent === 'Checked out';
        if (event === 'BREAK_START') return document.getElementById('breakStatus').textContent === 'BREAK';
        return document.getElementById('breakStatus').textContent === 'Not on break';
      }, event);
      if (event === 'BREAK_END') await f.page.waitForFunction(() => document.getElementById('breakTimer').textContent === '00:00:00');
      console.log(JSON.stringify({ event, mockActionAndReconciliationMs: Math.round(performance.now() - actionStarted) }));
    }
    assert.equal(await f.page.locator('#attendanceStatus').textContent(), 'Checked out');
    assert.deepEqual(f.errors, []);
    await f.page.locator('[data-logout]').first().click();
    await f.page.waitForURL('**/index.html');
    assert.equal(await f.page.evaluate(() => localStorage.getItem('staffPortalV2.session')), null);
  } finally { await f.context.close(); }
});

test('mobile staff/admin layouts remain usable without document overflow', async () => {
  for (const role of ['staff', 'admin']) {
    const f = await fixture(role, { viewport: { width: 390, height: 844 } });
    try {
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      const overflow = await f.page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth && !e.closest('.table-wrap')).map(e => e.id || e.className).slice(0, 12));
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify({ role, overflow }));
      await f.page.screenshot({ path: path.join(require('node:os').tmpdir(), `portal-${role}-mobile.png`), fullPage: true });
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  }
});

test('pending clicks and failed attendance writes are not retried or reported as success', async () => {
  const f = await fixture('staff');
  try {
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
    let release;
    f.control.hold = new Promise(resolve => { release = resolve; });
    await f.page.locator('[data-action="checkIn"]').click();
    await f.page.waitForFunction(() => document.getElementById('checkInState').textContent === 'Saving...');
    await f.page.locator('[data-action="checkIn"]').dispatchEvent('click');
    assert.equal(await f.page.locator('.toast').count(), 0);
    f.control.actionResult = { ok: false, message: 'Action blocked by server' };
    release();
    f.control.hold = null;
    await f.page.locator('.toast.error').waitFor();
    assert.equal(f.requests.filter(r => r.action === 'attendance_action').length, 1);
    assert.equal(await f.page.locator('#attendanceStatus').textContent(), 'Not checked in');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('valid empty admin data and missing staff schedule are not malformed', async () => {
  for (const role of ['admin', 'staff']) {
    const response = role === 'admin'
      ? { ...payload(role), summary: { total_staff: 0, summary_details: {} } }
      : { ...payload(role), today_schedule: { ok: false } };
    const f = await fixture(role, { response });
    try {
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  }
});

test('verified login handoff needs no dashboard read; history is explicit and reload reads state', async () => {
  const f = await fixture('staff', { handoff: payload('staff') });
  try {
    assert.equal(await f.page.locator('[data-action="checkIn"]').isEnabled(), true);
    assert.equal(f.requests.length, 0);
    await f.page.locator('#loadAttendanceHistory').click();
    await f.page.locator('#attendanceHistory').getByText('CHECK_IN').waitFor();
    assert.deepEqual(f.requests.map(row => row.action), ['get_staff_attendance_history']);
    await f.page.reload();
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
    assert.equal(f.requests.filter(row => row.action === 'get_staff_dashboard').length, 1);
  } finally { await f.context.close(); }
});

for (const [scenario, settings, message] of [
  ['wrapped success', { historyResult: { ok: true, data: { attendance_events: [{ event_type: 'CHECK_OUT' }] } } }, 'CHECK_OUT'],
  ['empty', { historyResult: { ok: true, attendance_events: [] } }, 'No attendance events found.'],
  ['denied', { historyStatus: 403, historyResult: { ok: false } }, 'Attendance history access denied.'],
  ['malformed', { historyResult: { ok: true, attendance_events: [null] } }, 'Unable to load attendance history.'],
  ['timeout', { historyHold: new Promise(() => {}) }, 'Attendance history timed out.']
]) {
  test(`history ${scenario}: appropriate feedback without changing attendance readiness`, async () => {
    const f = await fixture('staff', settings);
    try {
      await f.page.waitForFunction(() => !document.querySelector('[data-action="checkIn"]').disabled);
      if (scenario === 'timeout') await f.page.clock.install();
      const requested = f.page.waitForRequest(req => req.postDataJSON()?.action === 'get_staff_attendance_history');
      await f.page.locator('#loadAttendanceHistory').click();
      await requested;
      if (scenario === 'timeout') {
        assert.match(await f.page.locator('#attendanceHistory').textContent(), /Loading attendance history/);
        await f.page.clock.runFor(32000);
      }
      await f.page.locator('#attendanceHistory').getByText(message, { exact: false }).waitFor();
      assert.equal(await f.page.locator('[data-action="checkIn"]').isEnabled(), true);
      assert.equal(await f.page.evaluate(() => Boolean(localStorage.getItem('staffPortalV2.session'))), true);
    } finally { await f.context.close(); }
  });
}

test('fresh bootstrap tolerates small server clock skew; attendance remains ready without a second read', async () => {
  const f = await fixture('staff', { handoff: { ...payload('staff'), generated_at: new Date(Date.now() + 1000).toISOString() } });
  try {
    assert.equal(await f.page.locator('[data-action="checkIn"]').isEnabled(), true);
    assert.equal(f.requests.filter(row => row.action === 'get_staff_dashboard').length, 0);
  } finally { await f.context.close(); }
});

test('staff login avoids unsupported Worker aliases and retains fallback if trace fails', async t => {
  for (const [label, options, expected] of [
    ['baseline', { phaseOne: true, unsupportedIpAliases: true }, ['clientIp', 'getClientIp', 'ipStatus', 'checkIp', 'getIp', 'trace']],
    ['phase-2', { unsupportedIpAliases: true }, ['trace']],
    ['fallback', { traceUnavailable: true }, ['trace', 'clientIp']]
  ]) {
    const f = await fixture('staff', { login: true, ...options });
    try {
      const started = performance.now();
      await f.page.locator('#identity').fill('TEST001');
      await f.page.locator('#loginBtn').click();
      await f.page.waitForURL('**/staff.html');
      await f.page.waitForFunction(() => !document.querySelector('[data-action="checkIn"]').disabled);
      const actual = f.requests.map(r => r.action).filter(action => action && action !== 'staff_login');
      assert.deepEqual(actual, expected);
      assert.equal(f.requests.find(r => r.action === 'staff_login').ip, '192.0.2.1');
      t.diagnostic(JSON.stringify({ label, ipRequests: actual.length, mockedLoginReadyMs: Math.round(performance.now() - started) }));
    } finally { await f.context.close(); }
  }
});

test('old admin poll cannot report Live after an offline transition', async () => {
  const f = await fixture('admin');
  try {
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
    let release;
    f.control.holdDashboard = new Promise(resolve => { release = resolve; });
    const polling = f.page.waitForRequest(req => req.postDataJSON()?.action === 'get_admin_dashboard_full');
    await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await polling;
    await f.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const oldResponse = f.page.waitForResponse(res => res.request().postDataJSON()?.action === 'get_admin_dashboard_full');
    f.control.holdDashboard = null;
    release();
    await oldResponse;
    assert.match(await f.page.locator('#connectionStatus').textContent(), /Stale/);
    await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
  } finally { await f.context.close(); }
});

test('a successful admin KPI write cannot label a stale dashboard Live', async () => {
  const f = await fixture('admin');
  try {
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
    await f.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    let release;
    f.control.holdDashboard = new Promise(resolve => { release = resolve; });
    await f.page.locator('#kpiStaffId').fill('TEST001');
    await f.page.locator('#kpiMonth').fill('2026-11');
    await f.page.locator('#kpiInputForm button[type="submit"]').click();
    await f.page.waitForFunction(() => document.getElementById('kpiInputState').textContent === 'KPI saved for TEST001.');
    assert.match(await f.page.locator('#connectionStatus').textContent(), /Stale/);
    release();
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
  } finally { await f.context.close(); }
});

const adminStatus = f => f.page.locator('#connectionStatus');
const adminReads = f => f.requests.filter(r => r.action === 'get_admin_dashboard_full').length;
const startAdminRefresh = f => f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const hasAdminStatus = (f, value) => f.page.waitForFunction(text => document.getElementById('connectionStatus').textContent === text, value);

test('admin timeout reconnects once, preserves data and does not overlap refreshes', async () => {
  const f = await fixture('admin');
  let releaseFirst;
  let releaseRetry;
  try {
    await hasAdminStatus(f, 'Live');
    const lastUpdate = await f.page.locator('#lastDashboardUpdate').textContent();
    await f.page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
    await startAdminRefresh(f);
    assert.equal(adminReads(f), 1);
    await f.page.evaluate(() => { delete document.hidden; });
    await f.page.clock.install();
    const first = new Promise(resolve => { releaseFirst = resolve; });
    const second = new Promise(resolve => { releaseRetry = resolve; });
    let attempt = 0;
    f.control.adminRead = async (route, data) => {
      const number = ++attempt;
      await (number === 1 ? first : second);
      if (number === 1) { await route.abort().catch(() => {}); return; }
      await route.fulfill({ json: { ...data, summary: { ...data.summary, total_staff: 2 } } });
    };
    const requested = f.page.waitForRequest(req => req.postDataJSON()?.action === 'get_admin_dashboard_full');
    await startAdminRefresh(f);
    await requested;
    await hasAdminStatus(f, 'Refreshing');
    for (let i = 0; i < 4; i++) await startAdminRefresh(f);
    assert.equal(adminReads(f), 2);
    await f.page.clock.runFor(15001);
    await hasAdminStatus(f, 'Reconnecting');
    releaseFirst();
    await f.page.clock.runFor(701);
    assert.equal(await f.page.locator('#lastDashboardUpdate').textContent(), lastUpdate);
    assert.equal(await f.page.locator('#totalStaff').textContent(), '1');
    assert.equal(await adminStatus(f).textContent(), 'Reconnecting');
    releaseRetry();
    await hasAdminStatus(f, 'Live');
    assert.equal(adminReads(f), 3);
    assert.equal(await f.page.locator('#totalStaff').textContent(), '2');
  } finally { releaseFirst?.(); releaseRetry?.(); await f.context.close(); }
});

test('admin exhausted transient retries keep data stale and throttle automatic reads; manual Retry recovers', async () => {
  const f = await fixture('admin');
  try {
    await hasAdminStatus(f, 'Live');
    const lastUpdate = await f.page.locator('#lastDashboardUpdate').textContent();
    f.control.status = 503;
    f.control.response = { ok: false, message: 'Busy' };
    await startAdminRefresh(f);
    await hasAdminStatus(f, 'Stale data - Retry');
    assert.equal(adminReads(f), 3);
    await startAdminRefresh(f);
    assert.equal(adminReads(f), 3);
    assert.equal(await f.page.locator('#lastDashboardUpdate').textContent(), lastUpdate);
    assert.equal(await f.page.locator('#totalStaff').textContent(), '1');
    f.control.status = 200;
    f.control.response = payload('admin');
    await f.page.locator('#dashboardRetry').click();
    await hasAdminStatus(f, 'Live');
    assert.equal(adminReads(f), 4);
  } finally { await f.context.close(); }
});

test('admin rejects an older response without replacing the displayed data or timestamp', async () => {
  const f = await fixture('admin', { fixedAdminTimestamp: true });
  try {
    await hasAdminStatus(f, 'Live');
    const lastUpdate = await f.page.locator('#lastDashboardUpdate').textContent();
    f.control.response = { ...payload('admin'), generated_at: new Date(Date.now() - 60000).toISOString(),
      summary: { total_staff: 99, summary_details: {} } };
    await startAdminRefresh(f);
    await hasAdminStatus(f, 'Stale data - Retry');
    assert.equal(await f.page.locator('#totalStaff').textContent(), '1');
    assert.equal(await f.page.locator('#lastDashboardUpdate').textContent(), lastUpdate);
    assert.equal(adminReads(f), 2);
  } finally { await f.context.close(); }
});

test('developer credit is centered below the login card or Logout on desktop and mobile', async () => {
  for (const width of [1200, 390, 320]) {
    for (const [role, login] of [['staff', true], ['staff', false], ['admin', false]]) {
      const f = await fixture(role, { login, viewport: { width, height: 844 } });
      try {
        const selector = login ? 'footer.developer-credit' : width > 900 ? '.sidebar .developer-credit' : '.mobile-nav .developer-credit';
        const credit = f.page.locator(selector);
        assert.equal(await credit.isVisible(), true);
        assert.equal(await credit.textContent(), 'Developed by Robi');
        const position = await credit.evaluate(el => ({
          centered: getComputedStyle(el).textAlign === 'center',
          below: el.getBoundingClientRect().top >= el.previousElementSibling.getBoundingClientRect().bottom - 1,
          fits: el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth
        }));
        assert.deepEqual(position, { centered: true, below: true, fits: true }, JSON.stringify({ role, login, width }));
        const documentWidth = await f.page.evaluate(() => document.documentElement.scrollWidth);
        if (documentWidth > width) {
          const baseline = await fixture(role, { login, phaseTwo: true, viewport: { width, height: 844 } });
          try {
            const baselineWidth = await baseline.page.evaluate(() => document.documentElement.scrollWidth);
            assert.ok(documentWidth <= baselineWidth, JSON.stringify({ role, login, width, documentWidth, baselineWidth }));
          } finally { await baseline.context.close(); }
        }
      } finally { await f.context.close(); }
    }
  }
});

test('staff login keeps one IP discovery and no blocking dashboard read against production baseline', async t => {
  for (const phaseTwo of [true, false]) {
    const f = await fixture('staff', { login: true, phaseTwo });
    try {
      await f.page.locator('#identity').fill('TEST001');
      const sent = f.page.waitForResponse(res => res.request().postDataJSON()?.action === 'staff_login').then(() => performance.now());
      await f.page.locator('#loginBtn').click();
      const responseAt = await sent;
      await f.page.waitForURL('**/staff.html');
      await f.page.waitForFunction(() => !document.querySelector('[data-action="checkIn"]').disabled);
      assert.equal(f.requests.filter(row => row.action === 'trace').length, 1);
      assert.equal(f.requests.filter(row => row.action === 'get_staff_dashboard').length, 0);
      t.diagnostic(JSON.stringify({ version: phaseTwo ? 'production-baseline' : 'hotfix',
        fixturePostLoginReadyMs: Math.round(performance.now() - responseAt) }));
    } finally { await f.context.close(); }
  }
});

test('staff login response enables attendance after navigation without a second blocking request', async t => {
  for (const baseline of [true, false]) {
    const f = await fixture('staff', { login: true, baseline });
    try {
      await f.page.locator('#identity').fill('TEST001');
      const submittedAt = performance.now();
      const loginResponse = f.page.waitForResponse(res => res.request().postDataJSON()?.action === 'staff_login').then(() => performance.now());
      await f.page.locator('#loginBtn').click();
      const respondedAt = await loginResponse;
      await f.page.waitForURL('**/staff.html');
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live' &&
        !document.querySelector('[data-action="checkIn"]').disabled);
      const blockingDashboardReads = f.requests.filter(row => row.action === 'get_staff_dashboard').length;
      assert.equal(blockingDashboardReads, baseline ? 1 : 0);
      assert.equal(f.requests.find(row => row.action === 'staff_login').dashboard_mode, baseline ? undefined : 'attendance_first');
      t.diagnostic(JSON.stringify({ version: baseline ? 'baseline' : 'attendance-first', blockingDashboardReads,
        mockedLoginMs: Math.round(respondedAt - submittedAt), mockedPostLoginReadyMs: Math.round(performance.now() - respondedAt) }));
    } finally { await f.context.close(); }
  }
});

for (const reason of ['age', 'future', 'account', 'ip', 'day']) {
  test(`invalid handoff (${reason}) falls back to a dashboard read`, async () => {
    const handoff = payload('staff');
    if (reason === 'age') handoff.generated_at = new Date(Date.now() - 30000).toISOString();
    if (reason === 'future') handoff.generated_at = new Date(Date.now() + 30000).toISOString();
    if (reason === 'account') handoff.staff = { ...staff, login_id: 'OTHER' };
    if (reason === 'ip') handoff.ip.address = '192.0.2.2';
    if (reason === 'day') handoff.today = '2026-01-01';
    const f = await fixture('staff', { handoff });
    try {
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      assert.equal(f.requests.filter(row => row.action === 'get_staff_dashboard').length, 1);
    } finally { await f.context.close(); }
  });
}

test('ambiguous write remains single-shot and controls wait for reconciliation', async () => {
  const f = await fixture('staff');
  try {
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
    let release;
    f.control.holdDashboard = new Promise(resolve => { release = resolve; });
    f.control.dropWrite = true;
    f.control.response.attendance_state.hasCheckIn = true;
    await f.page.locator('[data-action="checkIn"]').click();
    await f.page.locator('.toast.error').waitFor();
    assert.equal(await f.page.locator('[data-action="checkOut"]').isDisabled(), true);
    assert.equal(f.requests.filter(r => r.action === 'attendance_action').length, 1);
    f.control.holdDashboard = null;
    release();
    await f.page.waitForFunction(() => !document.querySelector('[data-action="checkOut"]').disabled);
    assert.equal(await f.page.locator('#attendanceStatus').textContent(), 'Checked in');
  } finally { await f.context.close(); }
});

test('cyan favicon resolves and decodes on all pages under the repository path', async () => {
  for (const [role, login] of [['staff', true], ['staff', false], ['admin', false]]) {
    const f = await fixture(role, { login, repoPath: true, viewport: { width: login ? 1200 : 390, height: 844 } });
    try {
      assert.equal(await f.page.evaluate(async () => {
        const link = document.querySelector('link[rel="icon"]');
        const image = new Image();
        image.src = link.href;
        await image.decode();
        return new URL(image.src).pathname;
      }), '/staff-portal-v2/assets/favicon.svg');
    } finally { await f.context.close(); }
  }
});

test('an older poll cannot overwrite confirmed attendance', async () => {
  const f = await fixture('staff');
  try {
    await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
    await f.page.clock.install();
    let release;
    f.control.holdDashboard = new Promise(resolve => { release = resolve; });
    const poll = f.page.waitForRequest(req => req.postDataJSON()?.action === 'get_staff_dashboard');
    await f.page.clock.runFor(15001);
    await poll;
    await f.page.locator('[data-action="checkIn"]').click();
    await f.page.waitForFunction(() => document.getElementById('attendanceStatus').textContent === 'Checked in');
    f.control.holdDashboard = null;
    const refreshed = f.page.waitForResponse(res => res.request().postDataJSON()?.action === 'get_staff_dashboard' &&
      res.json().then(body => body.attendance_state.hasCheckIn));
    release();
    await refreshed;
    assert.equal(await f.page.locator('#attendanceStatus').textContent(), 'Checked in');
  } finally { await f.context.close(); }
});

test('mock browser measurement: baseline versus operations bootstrap', async t => {
  for (const role of ['staff', 'admin']) {
    for (const baseline of [true, false]) {
      const f = await fixture(role, { baseline });
      try {
        await f.page.waitForFunction(role => role === 'staff'
          ? document.getElementById('staffName').textContent === 'Test Staff'
          : document.getElementById('totalStaff').textContent === '1', role);
        const readyMs = Math.round(performance.now() - f.started);
        t.diagnostic(JSON.stringify({ role, version: baseline ? 'baseline' : 'attendance-first', requests: f.requests.length, mockedReadyMs: readyMs }));
      } finally { await f.context.close(); }
    }
  }
});

test('schedule CSV acknowledgment is mandatory and resets with a new file and submission', async () => {
  const f = await fixture('admin');
  try {
    const file = { name: 'fixture.csv', mimeType: 'text/csv', buffer: Buffer.from(
      'schedule_month,schedule_date,login_id,full_name,team,shift_code,start_time,end_time,status\n' +
      '2026-12,2026-12-03,FIXTURE001,Fixture Staff,CSP,AM,06:30:00,15:30:00,WORKING\n') };
    const ack = f.page.locator('#scheduleLeaveAcknowledged');
    const uploads = () => f.requests.filter(r => r.action === 'upload_schedule_csv');
    await f.page.locator('#scheduleFile').setInputFiles(file);
    await f.page.locator('#scheduleUploadForm button[type=submit]').click();
    assert.equal(uploads().length, 0);
    await ack.check();
    await f.page.locator('#scheduleFile').setInputFiles({ ...file, name: 'fixture-2.csv' });
    assert.equal(await ack.isChecked(), false);
    await ack.check();
    await f.page.locator('#scheduleUploadForm button[type=submit]').click();
    await f.page.getByText(/Schedule uploaded[.]/).waitFor();
    assert.equal(uploads().length, 1);
    assert.equal(uploads()[0].rows[0].login_id, 'FIXTURE001');
    assert.equal(await ack.isChecked(), false);
  } finally { await f.context.close(); }
});
