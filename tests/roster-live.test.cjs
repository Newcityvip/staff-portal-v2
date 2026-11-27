const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const workerModule = import('../worker/staff-portal-api-v2.mjs');
const source = fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8');
const ip = '192.0.2.12', otherIp = '192.0.2.13', origin = 'https://roster.example.test';
const gas = 'https://script.google.com/macros/s/sanitized-fixture/exec';
const bridge = 'a'.repeat(64), sessionKey = 'b'.repeat(64);

async function fixture() {
  const { createPortalWorker, rosterSignature } = await workerModule;
  let clock = Date.UTC(2027, 0, 1, 0, 0, 20), lock = true;
  const props = new Map(Object.entries({
    ROSTER_ENABLED: '1', ROSTER_BRIDGE_KEY: bridge, ROSTER_SESSION_KEY: sessionKey,
    ROSTER_TEAM_SHIFT_CODES: '{"Affiliate":["AM","OFF","AL"],"CSP":["GY","OFF","UL"]}'
  }));
  const rows = {
    '10_IP_Allowlist': [[], ['', ip, '', 'ACTIVE'], ['', otherIp, '', 'ACTIVE']],
    '09_Admin_Users': [[], ['root', '', 'root-admin', 'fixture-pw', 'ACTIVE', 'SUPER_ADMIN'],
      ['csp', '', 'csp-admin', 'fixture-pw', 'ACTIVE', 'CSP_ADMIN'], ['staff', '', 'staff-account', 'fixture-pw', 'ACTIVE', 'STAFF']],
    '02_Staff_Master': [['staff_id','full_name','login_id','team','status','joining_date','role','email'],
      ['A1','Fixture Affiliate','a1','Affiliate','ACTIVE','2026-11-01','Agent','private@example.test'],
      ['C1','Fixture CSP','c1','CSP','ACTIVE','2026-11-01','Agent','private@example.test']],
    '03_Shift_Rules': [[], ...[['AM','09:00','18:00'],['GY','21:00','06:00'],['OFF','',''],['AL','',''],['UL','','']]
      .map(row => [...row, ...Array(8).fill(''), 'YES'])],
    '04_Schedule_Master': [['staff_id','team','schedule_date','schedule_month','shift_code','start_time','end_time','status'],
      ['C1','CSP','2026-12-31','2026-12','GY','21:00','06:00','WORKING'],
      ['C1','CSP','2027-01-01','2027-01','UL','','','OFF'],
      ['C1','CSP','2027-02-01','2027-02','OFF','','','OFF'],
      ['C1','CSP','2027-03-01','2027-03','OFF','','','OFF'],
      ['A1','Affiliate','2027-01-01','2027-01','AM','09:00','18:00','WORKING']]
  };
  const events = [], reads = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k), setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => lock, releaseLock() {} }) },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeHmacSha256Signature: (input, key) => [...crypto.createHmac('sha256', key).update(input).digest()],
      computeDigest: (algorithm, input) => [...crypto.createHash(algorithm).update(input).digest()],
      base64EncodeWebSafe: input => Buffer.from(input).toString('base64url'),
      base64DecodeWebSafe: input => [...Buffer.from(input, 'base64url')],
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') })
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    fixtureRead: name => { reads.push(name); assert.ok(rows[name], 'Only roster source sheets may be read'); return rows[name]; }
  });
  vm.runInContext(source + '\nrosterSheetValues = fixtureRead;', context);
  const direct = body => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }));
  const env = { GAS_URL: gas, ROSTER_ENABLED: '1', ROSTER_ORIGIN: origin, ROSTER_BRIDGE_KEY: bridge };
  const worker = createPortalWorker({ now: () => clock, fetch: async (url, init) => {
    events.push({ url, init });
    if (init.method === 'GET' || !init.body.includes('"action":"roster_v1"')) return new Response('legacy', { status: 202 });
    return Response.json(direct(JSON.parse(init.body)));
  } });
  async function send(path, body, { auth, edge = true, headers = {}, method = 'POST' } = {}) {
    const req = new Request('https://worker.example.test' + path, { method, headers: {
      Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json',
      ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...headers
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (edge) Object.defineProperty(req, 'cf', { value: { colo: 'TST' } });
    return worker.fetch(req, env);
  }
  const auth = async (id = 'csp-admin') => (await (await send('/roster/v1/login', { login_id: id, password: 'fixture-pw' })).json()).token;
  const snapshot = (token, team = 'CSP', headers, month = '2027-01') =>
    send('/roster/v1/snapshot', { team, month }, { auth: token, headers });
  async function signed(data, delta = 0) {
    const time = clock + delta, nonce = crypto.randomUUID(), payload = JSON.stringify(data);
    return { action: 'roster_v1', time, nonce, ip, payload, signature: await rosterSignature(bridge, time, nonce, ip, payload) };
  }
  return { events, reads, rows, props, env, send, auth, snapshot, direct, signed, advance: ms => { clock += ms; }, busy: () => { lock = false; } };
}

test('legacy GET, POST and OPTIONS preserve forwarding, status, body and wildcard CORS', async () => {
  const f = await fixture();
  const post = await f.send('/', { action: 'existing', ip: 'browser-value' });
  assert.equal(post.status, 202);
  assert.equal(await post.text(), 'legacy');
  assert.equal(post.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(f.events[0], { url: gas, init: { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"action":"existing","ip":"browser-value"}' } });
  assert.equal((await f.send('/?health=1', undefined, { method: 'GET' })).status, 202);
  assert.equal(f.events[1].url, gas + '?health=1');
  assert.equal(await (await f.send('/', undefined, { method: 'OPTIONS' })).text(), 'ok');
  assert.equal(f.events.length, 2);
});

test('roster Worker fails closed for wrong origin, disabled rollout, untrusted IP, overrides, and write routes', async () => {
  const f = await fixture(), path = '/roster/v1/login', body = { login_id: 'csp-admin', password: 'fixture-pw' };
  assert.equal((await f.send(path, body, { headers: { Origin: 'https://wrong.example' } })).status, 403);
  assert.equal((await f.send(path, body, { edge: false })).status, 403);
  assert.equal((await f.send(path, body, { headers: { 'CF-Worker': 'worker.example' } })).status, 403);
  assert.equal((await f.send(path, body, { headers: { 'CF-Connecting-IP': '', 'X-Forwarded-For': ip } })).status, 403);
  assert.equal((await f.send(path, { ...body, role: 'SUPER_ADMIN', ip })).status, 400);
  assert.equal((await f.send(path, { ...body, password: 'x'.repeat(3000) })).status, 400);
  assert.equal((await f.send('/roster/v1/publish', {})).status, 404);
  assert.equal((await f.send(path + '?role=SUPER_ADMIN', body)).status, 404);
  const cors = await f.send(path, undefined, { method: 'OPTIONS' });
  assert.equal(cors.status, 204); assert.equal(cors.headers.get('Access-Control-Allow-Origin'), origin);
  f.env.ROSTER_ENABLED = '0';
  assert.equal((await f.send(path, body)).status, 503);
  assert.equal(f.events.length, 0);
});

test('origin rejects direct, tampered, expired and replayed envelopes and does not dispatch writes', async () => {
  const f = await fixture(), login = { operation: 'login', login_id: 'csp-admin', password: 'fixture-pw' };
  const valid = await f.signed(login);
  assert.equal(f.direct({ action: 'roster_v1' }).status, 403);
  assert.equal(f.direct({ ...valid, ip: otherIp }).status, 403);
  assert.equal(f.direct(await f.signed(login, -30001)).status, 403);
  assert.equal(f.direct(await f.signed({ operation: 'publish' })).status, 403);
  assert.deepEqual(f.reads, []);
  assert.equal(f.direct(valid).status, 200);
  const reads = f.reads.length;
  assert.equal(f.direct(valid).status, 403);
  assert.deepEqual(f.reads.slice(reads), ['10_IP_Allowlist']);
});

test('CSP scope, IP binding, token integrity, revocation and expiry deny reads', async () => {
  const f = await fixture(), token = await f.auth();
  assert.equal(typeof token, 'string');
  f.reads.length = 0;
  assert.equal((await f.snapshot(token, 'Affiliate')).status, 403);
  assert.equal((await f.snapshot(token, 'CSP', { 'CF-Connecting-IP': otherIp })).status, 401);
  assert.equal((await f.snapshot(token.replace(/.$/, c => c === '0' ? '1' : '0'))).status, 401);
  assert.equal((await f.snapshot(token, 'CSP', {}, '2027-13')).status, 400);
  f.rows['09_Admin_Users'][2][5] = 'SUPER_ADMIN';
  assert.equal((await f.snapshot(token)).status, 401);
  f.rows['09_Admin_Users'][2][5] = 'CSP_ADMIN';
  f.rows['09_Admin_Users'][2][3] = 'changed-fixture-password';
  assert.equal((await f.snapshot(token)).status, 401);
  f.rows['09_Admin_Users'][2][3] = 'fixture-pw';
  f.rows['10_IP_Allowlist'][1][3] = 'INACTIVE';
  assert.equal((await f.snapshot(token)).status, 403);
  f.rows['10_IP_Allowlist'][1][3] = 'ACTIVE';
  f.advance(600000);
  assert.equal((await f.snapshot(token)).status, 401);
  assert.ok(f.reads.every(sheet => ['10_IP_Allowlist', '09_Admin_Users'].includes(sheet)));
});

test('independent auth rejects staff and duplicate admins, rate limits bad credentials and fails closed on lock contention', async () => {
  const f = await fixture(), path = '/roster/v1/login';
  assert.equal(await f.auth('staff-account'), undefined);
  f.rows['09_Admin_Users'].push(['duplicate', '', 'CSP-ADMIN', 'fixture-pw', 'ACTIVE', 'SUPER_ADMIN']);
  assert.equal(await f.auth(), undefined);
  const data = { login_id: 'root-admin', password: 'invalid' };
  for (let i = 0; i < 6; i++) assert.equal((await f.send(path, data)).status, 401);
  assert.equal((await f.send(path, data)).status, 429);
  f.advance(300000);
  f.busy();
  assert.equal((await f.send(path, data)).status, 503);
});

test('live-shaped read projects authorized team, January window and overnight/leave; conflicts block import', async () => {
  const f = await fixture(), token = await f.auth('root-admin');
  const response = await f.snapshot(token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(data.teams, ['Affiliate', 'CSP']);
  assert.equal(data.timeZone, 'Asia/Manila');
  assert.deepEqual(data.staff.map(row => row.staff_id), ['C1']);
  assert.equal('email' in data.staff[0], false);
  assert.deepEqual(data.schedule.map(row => row.schedule_date), ['2026-12-31', '2027-01-01', '2027-02-01']);
  assert.equal(data.schedule[0].end_time, '06:00:00');
  const { prepareRosterSource, sourceDraft } = await import('../js/roster-source.js');
  const normalized = prepareRosterSource(data, 'CSP', '2027-01');
  assert.equal(normalized.usable, true);
  assert.equal(sourceDraft(normalized, ['C1'], false).leave['C1|2027-01-01'], 'UL');
  assert.equal((await (await f.snapshot(token)).json()).revision, data.revision);
  f.rows['04_Schedule_Master'].push(['A1','CSP','2027-01-04','2027-01','OFF','','','OFF']);
  const conflict = await (await f.snapshot(token)).json();
  assert.equal(conflict.suppressedTeamConflicts, 1);
  assert.ok(conflict.schedule.every(row => row.staff_id === 'C1'));
  assert.notEqual(conflict.revision, data.revision);
  assert.equal(prepareRosterSource(conflict, 'CSP', '2027-01').usable, false);
});

test('live browser remains disabled by default and opens a read-only scoped editor with mocked sign-in', async () => {
  const { chromium } = require('playwright');
  const { startPreview } = require('../scripts/roster-preview.cjs');
  const { fixtureRows } = require('../scripts/roster-fixture.cjs');
  const server = await startPreview(0, '127.0.0.1', { fixture: true });
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PORTAL_TEST_BROWSER || 'chrome' });
    const page = await browser.newPage({ viewport: { width: 435, height: 900 } });
    const worker = 'https://staff-portal-api-v2.mdrobiulislam.workers.dev', operations = [];
    const mockToken = 'fixture.' + 'c'.repeat(64);
    let responseStatus = 200;
    await page.route('**/*', async route => {
      const req = route.request(), url = req.url();
      if (url.startsWith(base)) return route.continue();
      if (!url.startsWith(worker + '/roster/v1/')) return route.abort();
      const action = url.split('/').pop();
      const headers = { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      operations.push(action);
      if (action === 'login') return route.fulfill({ headers,
        json: { ok: true, token: mockToken, expiresAt: Date.now() + 600000, teams: ['CSP'] } });
      const { team, month } = req.postDataJSON();
      assert.equal(req.headers().authorization, 'Bearer ' + mockToken);
      assert.equal(team, 'CSP');
      return route.fulfill({ headers, status: responseStatus, json: responseStatus === 200 ?
        { ...fixtureRows(team, month), ok: true, team, month, teams: ['CSP'], principal: 'mock-live' } : { ok: false } });
    });
    await page.goto(base + '/admin-roster-source.html?source=live');
    await page.getByText('Live roster access is disabled.').waitFor();
    assert.deepEqual(operations, []);
    await page.route('**/js/roster-live-config.js', route => route.fulfill({
      contentType: 'text/javascript', body: 'export const rosterLiveEnabled=true, rosterWorker=' + JSON.stringify(worker) + ';'
    }));
    await page.goto(base + '/admin-roster-source.html?source=live');
    await page.locator('#source-month').evaluate(input => { input.value = '2026-12'; });
    await page.getByLabel('Admin Login ID').fill('mock-admin');
    await page.getByLabel('Password').fill('mock-password');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.getByText('Staff Directory', { exact: true }).waitFor();
    assert.equal(await page.locator('#source-team').inputValue(), 'CSP');
    assert.equal(await page.locator('#source-team option[value="Affiliate"]').evaluate(option => option.disabled), true);
    await page.getByRole('button', { name: 'Open Published Copy' }).click();
    const editor = page.frameLocator('#source-editor iframe');
    await editor.getByText(/Live read-only \/ Publishing disabled/).waitFor();
    await editor.locator('#save').click();
    await editor.getByText('Draft saved in this browser.').waitFor();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.match(storage, /spv2\.roster\.live-draft\.v1\.mock-live\.CSP\.2026-12/);
    assert.ok(!storage.includes(mockToken) && !storage.includes('mock-password') && !storage.includes('fixture-handoff'));
    await editor.getByText('Review source', { exact: true }).click();
    responseStatus = 403;
    await page.getByRole('button', { name: 'Refresh Data' }).click();
    await page.getByText(/Access denied or session expired/).waitFor();
    assert.equal(await page.locator('#source-editor iframe').count(), 0);
    assert.equal(await page.locator('#source-staff tr').count(), 0);
    assert.deepEqual(operations, ['login', 'snapshot', 'snapshot']);
  } finally {
    await browser?.close();
    server.close();
  }
});
