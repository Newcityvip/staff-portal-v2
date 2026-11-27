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

async function fixture({ publishing = false, fault = false } = {}) {
  const { createPortalWorker, rosterSignature } = await workerModule;
  const baseClock = Date.UTC(2027, 0, 1, 0, 0, 20);
  let clock = baseClock, lock = true;
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
  const events = [], reads = [], writes = [];
  let lockHeld = false, verifiedWindow = false;
  if (publishing) {
    const { fixtureRows } = require('../scripts/roster-fixture.cjs');
    const teams = ['Affiliate', 'CSP'].map(team => fixtureRows(team, '2026-12'));
    const teamShifts = Object.fromEntries(teams.map(data => [data.staff[0].team, data.shifts.map(s => s.shift_code)]));
    props.set('ROSTER_TEAM_SHIFT_CODES', JSON.stringify(teamShifts));
    props.set('ROSTER_EXCLUDED_STAFF_IDS', JSON.stringify(teams.flatMap(data => data.excludedStaffIds)));
    rows['02_Staff_Master'].splice(1, Infinity, ...teams.flatMap(data => data.staff.map(p =>
      [p.staff_id, p.full_name, p.staff_id, p.team, p.status, p.joining_date, 'Agent', ''])));
    const shifts = new Map(teams.flatMap(data => data.shifts.map(s => [s.shift_code, s])));
    rows['03_Shift_Rules'].splice(1, Infinity, ...[...shifts.values()].map(s =>
      [s.shift_code, s.start_time, s.end_time, ...Array(8).fill(''), 'YES']));
    rows['04_Schedule_Master'] = [['schedule_id','schedule_month','schedule_date','staff_id','login_id','full_name','team',
      'shift_code','start_time','end_time','status','uploaded_by','uploaded_at','notes'],
      ...teams.flatMap(data => data.schedule.map((s, i) => ['SCH-' + s.team + i, s.schedule_month, s.schedule_date,
        s.staff_id, s.staff_id, data.staff.find(p => p.staff_id === s.staff_id).full_name, s.team,
        s.shift_code,s.start_time,s.end_time,s.status,'Original','2026-11-01','Keep']))];
  }
  const table = () => rows['04_Schedule_Master'];
  const sheet = {
    getDataRange: () => ({ getValues: () => structuredClone(table()), getFormulas: () => table().map(row => row.map(() => '')) }),
    getMaxRows: () => 2000, getLastRow: () => table().length,
    getRange: (r, c) => ({ setValues(values) {
      assert.equal(lockHeld, false, 'must not hold the attendance lock during mutation');
      writes.push({ r, c, count: values.length });
      for (const [i, cells] of values.entries()) {
        const row = table()[r - 1 + i] ||= [];
        for (const [j, v] of cells.entries()) row[c - 1 + j] = v;
      }
    } })
  };
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k), setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => {
      if (!lock || lockHeld) return false;
      return lockHeld = true;
    }, releaseLock() { lockHeld = false; } }) },
    SpreadsheetApp: { flush: () => { if (fault) throw Error('Mock response lost after write'); } },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeHmacSha256Signature: (input, key) => [...crypto.createHmac('sha256', key).update(input).digest()],
      computeDigest: (algorithm, input) => [...crypto.createHash(algorithm).update(input).digest()],
      base64EncodeWebSafe: input => Buffer.from(input).toString('base64url'),
      base64DecodeWebSafe: input => [...Buffer.from(input, 'base64url')],
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      getUuid: () => crypto.randomUUID()
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => value }) },
    fixtureRead: name => { reads.push(name); assert.ok(rows[name], 'Only roster source sheets may be read'); return rows[name]; }
  });
  vm.runInContext(source + '\nrosterSheetValues = fixtureRead;', context);
  if (publishing) {
    for (const file of ['RosterPublishValidator.gs', 'RosterPublish.gs']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../backend', file), 'utf8'), context);
    }
    Object.assign(context, { sh: () => sheet, nowDateTime: () => '2026-11-27 12:00:00', clearSheetCache() {},
      todayDateForTimezone: () => new Date(Date.UTC(2026, 10, 27) + clock - baseClock).toISOString().slice(0, 10),
      makeId: () => 'SCH-' + crypto.randomUUID() });
  }
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
  return { events, reads, rows, props, env, send, auth, snapshot, direct, signed, writes,
    openWindow: () => { verifiedWindow = true; context.rosterVerifiedPublishingWindow = () => verifiedWindow; },
    closeWindow: () => { verifiedWindow = false; },
    advance: ms => { clock += ms; }, busy: () => { lock = false; } };
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
  assert.equal((await f.send('/roster/v1/publish', {})).status, 503);
  assert.equal((await f.send(path + '?role=SUPER_ADMIN', body)).status, 404);
  const cors = await f.send(path, undefined, { method: 'OPTIONS' });
  assert.equal(cors.status, 204); assert.equal(cors.headers.get('Access-Control-Allow-Origin'), origin);
  f.env.ROSTER_ENABLED = '0';
  assert.equal((await f.send(path, body)).status, 503);
  assert.equal(f.events.length, 0);
});

async function publishDraft(f, token) {
  const team = 'Affiliate', month = '2026-12';
  const sourceResponse = await f.snapshot(token, team, {}, month);
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json();
  const { prepareRosterSource, sourceDraft, publicationConfiguration } = await import('../js/roster-source.js');
  const { contextFor } = await import('../js/roster-model.js');
  const { generateCandidates } = await import('../js/roster-generator.js');
  const prepared = prepareRosterSource(source, team, month);
  const ctx = contextFor(sourceDraft(prepared, prepared.staff.filter(p => !p.exclusion).map(p => p.id)), team, month);
  const candidate = generateCandidates(ctx, { strategy: 'balanced' }).candidates[0];
  const configuration = publicationConfiguration(ctx);
  f.props.set('ROSTER_PUBLISH_RULES_AFFILIATE_2026-12', JSON.stringify(configuration));
  return { team, month, configuration, sourceRevision: source.revision, records: ctx.people.flatMap(person => ctx.dates.map(date => ({
    staffId: person.id, date, shift: candidate.cells[person.id + '|' + date]
  }))) };
}

test('signed Apps Script publish denies unverified windows and cross-team or unauthenticated requests', async () => {
  const f = await fixture({ publishing: true });
  f.props.set('ROSTER_PUBLISH_ENABLED', '1'); f.env.ROSTER_PUBLISH_ENABLED = '1';
  const root = await f.auth('root-admin'), csp = await f.auth();
  const draft = await publishDraft(f, root), body = { ...draft, action: 'preview' };
  const send = auth => f.send('/roster/v1/publish', body, { auth });
  assert.equal((await send()).status, 401);
  assert.equal((await send(csp)).status, 403);
  const denied = await send(root);
  assert.equal(denied.status, 409);
  assert.match((await denied.json()).message, /No verified exclusive/);
  assert.deepEqual(f.writes, []);
});

test('Apps Script rejects stale previews, duplicate assignments, leave changes and unapproved configuration', async () => {
  const f = await fixture({ publishing: true });
  f.props.set('ROSTER_PUBLISH_ENABLED', '1'); f.env.ROSTER_PUBLISH_ENABLED = '1';
  f.openWindow();
  const token = await f.auth('root-admin'), draft = await publishDraft(f, token);
  const send = body => f.send('/roster/v1/publish', body, { auth: token });
  const preview = { ...draft, action: 'preview' };
  const duplicate = { ...preview, records: [...draft.records, draft.records[0]] };
  assert.match((await (await send(duplicate)).json()).message, /Duplicate/);
  const config = structuredClone(preview);
  config.configuration.rules.maxRun += 1;
  assert.match((await (await send(config)).json()).message, /approved roster configuration/);
  const leave = structuredClone(preview);
  leave.records.find(row => row.staffId === 'TEST-A-2' && row.date === '2026-12-06').shift = 'PM';
  assert.match((await (await send(leave)).json()).message, /Published leave/);

  const review = await (await send(preview)).json();
  const row = f.rows['04_Schedule_Master'].find(r => r[3] === 'TEST-A-1' && r[2] === '2026-12-01');
  row.splice(7, 4, 'PM', '14:30:00', '23:30:00', 'WORKING');
  const stale = await send({ ...draft, id: review.id, ticket: review.ticket, acknowledged: true, action: 'commit' });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).message, /Schedule changed/);
  f.advance(10 * 86400000);
  const lateToken = await f.auth('root-admin'), lateDraft = await publishDraft(f, lateToken);
  const past = await f.send('/roster/v1/publish', { ...lateDraft, action: 'preview' }, { auth: lateToken });
  assert.match((await past.json()).message, /Historical schedules/);
  assert.deepEqual(f.writes, []);
});

for (const fault of [false, true]) {
  test('signed Apps Script publishes only reviewed rows' + (fault ? ' and reconciles an uncertain write without repeating it' : ''), async () => {
    const f = await fixture({ publishing: true, fault });
    f.props.set('ROSTER_PUBLISH_ENABLED', '1'); f.env.ROSTER_PUBLISH_ENABLED = '1';
    f.openWindow();
    const token = await f.auth('root-admin'), draft = await publishDraft(f, token);
    const send = body => f.send('/roster/v1/publish', body, { auth: token });
    const preview = { ...draft, action: 'preview' };
    const ask = await send(preview);
    assert.equal(ask.status, 200, await ask.clone().text());
    const { id, ticket, counts } = await ask.json();
    assert.ok(counts.new > 0 && counts.updated > 0);
    const commit = { ...draft, action: 'commit', id, ticket, acknowledged: true };
    assert.equal((await send({ ...commit, acknowledged: false })).status, 400);
    const protectedRows = f.rows['04_Schedule_Master'].slice(1).filter(r =>
      r[6] !== 'Affiliate' || r[1] !== draft.month || ['AL','SL','UL'].includes(r[7]) || r[3] === 'TEST-A-7').map(r => [...r]);
    const response = await send(commit);
    assert.equal(response.status, fault ? 503 : 200, await response.clone().text());
    assert.equal((await response.json()).state, fault ? 'uncertain' : 'verified');
    const writes = f.writes.length;
    assert.ok(writes > 0);
    assert.equal((await (await send(commit)).json()).state, fault ? 'uncertain' : 'verified');
    const scope = { team: draft.team, month: draft.month, id };
    if (fault) assert.equal((await (await send({ ...scope, action: 'recover' })).json()).state, 'verified');
    assert.equal((await (await send({ ...scope, action: 'status' })).json()).canRecover, false);
    assert.equal(f.writes.length, writes);
    for (const row of protectedRows) assert.ok(f.rows['04_Schedule_Master'].some(r => JSON.stringify(r) === JSON.stringify(row)));
    const key = row => row[3] + '|' + row[2];
    const keys = f.rows['04_Schedule_Master'].slice(1).map(key);
    assert.equal(new Set(keys).size, keys.length);
  });
}

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

test('HTTPS-shaped roster editor publishes once through the parent session to the mocked Worker and Apps Script', async () => {
  const { chromium } = require('playwright');
  const { startPreview } = require('../scripts/roster-preview.cjs');
  const server = await startPreview(0, '127.0.0.1', { fixture: true });
  const local = 'http://127.0.0.1:' + server.address().port;
  const worker = 'https://staff-portal-api-v2.mdrobiulislam.workers.dev';
  let browser;
  try {
    const f = await fixture({ publishing: true });
    f.props.set('ROSTER_PUBLISH_ENABLED', '1'); f.env.ROSTER_PUBLISH_ENABLED = '1';
    f.openWindow();
    await publishDraft(f, await f.auth('root-admin'));
    browser = await chromium.launch({ headless: true, channel: process.env.PORTAL_TEST_BROWSER || 'chrome' });
    const page = await browser.newPage(), actions = [];
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === origin) {
        if (url.pathname.endsWith('/roster-live-config.js')) return route.fulfill({ contentType: 'text/javascript',
          body: 'export const rosterLiveEnabled=true,rosterPublishEnabled=true,rosterWorker=' + JSON.stringify(worker) + ';' });
        const response = await fetch(local + url.pathname + url.search);
        return route.fulfill({ status: response.status, contentType: response.headers.get('Content-Type'), body: Buffer.from(await response.arrayBuffer()) });
      }
      if (url.origin !== worker) return route.abort();
      const options = { method: req.method(), auth: req.headers().authorization?.slice(7) };
      const payload = req.method() === 'POST' ? req.postDataJSON() : undefined;
      if (url.pathname.endsWith('/publish') && payload) actions.push(payload.action);
      const response = await f.send(url.pathname, payload, options);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto(origin + '/admin-roster-source.html?source=live');
    await page.locator('#source-month').evaluate(input => { input.value = '2026-12'; });
    await page.getByLabel('Admin Login ID').fill('root-admin');
    await page.getByLabel('Password').fill('fixture-pw');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.getByRole('button', { name: 'Open Published Copy' }).click();
    const frame = page.frameLocator('#source-editor iframe');
    await frame.getByText(/Live source \/ Reviewed publishing/).waitFor();
    await frame.locator('#generation').selectOption('balanced');
    await frame.locator('#generate').click();
    await frame.getByRole('button', { name: 'Apply candidate', exact: true }).click();
    await frame.locator('#preview').click();
    await frame.locator('#confirm').click();
    await frame.getByRole('button', { name: 'Review schedule changes' }).click();
    await frame.getByLabel('I verified the leave requests').check();
    await frame.getByRole('button', { name: 'Publish Final Schedule' }).click();
    await frame.getByText('Schedule write verified.', { exact: true }).waitFor();
    assert.deepEqual(actions, ['preview', 'commit']);
    assert.ok(f.writes.length > 0);
  } finally {
    await browser?.close();
    server.close();
  }
});
