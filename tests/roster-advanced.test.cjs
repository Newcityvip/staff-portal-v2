const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const model = import('../js/roster-model.js');
const generator = import('../js/roster-generator.js');
const policy = import('../js/roster-policy.js');
const { previewOptions } = require('../scripts/roster-preview.cjs');

test('temporary bulk transfers, permanent transfers, undo and historical snapshots preserve single team membership', async () => {
  const { seed, transferMany, transfer, contextFor, snapshot, createHistory, groupMatches } = await model;
  const history = createHistory(seed());
  const ids = ['SYN-001', 'SYN-002'];
  const groups = month => contextFor(history.current, 'Affiliate', month).people.filter(p => ids.includes(p.id)).map(p => p.group);
  const prior = snapshot(contextFor(history.current, 'Affiliate', '2026-11'));
  history.change(m => assert.equal(transferMany(m, [...ids, ids[0]], 'new', '2026-12', true), true));
  assert.deepEqual(groups('2026-11'), ['old', 'old']);
  assert.deepEqual(groups('2026-12'), ['new', 'new']);
  assert.deepEqual(groups('2027-01'), ['old', 'old']);
  history.change(m => assert.equal(transfer(m, ids[0], 'new', '2027-01'), true));
  assert.deepEqual(groups('2027-02'), ['new', 'old']);
  assert.equal(transferMany(history.current, [ids[0], 'SYN-019'], 'new', '2026-12', true), false);
  history.change(m => transfer(m, ids[1], 'old', '2026-12', true));
  assert.equal(groupMatches(history.current, ids[1], '2026-12').length, 1);
  assert.deepEqual(groups('2026-12'), ['new', 'old']);
  history.undo();
  assert.deepEqual(groups('2026-12'), ['new', 'new']);
  assert.equal(prior.people.find(p => p.id === ids[0]).group, 'old');
});

test('date beats weekday beats default; group, month and CSP rules stay independent', async () => {
  const { seed, contextFor } = await model;
  const { coverageRule, validCoverage } = await policy;
  const m = seed(), c = contextFor(m, 'Affiliate', '2026-12');
  c.draft.coverage['old|*|AM'] = 1;
  c.draft.coverage['old|Tue|AM'] = { min: 2, target: 3, max: 4, priority: 3 };
  c.draft.coverage['old|2026-12-01|AM'] = { min: 0, target: 0, max: 0, enabled: false };
  assert.equal(coverageRule(c, 'old', '2026-12-01', 'AM').enabled, false);
  assert.equal(coverageRule(c, 'old', '2026-12-08', 'AM').target, 3);
  assert.equal(coverageRule(c, 'old', '2026-12-02', 'AM').min, 1);
  assert.equal(coverageRule(c, 'new', '2026-12-02', 'AM').min, 0);
  assert.equal(coverageRule(contextFor(m, 'Affiliate', '2027-01'), 'old', '2027-01-05', 'AM').min, 0);
  assert.equal(coverageRule(contextFor(m, 'CSP', '2026-12'), 'csp', '2026-12-01', 'DAY').min, 0);
  assert.equal(validCoverage({ min: 3, target: 2, max: 4, enabled: true, priority: 1 }), false);
  assert.equal(validCoverage({ min: 0, target: 1, max: 0, enabled: true, priority: 1 }), false);
});

test('PM optimization improves actual Phase 1 results on identical mandatory inputs', async t => {
  const { seed, contextFor } = await model;
  const { validate, generateCandidates } = await generator;
  const { coverageReport } = await policy;
  const legacy = execFileSync('git', ['show', '07f72faf320701e022e72b98274ea0120f690331:js/roster-generator.js'], { encoding: 'utf8' })
    .replace('"./roster-model.js"', JSON.stringify(pathToFileURL(path.resolve('js/roster-model.js')).href));
  const beforeGenerator = await import('data:text/javascript;base64,' + Buffer.from(legacy).toString('base64'));
  const c = contextFor(seed(), 'Affiliate', '2026-12');
  c.draft.rules.offPolicy = 'legacy';
  c.draft.coverage['old|*|AM'] = 1;
  c.draft.coverage['new|*|AM'] = 1;
  c.draft.coverage['new|2026-12-04|PM'] = 2;
  const before = beforeGenerator.generate(c);
  const progress = [];
  const next = generateCandidates(c, { strategy: 'pm' }, p => progress.push(p));
  assert.equal(before.status, 'feasible', before.reason);
  assert.equal(next.status, 'feasible', next.reason);
  assert.ok(next.candidates.length > 1 && next.candidates.length <= 3);
  assert.equal(progress.length, 3);
  const compare = result => {
    const report = coverageReport(c, result.cells);
    assert.equal(validate(c, result.cells).errors.length, 0);
    return { PM: report.pm, working: report.working, PMShare: +report.pmPercent.toFixed(2) };
  };
  const old = compare(before), current = compare(next.candidates[0]);
  assert.ok(current.PM > old.PM && current.PMShare > old.PMShare);
  t.diagnostic(JSON.stringify({ before: old, after: current, candidates: next.candidates.length }));
});

test('balanced and custom honor limits, disabled shifts, fixed and multiple allowed shifts', async () => {
  const { seed, contextFor, key } = await model;
  const { generate, validate } = await generator;
  const { coverageReport } = await policy;
  const c = contextFor(seed(), 'Affiliate', '2026-12');
  c.draft.rules.offPolicy = 'legacy';
  c.draft.coverage['old|*|PM'] = { min: 0, target: 2, max: 2, priority: 3 };
  c.draft.coverage['old|*|PM1'] = { min: 0, target: 0, enabled: false };
  c.draft.coverage['new|*|AM'] = { min: 1, target: 2, max: 3, priority: 2 };
  c.draft.preferences['SYN-001'] = { fixed: 'AM', allowed: ['AM', 'AM1'], weeklyOff: 3, consecutiveOff: 2, maxRun: 4, rest: 11 };
  c.draft.preferences['SYN-002'] = { allowed: ['AM', 'AM1'], restrictRotation: true };
  for (const strategy of ['balanced', 'custom']) {
    const r = generate(c, { strategy });
    assert.equal(r.status, 'feasible', r.reason);
    assert.equal(validate(c, r.cells).errors.length, 0);
    const assigned = id => c.dates.map(date => r.cells[key(id, date)]);
    assert.ok(assigned('SYN-001').every(s => ['AM', 'OFF'].includes(s)));
    assert.equal(new Set(assigned('SYN-002').filter(s => s !== 'OFF')).size, 1);
    assert.ok(coverageReport(c, r.cells).daily.filter(d => d.group === 'old').every(d =>
      d.shifts.find(s => s.id === 'PM1').count === 0 && d.shifts.find(s => s.id === 'PM').count <= 2));
  }
});

test('target priority is a preference and custom generation meets targets where eligible', async () => {
  const { seed, contextFor } = await model;
  const { generate } = await generator;
  const { coverageReport } = await policy;
  const c = contextFor(seed(), 'Affiliate', '2026-12');
  c.draft.coverage['new|2026-12-01|AM'] = { min: 0, target: 3, max: 3, priority: 3 };
  const r = generate(c, { strategy: 'custom', group: 'new' });
  assert.equal(r.status, 'feasible', r.reason);
  const row = coverageReport(c, r.cells).daily.find(d => d.group === 'new' && d.date === '2026-12-01');
  assert.equal(row.shifts.find(s => s.id === 'AM').count, 3);
});

test('fill-empty and selected staff preserve existing assignments and locks', async () => {
  const { seed, contextFor, key } = await model;
  const { generate } = await generator;
  const c = contextFor(seed(), 'Affiliate', '2026-12');
  const a = key('SYN-001', c.dates[0]), b = key('SYN-001', c.dates[1]), outside = key('SYN-002', c.dates[0]);
  Object.assign(c.draft.cells, { [a]: 'AM', [b]: 'AM1', [outside]: 'PM' });
  c.draft.locks[b] = true;
  const r = generate(c, { keepAssigned: true, people: ['SYN-001'] });
  assert.equal(r.status, 'feasible', r.reason);
  assert.deepEqual([r.cells[a], r.cells[b], r.cells[outside]], ['AM', 'AM1', 'PM']);
  assert.equal(r.cells[key('SYN-002', c.dates[1])], undefined);
  assert.equal(r.selectedCount, 1);
});

test('previous pattern ranks old shifts, leaves month data unchanged and reports missing history', async () => {
  const { seed, contextFor, key } = await model;
  const { generate } = await generator;
  const c = contextFor(seed(), 'CSP', '2026-12');
  c.draft.rules.offPolicy = 'legacy';
  assert.equal(generate(c, { strategy: 'previous' }).status, 'missing-boundary');
  c.previous[key('SYN-019', '2026-11-01')] = 'MID';
  const before = structuredClone(c.previous);
  const r = generate(c, { strategy: 'previous', people: ['SYN-019'] });
  assert.equal(r.status, 'feasible', r.reason);
  assert.equal(r.cells[key('SYN-019', '2026-12-01')], 'MID');
  assert.deepEqual(c.previous, before);
});

test('diagnostics separate leave, blank locks, insufficient staff, rest and weekly OFF violations', async () => {
  const { seed, contextFor, key } = await model;
  const { generate, validate } = await generator;
  const c = contextFor(seed(), 'Affiliate', '2026-12'), id = 'SYN-001';
  c.draft.rules.offPolicy = 'legacy';
  c.draft.coverage['old|2026-12-09|AM'] = 10;
  assert.equal(generate(c).code, 'staffing');
  c.draft.coverage = {};
  c.draft.cells[key('SYN-003', '2026-12-09')] = 'PM';
  assert.equal(generate(c).code, 'leave');
  c.draft.cells[key('SYN-003', '2026-12-09')] = 'AL';
  c.draft.locks[key(id, c.dates[0])] = true;
  assert.equal(generate(c).code, 'locked');
  c.draft.preferences[id] = { weeklyOff: 3, consecutiveOff: 2, maxRun: 2 };
  for (const date of c.dates) c.draft.cells[key(id, date)] = date.endsWith('01') ? 'PM' : 'AM';
  const issues = validate(c).errors.map(e => e.label);
  assert.ok(issues.some(s => /Insufficient rest/.test(s)));
  assert.ok(issues.some(s => /Too many consecutive/.test(s)));
  assert.ok(issues.some(s => /Weekly OFF minimum/.test(s)));
  c.draft.preferences[id] = { weeklyOff: 0, consecutiveOff: 2, maxRun: 14 };
  assert.ok(validate(c).errors.some(e => /Consecutive OFF requirement/.test(e.label)));
});

test('LAN preview stays loopback by default and accepts only explicitly owned private addresses', () => {
  const interfaces = { WiFi: [{ address: '10.20.30.40', family: 'IPv4', internal: false }] };
  assert.deepEqual(previewOptions([], interfaces), { host: '127.0.0.1', lan: false, port: 8765 });
  assert.deepEqual(previewOptions(['--lan', '10.20.30.40', '8766'], interfaces), { host: '10.20.30.40', lan: true, port: 8766 });
  assert.throws(() => previewOptions(['--lan', '0.0.0.0'], interfaces));
  assert.throws(() => previewOptions(['--lan', '10.20.30.41'], interfaces));
});
