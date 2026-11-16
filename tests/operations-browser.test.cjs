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
function payload(role, code = 'AM') {
  const schedule = { ...shift, shift_code: code, status: code === 'AM' ? 'WORKING' : code };
  return role === 'staff' ? { ok: true, staff, selected_month: day.slice(0, 7), today_schedule: schedule,
    attendance_state: { hasCheckIn: false, hasCheckOut: false, counts: {} }, monthly_schedule: [schedule], upcoming_schedule: [schedule] }
    : { ok: true, summary: { total_staff: 1, summary_details: { total_staff: [staff] } }, staff_count: 1,
      staff_list: [staff], schedule_list: [schedule], attendance_events: [], breakBoard: [], audit_logs: [], telegram_logs: [], ip_allowlist: [] };
}
async function fixture(role, options = {}) {
  const context = await browser.newContext(options.viewport ? { viewport: options.viewport } : {});
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  const control = { response: payload(role), status: 200, fail: false, hold: null, ...options };
  await context.addInitScript(({ role }) => {
    if (location.pathname.endsWith('/index.html')) return;
    localStorage.setItem('staffPortalV2.session', JSON.stringify({ role, loginId: 'TEST001', staffId: 'TEST-ID', name: 'Test Staff', createdAt: Date.now() }));
    localStorage.setItem('staffPortalV2.clientIp', '192.0.2.1');
  }, { role });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'staff-portal-api-v2.mdrobiulislam.workers.dev') {
      const body = route.request().postDataJSON() || {};
      requests.push(body);
      if (control.hold) await control.hold;
      if (control.fail) return route.abort('failed');
      if (body.action === 'attendance_action') {
        if (control.actionResult) return route.fulfill({ json: control.actionResult });
        const state = control.response.attendance_state;
        if (body.event_type === 'CHECK_IN') state.hasCheckIn = true;
        if (body.event_type === 'CHECK_OUT') state.hasCheckOut = true;
        if (body.event_type === 'BREAK_START') { state.activeBreak = body.break_type; state.breakStartedAt = new Date(Date.now() - 60000).toISOString(); }
        if (body.event_type === 'BREAK_END') { state.activeBreak = ''; state.breakStartedAt = null; }
        return route.fulfill({ json: { ok: true, state } });
      }
      return route.fulfill({ status: control.status, json: control.response });
    }
    if (url.hostname !== 'portal.test') throw Error('Unexpected external request: ' + url.hostname);
    const file = url.pathname.slice(1) || 'index.html';
    let body = options.baseline ? cp.execFileSync('git', ['show', `a57ce4cc3ba4264f9a2260b4c8546293daa10afa:${file}`]) : fs.readFileSync(file);
    const ext = path.extname(file);
    return route.fulfill({ body, contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/html' });
  });
  const started = performance.now();
  await page.goto(`https://portal.test/${role}.html`);
  return { context, page, control, requests, errors, started };
}
for (const role of ['staff', 'admin']) {
  test(`${role}: successful operational rendering, safe link, empty data and recovery`, async () => {
    const f = await fixture(role);
    try {
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].dashboard_mode, 'operations');
      const link = f.page.locator('a[href="https://staff-performance-score.pages.dev/"]');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await f.page.locator('#leaderboardPreview, #topPerformers, #kpiChart, #attendanceHistory').count(), 0);
      if (role === 'admin') {
        await f.page.locator('#totalStaff').click();
        assert.match(await f.page.locator('#dataModalBody').textContent(), /Test Staff/);
        await f.page.locator('#dataModal [data-modal-close]').click();
        for (const id of ['scheduleUploadForm', 'singleScheduleForm', 'kpiInputForm', 'saveIpBtn']) assert.equal(await f.page.locator('#' + id).count(), 1);
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

test('valid empty admin data and null staff schedule are not malformed', async () => {
  for (const role of ['admin', 'staff']) {
    const response = role === 'admin'
      ? { ok: true, summary: { total_staff: 0, summary_details: {} }, staff_count: 0, staff_list: [], schedule_list: [], attendance_events: [] }
      : { ok: true, staff, attendance_state: {}, today_schedule: null, monthly_schedule: [] };
    const f = await fixture(role, { response });
    try {
      await f.page.waitForFunction(() => document.getElementById('connectionStatus').textContent === 'Live');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  }
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
        t.diagnostic(JSON.stringify({ role, version: baseline ? 'baseline' : 'operations', requests: f.requests.length, mockedReadyMs: readyMs }));
      } finally { await f.context.close(); }
    }
  }
});
