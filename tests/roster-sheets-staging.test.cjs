const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixtureRows } = require('../scripts/roster-fixture.cjs');
const adapter = import('../backend/roster-sheets-staging.mjs');
const team = 'Affiliate', month = '2026-12';
const active = { id: 'TEST-A-1', team, login: 'FIXTURE1', name: 'Roster Fixture 1' };
const existing = ['SCH-existing', month, '2026-12-01', active.id, active.login, active.name,
  team, 'OFF', '', '', 'OFF', 'Original uploader', '2026-11-28', 'Original note'];
const leave = ['SCH-leave', month, '2026-12-06', 'TEST-A-2', 'FIXTURE2', 'Roster Fixture 2',
  team, 'AL', '', '', 'OFF', 'Original uploader', '2026-11-28', 'Leave note'];
const overnight = date => ({ team, staff_id: active.id, schedule_month: month, schedule_date: date,
  shift_code: 'GY', start_time: '15:00:00', end_time: '02:00:00', status: 'WORKING' });
const changes = [
  { before: { id: active.id, date: existing[2], code: 'OFF', start: '', end: '', status: 'OFF' }, after: overnight(existing[2]) },
  { before: null, after: overnight('2026-12-02') }
];

function mockSheets() {
  const calls = [], grid = [];
  function fetchImpl(url, init) {
    const input = init.body && JSON.parse(init.body);
    calls.push({ url, method: init.method, input });
    if (url.endsWith('/spreadsheets')) return Response.json({ spreadsheetId: 'disposable-book', ...input });
    if (url.includes(':batchUpdate')) {
      for (const { updateCells } of input.requests) {
        if (!updateCells) continue;
        const { start, rows } = updateCells;
        rows.forEach(({ values }, offset) => {
          const index = start.rowIndex + offset;
          grid[index] ||= [];
          values.forEach(({ userEnteredValue }, col) => {
            grid[index][start.columnIndex + col] = userEnteredValue?.stringValue ?? '';
          });
        });
      }
      return Response.json({});
    }
    return Response.json({ values: grid });
  }
  return { calls, fetchImpl, grid };
}

test('staging adapter creates its own workbook and verifies one atomic batch without altering leave or existing metadata', async () => {
  const { createDisposableRosterSheet } = await adapter, mock = mockSheets();
  const other = [...existing]; other[0] = 'SCH-other'; other[3] = 'TEST-C-1'; other[4] = 'FIXTUREC1'; other[6] = 'CSP';
  const staged = await createDisposableRosterSheet({ accessToken: 'fixture', fetchImpl: mock.fetchImpl, initialRows: [existing, leave, other] });
  assert.equal(await staged.reconcileBatch(changes, team, month), 'not-written');
  await staged.commitBatch(changes, team, month, [active]);
  assert.equal(await staged.reconcileBatch(changes, team, month), 'verified');
  const writes = mock.calls.filter(call => call.url.endsWith(':batchUpdate'));
  assert.equal(writes.length, 2, 'seed batch plus a single mutation batch');
  assert.ok(writes.every(call => call.url.includes('/disposable-book:batchUpdate')));
  assert.deepEqual(writes[1].input.requests.map(r => r.updateCells.start.columnIndex), [7, 0]);
  const [updated, keptLeave, keptOther, inserted] = await staged.readRows();
  assert.deepEqual(updated.slice(0, 7), existing.slice(0, 7));
  assert.deepEqual(updated.slice(11), existing.slice(11));
  assert.deepEqual(keptLeave, leave);
  assert.deepEqual(keptOther, other);
  assert.equal(inserted[9], '02:00:00');
  await assert.rejects(staged.commitBatch(changes, team, month, [active]), /before-image changed/);
  assert.equal(mock.calls.filter(call => call.url.endsWith(':batchUpdate')).length, 2);
});

test('staging adapter refuses duplicate, leave, wrong scope and changed before-images without another batch', async () => {
  const { createDisposableRosterSheet } = await adapter, mock = mockSheets();
  const staged = await createDisposableRosterSheet({ accessToken: 'fixture', fetchImpl: mock.fetchImpl, initialRows: [existing, leave] });
  await assert.rejects(staged.commitBatch([changes[0], changes[0]], team, month, [active]), /Ambiguous/);
  await assert.rejects(staged.commitBatch(changes, 'CSP', month, [active]), /scope/);
  await assert.rejects(staged.commitBatch(changes, team, month, [active, { ...active, id: 'TEST-A-3' }]), /directory/);
  const published = { before: { id: leave[3], date: leave[2], code: 'AL', start: '', end: '', status: 'OFF' },
    after: { ...overnight(leave[2]), staff_id: leave[3] } };
  await assert.rejects(staged.commitBatch([published], team, month, [{ ...active, id: leave[3], login: leave[4] }]), /Protected leave/);
  mock.grid[1][7] = 'PM';
  assert.equal(await staged.reconcileBatch(changes, team, month), 'uncertain');
  await assert.rejects(staged.commitBatch(changes, team, month, [active]), /before-image changed/);
  assert.equal(mock.calls.filter(call => call.url.endsWith(':batchUpdate')).length, 1);
});

async function monthlyIntegration(options, reportBook = () => {}) {
  const { createDisposableRosterSheet } = await adapter;
  const { createRosterPublisher, fixturePublishConfiguration } = await import('../backend/roster-publish.mjs');
  const { prepareRosterSource, publicationConfiguration } = await import('../js/roster-source.js');
  const { contextFor } = await import('../js/roster-model.js');
  const { generateCandidates } = await import('../js/roster-generator.js');
  const raw = fixtureRows(team, month), actor = { id: 'staging-admin', role: 'SUPER_ADMIN', active: true };
  const directory = raw.staff.map(s => ({ id: s.staff_id, login: s.login_id, name: s.full_name, team }));
  const seed = raw.schedule.map((s, i) => {
    const person = directory.find(p => p.id === s.staff_id);
    return ['SCH-staging-' + i, s.schedule_month, s.schedule_date, person.id, person.login, person.name,
      team, s.shift_code, s.start_time, s.end_time, s.status, 'Fixture', '2026-11-28', 'Original note'];
  });
  const staged = await createDisposableRosterSheet({ ...options, initialRows: seed });
  reportBook(staged.id);
  const readSource = async () => {
    const rows = await staged.readRows();
    return { ...raw, ok: true, team, month, teams: [team], principal: 'staging',
      revision: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      schedule: rows.filter(r => r[3]).map(r => ({ schedule_month: r[1], schedule_date: r[2], staff_id: r[3],
        team: r[6], shift_code: r[7], start_time: r[8], end_time: r[9], status: r[10] })) };
  };
  const source = prepareRosterSource(await readSource(), team, month);
  const context = contextFor(fixturePublishConfiguration(source), team, month);
  const candidate = generateCandidates(context, { strategy: 'balanced' }).candidates[0];
  assert.equal(candidate.status, 'feasible');
  const records = context.people.flatMap(p => context.dates.map(date => ({
    staffId: p.id, date, shift: candidate.cells[p.id + '|' + date]
  })));
  const journal = new Map();
  const publish = createRosterPublisher({
    readSource, readConfiguration: fixturePublishConfiguration, windowVerified: () => true,
    commitBatch: (changes, team, month) => staged.commitBatch(changes, team, month, directory), reconcileBatch: staged.reconcileBatch,
    journal: { get: id => journal.get(id), put: op => journal.set(op.id, op), unresolved: () =>
      [...journal.values()].some(op => op.state === 'pending' || op.state === 'uncertain') }
  });
  const preview = await publish(actor, { action: 'preview', team, month, records,
    configuration: publicationConfiguration(context), sourceRevision: source.revision });
  assert.equal(preview.status, 200);
  const command = { action: 'commit', team, month, id: preview.body.id, acknowledged: true };
  assert.equal((await publish(actor, command)).body.state, 'verified');
  assert.equal((await publish(actor, command)).body.state, 'verified');
  const after = await staged.readRows();
  assert.equal(after.length, 158);
  assert.equal(new Set(after.map(r => r[3] + '|' + r[2])).size, after.length);
  for (const row of seed.filter(r => ['AL', 'SL', 'UL'].includes(r[7]) || r[1] !== month || r[3] === 'TEST-A-7')) {
    assert.ok(after.some(r => JSON.stringify(r) === JSON.stringify(row)));
  }
}

test('monthly publisher and staging adapter integrate through the mock Sheets transport', async () => {
  const mock = mockSheets();
  await monthlyIntegration({ accessToken: 'fixture', fetchImpl: mock.fetchImpl });
  assert.equal(mock.calls.filter(call => call.url.endsWith(':batchUpdate')).length, 2);
});

test('Google Sheets staging integration: publish a validated roster and verify receipt and physical rows', {
  skip: process.env.ROSTER_RUN_GOOGLE_STAGING !== '1' && 'Set ROSTER_RUN_GOOGLE_STAGING=1 for the disposable Google Sheets test'
}, async t => {
  assert.ok(process.env.ROSTER_STAGING_ACCESS_TOKEN, 'Missing authorized staging Sheets token');
  await monthlyIntegration({ accessToken: process.env.ROSTER_STAGING_ACCESS_TOKEN }, id =>
    t.diagnostic('Disposable workbook: https://docs.google.com/spreadsheets/d/' + id + '/edit'));
});
