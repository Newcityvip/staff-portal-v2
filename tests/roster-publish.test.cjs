const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureRows } = require('../scripts/roster-fixture.cjs');
const { publishFixture } = require('../scripts/roster-publish-fixture.cjs');
const superAdmin = { id: 'admin', role: 'SUPER_ADMIN', active: true };
const cspAdmin = { id: 'csp', role: 'CSP_ADMIN', active: true };
const month = '2026-12';

async function data(team = 'Affiliate') {
  const { prepareRosterSource, publicationConfiguration } = await import('../js/roster-source.js');
  const { fixturePublishConfiguration } = await import('../backend/roster-publish.mjs');
  const { contextFor } = await import('../js/roster-model.js');
  const { generateCandidates } = await import('../js/roster-generator.js');
  const raw = fixtureRows(team, month);
  const source = prepareRosterSource({ ...raw, ok: true, team, month, teams: [team], principal: 'fixture' }, team, month);
  const ctx = contextFor(fixturePublishConfiguration(source), team, month);
  const result = generateCandidates(ctx).candidates[0];
  assert.equal(result.status, 'feasible');
  const records = ctx.people.flatMap(p => ctx.dates.map(date => ({
    staffId: p.id, date, shift: result.cells[p.id + '|' + date]
  })));
  return { action: 'preview', team, month, records, configuration: publicationConfiguration(ctx), sourceRevision: source.revision };
}
const commit = (draft, id) => ({ action: 'commit', team: draft.team, month, id, acknowledged: true });

test('verified publish is scoped, preserves leave and unrelated rows, and is idempotent across concurrent submissions', async () => {
  const f = publishFixture(fixtureRows), draft = await data();
  const preview = await f.request(superAdmin, draft);
  assert.equal(preview.status, 200);
  assert.ok(preview.body.counts.new > 0);
  assert.equal(preview.body.counts.conflicting, 0);
  const command = commit(draft, preview.body.id);
  assert.equal((await f.request(superAdmin, { ...command, acknowledged: false })).status, 400);
  const results = await Promise.all([f.request(superAdmin, command), f.request(superAdmin, command)]);
  assert.ok(results.some(r => r.body.state === 'verified'));
  assert.equal((await f.request(superAdmin, command)).body.state, 'verified');
  assert.equal(f.attempts, 1);
  const after = await f.read('Affiliate', month);
  for (const row of fixtureRows('Affiliate', month).schedule.filter(r =>
    ['AL','SL','UL'].includes(r.shift_code) || r.schedule_month !== month || r.staff_id === 'TEST-A-7')) assert.ok(after.schedule.some(r => JSON.stringify(r) === JSON.stringify(row)));
  assert.deepEqual(await f.read('CSP', month), fixtureRows('CSP', month));
  assert.equal(new Set(after.schedule.map(r => r.staff_id + '|' + r.schedule_date)).size, after.schedule.length);
  const rollback = await f.request(superAdmin, { ...command, action: 'rollback' });
  assert.equal(rollback.body.state, 'rolled-back');
  assert.deepEqual((await f.read('Affiliate', month)).schedule, fixtureRows('Affiliate', month).schedule);
});

test('CSP can publish CSP only; inactive, forged config, incomplete, duplicate, leave and excluded data are rejected', async () => {
  const f = publishFixture(fixtureRows), draft = await data(), csp = await data('CSP');
  assert.equal((await f.request(cspAdmin, draft)).status, 403);
  assert.equal((await f.request({ ...superAdmin, active: false }, draft)).status, 403);
  const review = await f.request(cspAdmin, csp);
  assert.equal(review.status, 200);
  assert.equal((await f.request(cspAdmin, commit(csp, review.body.id))).body.state, 'verified');
  const invalid = structuredClone(draft);
  invalid.configuration.rules.maxRun = 99;
  assert.match((await f.request(superAdmin, invalid)).body.message, /configuration/);
  assert.match((await f.request(superAdmin, { ...draft, records: [draft.records[0]] })).body.message, /Mandatory/);
  assert.match((await f.request(superAdmin, { ...draft, records: [...draft.records, draft.records[0]] })).body.message, /Duplicate/);
  const wrongLeave = structuredClone(draft);
  wrongLeave.records.find(r => r.staffId === 'TEST-A-2' && r.date === month + '-06').shift = 'PM';
  assert.match((await f.request(superAdmin, wrongLeave)).body.message, /Published leave/);
  assert.match((await f.request(superAdmin, { ...draft, records: [...draft.records, { ...draft.records[0], staffId: 'TEST-A-7' }] })).body.message, /Invalid staff/);
  const duplicateSource = publishFixture((team, month) => {
    const raw = fixtureRows(team, month);
    raw.schedule.push(raw.schedule[0]);
    return raw;
  });
  assert.match((await duplicateSource.request(superAdmin, draft)).body.message, /Ambiguous/);
});

test('closed window and source changes after preview cause no writes', async () => {
  const draft = await data(), closed = publishFixture(fixtureRows, 'closed');
  const review = await closed.request(superAdmin, draft);
  assert.match((await closed.request(superAdmin, commit(draft, review.body.id))).body.message, /No verified/);
  assert.equal(closed.attempts, 0);
  let changed = false;
  const f = publishFixture((team, month) => {
    const raw = fixtureRows(team, month);
    return changed ? { ...raw, revision: 'modified' } : raw;
  });
  const initial = await f.request(superAdmin, draft);
  changed = true;
  assert.match((await f.request(superAdmin, commit(draft, initial.body.id))).body.message, /changed/);
  assert.match((await f.request(superAdmin, draft)).body.message, /stale/);
  assert.equal(f.attempts, 0);
});

for (const fault of ['interrupt-before', 'interrupt-after', 'mismatch']) {
  test(fault + ' never reports success and requires conditional reconciliation', async () => {
    const f = publishFixture(fixtureRows, fault), draft = await data();
    const review = await f.request(superAdmin, draft);
    const command = commit(draft, review.body.id);
    assert.equal((await f.request(superAdmin, command)).body.state, 'uncertain');
    const retry = await f.request(superAdmin, command);
    assert.equal(retry.body.state, 'uncertain');
    assert.equal(retry.body.canRecover, true);
    assert.equal(f.attempts, 1);
    const recovered = await f.request(superAdmin, { ...command, action: 'recover' });
    if (fault === 'mismatch') assert.equal(recovered.status, 409);
    else {
      assert.equal(recovered.body.state, fault === 'interrupt-before' ? 'not-written' : 'verified');
      assert.equal((await f.request(superAdmin, { ...command, action: 'status' })).body.canRecover, false);
      assert.equal((await f.request(superAdmin, { ...command, action: 'recover' })).status, 403);
    }
    assert.equal(f.attempts, 1);
  });
}

test('CSP Admin can see their own uncertain receipt but cannot recover it', async () => {
  const f = publishFixture(fixtureRows, 'interrupt-after'), draft = await data('CSP');
  const preview = await f.request(cspAdmin, draft);
  const command = commit(draft, preview.body.id);
  assert.equal((await f.request(cspAdmin, command)).body.state, 'uncertain');
  assert.equal((await f.request(cspAdmin, { ...command, action: 'status' })).body.canRecover, false);
  assert.equal((await f.request(cspAdmin, { ...command, action: 'recover' })).status, 403);
  assert.equal(f.attempts, 1);
});
