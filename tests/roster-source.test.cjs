const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureRows } = require('../scripts/roster-fixture.cjs');
const { startPreview } = require('../scripts/roster-preview.cjs');
const contract = import('../backend/roster-read-contract.mjs');
const adapter = import('../js/roster-source.js');
const model = import('../js/roster-model.js');
const generator = import('../js/roster-generator.js');
const month = '2026-12', ip = '192.0.2.12';
const payload = (team = 'Affiliate') => ({ ...fixtureRows(team, month), ok: true, team, month,
  teams: ['Affiliate', 'CSP'], principal: 'fixture-admin' });

test('roster contract requires verified server identity, gateway, expiry and IP before any source read', async () => {
  const { rosterReadContract, rosterSessionMaxAge } = await contract;
  const now = 1000000, goodSession = { subject: 'admin', ip, audience: 'roster-read', issuedAt: now - 1, expiresAt: now + 1000 };
  const base = { operation: 'roster_snapshot', method: 'GET', team: 'Affiliate', month, gatewayIp: ip,
    sessionId: 'fixture-placeholder', clientRole: 'SUPER_ADMIN' };
  let calls = 0, account = { active: true, role: 'SUPER_ADMIN', draftNamespace: 'opaque-fixture' }, session = goodSession, gateway = true;
  const read = rosterReadContract({ verifyGateway: () => gateway, resolveSession: () => session, resolveAdmin: () => account,
    allowedIp: addr => addr === ip, readSource: (team, month) => { calls++; return fixtureRows(team, month); }, now: () => now });
  assert.equal((await read({ ...base, method: 'POST' })).status, 405);
  gateway = false; assert.equal((await read(base)).status, 403);
  gateway = true;
  session = null; assert.equal((await read(base)).status, 401);
  session = { ...goodSession, expiresAt: now }; assert.equal((await read(base)).status, 401);
  session = { ...goodSession, expiresAt: now + rosterSessionMaxAge + 100 }; assert.equal((await read(base)).status, 401);
  session = { ...goodSession, ip: '192.0.2.99' }; assert.equal((await read(base)).status, 401);
  session = goodSession;
  account = { ...account, role: 'STAFF' }; assert.equal((await read(base)).status, 403);
  account = { ...account, role: 'CSP_ADMIN' }; assert.equal((await read(base)).status, 403);
  assert.equal(calls, 0);
  const csp = await read({ ...base, team: 'CSP' });
  assert.equal(csp.status, 200); assert.deepEqual(csp.body.teams, ['CSP']);
  assert.ok(csp.body.staff.every(r => r.team === 'CSP'));
  account = { ...account, role: 'SUPER_ADMIN' };
  assert.equal((await read(base)).status, 200);
  assert.equal(calls, 2);
});

test('server rejects a mixed team snapshot and filters non-roster fields', async () => {
  const { rosterReadContract } = await contract;
  let mixed = true;
  const read = rosterReadContract({ verifyGateway: () => true,
    resolveSession: () => ({ audience: 'roster-read', expiresAt: 10000, issuedAt: 10, subject: 'admin', ip }),
    resolveAdmin: () => ({ role: 'SUPER_ADMIN', active: true, draftNamespace: 'fixture' }),
    allowedIp: () => true, now: () => 100,
    readSource: () => {
      const result = fixtureRows('Affiliate', month);
      result.staff[0].notes = 'not for this response';
      if (mixed) result.staff[0].team = 'CSP';
      return result;
    } });
  const request = { method: 'GET', month, team: 'Affiliate', operation: 'roster_snapshot', gatewayIp: ip };
  assert.equal((await read(request)).status, 502);
  mixed = false;
  assert.equal(Object.hasOwn((await read(request)).body.staff[0], 'notes'), false);
});

test('real-schema fixture maps canonical identity, active staff, overnight times, leave and adjacent windows', async () => {
  const { prepareRosterSource, sourceDraft } = await adapter;
  const { contextFor } = await model;
  const { generateCandidates } = await generator;
  const data = payload();
  delete data.schedule[2].login_id;
  const snapshot = prepareRosterSource(data, 'Affiliate', month);
  assert.equal(snapshot.usable, true);
  assert.equal(snapshot.staff.filter(p => !p.exclusion).length, 5);
  assert.equal(snapshot.staff.find(p => p.id === 'TEST-A-6').exclusion, 'Explicit exclusion');
  assert.equal(snapshot.staff.find(p => p.id === 'TEST-A-8').exclusion, 'Joined after month start');
  assert.ok(snapshot.rows.some(r => r.id === 'TEST-A-7'));
  assert.deepEqual(snapshot.catalog.find(s => s.id === 'GY'), { id: 'GY', kind: 'work', start: '15:00:00', end: '02:00:00', color: '#82d9ee' });
  const draft = sourceDraft(snapshot, snapshot.staff.map(p => p.id), false, ['AM', 'GY']);
  const context = contextFor(draft, 'Affiliate', month);
  assert.ok(context.people.every(p => p.group === 'unassigned' && !p.id.startsWith('SYN')));
  assert.equal(context.previous['TEST-A-1|2026-11-30'], 'OFF');
  assert.equal(context.next['TEST-A-1|2027-01-01'], 'GY');
  assert.equal(context.leave['TEST-A-2|2026-12-06'], 'AL');
  assert.equal(context.leave['TEST-A-3|2026-12-10'], 'SL');
  assert.equal(context.leave['TEST-A-4|2026-12-14'], 'UL');
  const plan = generateCandidates(context, { strategy: 'balanced' }).candidates[0];
  assert.equal(plan.status, 'feasible');
  assert.equal(plan.cells['TEST-A-2|2026-12-06'], 'AL');
  assert.ok(!Object.values(plan.cells).includes('AM1'));
});

test('duplicates and ambiguous time or staff records cannot be silently loaded', async () => {
  const { prepareRosterSource, sourceDraft } = await adapter;
  const raw = payload();
  raw.schedule.push({ ...raw.schedule[2] });
  raw.schedule.push({ ...raw.schedule[5], staff_id: 'UNKNOWN' });
  raw.schedule[3].shift_code = 'UNKNOWN';
  raw.schedule[6].end_time = '16:30:00';
  const source = prepareRosterSource(raw, 'Affiliate', month);
  assert.equal(source.usable, false);
  assert.equal(source.cells['TEST-A-1|2026-12-03'], undefined);
  assert.ok(source.issues.some(i => i.kind === 'Duplicate staff/date schedule'));
  assert.ok(source.issues.some(i => i.kind === 'Unknown staff ID'));
  assert.ok(source.issues.some(i => /times or status differ/.test(i.kind)));
  assert.throws(() => sourceDraft(source), /Resolve source conflicts/);
});

test('read timeout applies through response body, coalesces requests and reports changed revisions without fallback', async () => {
  const { createSourceReader, fixtureDraftKey } = await adapter;
  let mode = 'slow', calls = 0;
  const reader = createSourceReader({ deadline: 15, request: async () => {
    calls++;
    if (mode === 'slow') return { ok: true, json: () => new Promise(() => {}) };
    if (mode === 'denied') return { ok: false, status: 401 };
    return { ok: true, json: async () => ({ ...payload(), revision: mode }) };
  } });
  const first = reader.refresh('Affiliate', month);
  assert.equal(reader.refresh('Affiliate', month), first);
  assert.equal((await first).state, 'timeout');
  assert.equal(calls, 1);
  mode = 'one'; assert.equal((await reader.refresh('Affiliate', month)).state, 'ready');
  mode = 'two'; assert.equal((await reader.refresh('Affiliate', month)).changed, true);
  mode = 'denied'; assert.equal((await reader.refresh('Affiliate', month)).previous, null);
  assert.equal(reader.last, null);
  assert.notEqual(fixtureDraftKey('user-1', 'Affiliate', month), fixtureDraftKey('user-2', 'Affiliate', month));
});

test('loopback fixture route denies direct access and is independent of the normal preview', async t => {
  const server = await startPreview(0, '127.0.0.1', { fixture: true, role: 'CSP_ADMIN' });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const path = '/roster-fixture/snapshot';
  assert.equal((await fetch(base + path + '?team=CSP&month=' + month)).status, 401);
  const page = await fetch(base + '/admin-roster-source.html');
  assert.ok(page.headers.get('set-cookie').includes('HttpOnly'));
  const headers = { cookie: page.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(base + path + '?team=Affiliate&month=' + month + '&role=SUPER_ADMIN', { headers })).status, 403);
  const started = performance.now();
  const response = await fetch(base + path + '?team=CSP&month=' + month, { headers });
  assert.equal(response.status, 200);
  const data = await response.text();
  t.diagnostic(JSON.stringify({ requests: 1, bytes: Buffer.byteLength(data), ms: Math.round(performance.now() - started), fixtureOnly: true }));
  assert.equal(JSON.parse(data).team, 'CSP');
  assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 405);
  const normal = await startPreview(0);
  t.after(() => normal.close());
  assert.equal((await fetch('http://127.0.0.1:' + normal.address().port + path)).status, 404);
});
