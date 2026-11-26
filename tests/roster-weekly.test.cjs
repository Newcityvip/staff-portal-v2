const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Excel = require('../vendor/exceljs-4.4.0/dist/exceljs.min.js');
const m = import('../js/roster-model.js');
const g = import('../js/roster-generator.js');
const p = import('../js/roster-policy.js');
const w = import('../js/roster-weekly.js');

async function single(team = 'Affiliate') {
  const { seed, contextFor } = await m;
  const context = contextFor(seed(), team, '2026-12');
  context.people = context.people.slice(0, 1);
  context.groups = context.groups.slice(0, 1);
  return context;
}

test('regular OFF pairs cross calendar weeks and months without counting leave as OFF', async () => {
  const { key, weekday, dayIndex, dateAt } = await m;
  const { generate, validate } = await g;
  for (const phase of [0, 4, 6]) {
    const ctx = await single(), person = ctx.people[0];
    const start = dayIndex(ctx.dates[0]), end = dayIndex(ctx.dates.at(-1));
    const off = date => (weekday(date) - phase + 7) % 7 < 2;
    for (let i = 1; i <= 7; i++) {
      for (const [source, date] of [[ctx.previous, dateAt(start - i)], [ctx.next, dateAt(end + i)]]) {
        source[key(person.id, date)] = off(date) ? 'OFF' : 'PM';
      }
    }
    const date = ctx.dates.find(date => !off(date) && date > '2026-12-06');
    ctx.leave[key(person.id, date)] = ctx.draft.cells[key(person.id, date)] = 'AL';
    const result = generate(ctx, { strategy: 'pm' });
    assert.equal(result.status, 'feasible', result.reason);
    assert.equal(result.cells[key(person.id, date)], 'AL');
    for (const day of ctx.dates) assert.equal(result.cells[key(person.id, day)] === 'OFF', off(day), day);
    const checked = validate(ctx, result.cells);
    assert.equal(checked.errors.length, 0);
    assert.equal(checked.warnings.filter(issue => issue.type === 'boundary').length, 0);
  }
});

test('isolated and excessive OFF, missing boundary and incompatible locks are explicit', async () => {
  const { key } = await m;
  const { generate, validate } = await g;
  const ctx = await single(), id = ctx.people[0].id;
  const result = generate(ctx);
  assert.equal(result.status, 'feasible');
  assert.match(result.warnings.map(e => e.label).join(' '), /Previous month boundary.*Next month boundary/);
  const cells = { ...result.cells };
  const workDate = ctx.dates.find(date => cells[key(id, date)] !== 'OFF');
  cells[key(id, workDate)] = 'OFF';
  assert.ok(validate(ctx, cells).errors.some(e => /Exactly two consecutive/.test(e.label)));
  for (const date of ['2026-12-01', '2026-12-03']) {
    ctx.draft.cells[key(id, date)] = 'OFF';
    ctx.draft.locks[key(id, date)] = true;
  }
  assert.equal(generate(ctx).code, 'off-pair');
});

test('Affiliate allows only configured pair-eve adjustments and CSP retains overnight rest', async () => {
  const { key, weekday } = await m;
  const { validate } = await g;
  const ctx = await single(), id = ctx.people[0].id;
  for (const date of ctx.dates) {
    const day = weekday(date);
    ctx.draft.cells[key(id, date)] = day === 4 || day === 5 ? 'OFF' : day === 3 ? 'PM1' : 'PM';
  }
  assert.equal(validate(ctx).errors.length, 0);
  ctx.draft.cells[key(id, '2026-12-08')] = 'PM1';
  assert.ok(validate(ctx).errors.some(e => /Shift transition is not allowed/.test(e.label)));
  ctx.draft.cells[key(id, '2026-12-08')] = 'PM';
  ctx.transitions = [];
  assert.ok(validate(ctx).errors.some(e => /Shift transition is not allowed/.test(e.label)));
  const csp = await single('CSP'), sid = csp.people[0].id;
  csp.transitions = [['NIGHT', 'DAY']];
  for (const date of csp.dates) {
    const day = weekday(date);
    csp.draft.cells[key(sid, date)] = day === 4 || day === 5 ? 'OFF' : day === 3 ? 'DAY' : 'NIGHT';
  }
  assert.ok(validate(csp).errors.some(e => /Insufficient rest/.test(e.label)));
});

test('known next-month OFF or rest conflict blocks generation', async () => {
  const { key } = await m;
  const { generate, validate } = await g;
  const ctx = await single('CSP'), id = ctx.people[0].id;
  ctx.draft.cells[key(id, '2026-12-31')] = 'NIGHT';
  ctx.draft.locks[key(id, '2026-12-31')] = true;
  ctx.next[key(id, '2027-01-01')] = 'DAY';
  const result = generate(ctx, { budget: 3000 });
  assert.notEqual(result.status, 'feasible');
  const errors = validate(ctx).errors.map(e => e.label);
  assert.ok(errors.some(message => /next-month date 2027-01-01.*Insufficient rest/.test(message)));
});

test('busy OFF cap, quiet workload, leave, independent group demand and scoped validation', async () => {
  const { seed, contextFor, key } = await m;
  const { generateCandidates, validate } = await g;
  const { coverageReport } = await p;
  const { demandRule } = await w;
  const model = seed();
  const ctx = contextFor(model, 'Affiliate', '2026-12');
  for (const group of ctx.groups) {
    ctx.draft.coverage[group.id + '|*|AM'] = 1;
    ctx.draft.demand[group.id + '|Fri'] = { workload: 'Very Busy', maxOff: 1, minWork: 3 };
    ctx.draft.demand[group.id + '|Sun'] = { workload: 'Quiet', preferredOff: 4 };
  }
  ctx.draft.demand['new|2026-12-04'] = { workload: 'Very Busy', maxOff: 0, minWork: 5 };
  assert.equal(demandRule(contextFor(model, 'CSP', '2026-12'), 'csp', '2026-12-04').maxOff, null);
  assert.equal(demandRule(ctx, 'old', '2026-12-04').maxOff, 1);
  const result = generateCandidates(ctx, { group: 'new' });
  assert.equal(result.status, 'feasible', result.reason);
  const selected = result.candidates[0];
  assert.deepEqual(selected.scopeGroups, ['new']);
  assert.equal(selected.cells[key('SYN-015', '2026-12-17')], 'SL');
  assert.ok(validate(ctx, selected.cells).errors.some(e => e.type === 'missing'));
  const dates = coverageReport(ctx, selected.cells).daily.filter(d => d.group === 'new');
  assert.equal(dates.find(d => d.date === '2026-12-04').off, 0);
  const fridays = dates.filter(d => d.demand.workload === 'Very Busy');
  const sundays = dates.filter(d => d.demand.workload === 'Quiet');
  assert.ok(fridays.every(d => d.off <= d.demand.maxOff && d.shortfall === 0));
  assert.ok(sundays.reduce((n, d) => n + d.off, 0) > fridays.reduce((n, d) => n + d.off, 0));
  assert.equal(selected.report.staff.filter(s => selected.scopePeople.includes(s.id)).reduce((n, s) => n + s.excess, 0), 0);
});

test('short aggregate capacity proves infeasibility; tiny search budget does not', async () => {
  const { generate, generateCandidates } = await g;
  const ctx = await single();
  assert.equal(generate(ctx, { budget: 1 }).status, 'timeout');
  assert.equal(generateCandidates(ctx, { budget: 1 }).status, 'timeout');
  for (const date of ctx.dates) ctx.draft.demand['old|' + date] = { maxOff: 0 };
  const result = generate(ctx);
  assert.equal(result.status, 'infeasible');
  assert.equal(result.code, 'off-capacity');
});

test('CSP balanced defaults stagger OFF pairs even without explicit demand caps', async () => {
  const { seed, contextFor } = await m;
  const { generateCandidates } = await g;
  const ctx = contextFor(seed(), 'CSP', '2026-12');
  const result = generateCandidates(ctx);
  assert.equal(result.status, 'feasible');
  const off = result.candidates[0].report.daily.filter(d => d.group === 'csp').map(d => d.off);
  assert.ok(Math.max(...off) < ctx.people.length, 'an unconstrained group should not all be OFF together');
});

test('saved Phase 1B drafts migrate without losing assignments, history or preferences', async () => {
  const { seed, contextFor, snapshot, restore, storageKey } = await m;
  const model = seed();
  const ctx = contextFor(model, 'Affiliate', '2026-12');
  ctx.draft.rules = { weeklyOff: 3, maxRun: 5, rest: 12, fair: true };
  delete ctx.draft.demand;
  delete model.transitions;
  ctx.draft.cells['SYN-001|2026-12-01'] = 'AM';
  ctx.draft.preferences['SYN-001'] = { weeklyOff: 1, preferred: 'PM' };
  model.snapshots.push(snapshot(ctx));
  const store = { getItem: name => name === storageKey ? JSON.stringify({ schema: 1, model, team: 'Affiliate', month: '2026-12' }) : null };
  const migrated = restore(store).model, draft = migrated.drafts['Affiliate|2026-12'];
  assert.equal(draft.rules.offPolicy, 'paired');
  assert.equal(draft.legacyOff.staff['SYN-001'].minimum, 1);
  assert.equal(draft.rules.rest, 12);
  assert.equal(draft.cells['SYN-001|2026-12-01'], 'AM');
  assert.equal(draft.preferences['SYN-001'].preferred, 'PM');
  assert.deepEqual(migrated.snapshots, model.snapshots);
  assert.deepEqual(migrated.transitions.CSP, []);
});

test('Excel includes planning summary without changing the flat CSV contract', async () => {
  const { snapshot } = await m;
  const { workbookBytes, rosterCsv } = await import('../js/roster-export.js');
  const ctx = await single();
  const { generate } = await g;
  ctx.draft.cells = generate(ctx).cells;
  const data = snapshot(ctx), book = new Excel.Workbook();
  await book.xlsx.load(await workbookBytes(Excel, data));
  const summary = book.getWorksheet('Planning summary');
  assert.ok(summary);
  assert.ok(summary.getRow(2).values.includes('OFF capacity'));
  assert.match(rosterCsv(data), /^"schedule_month","schedule_date","staff_id","login_id"/);
});

test('measures actual Phase 1B and 1C candidates on common Affiliate and CSP constraints', async t => {
  const { seed, contextFor } = await m;
  const { generateCandidates, validate } = await g;
  const { coverageReport } = await p;
  const oldFile = file => execFileSync('git', ['show', 'dfcd333e960048e6871305240a541e102fee9a6f:js/' + file], { encoding: 'utf8' });
  const url = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const oldModel = url(oldFile('roster-model.js'));
  const oldPolicy = url(oldFile('roster-policy.js').replace('"./roster-model.js"', JSON.stringify(oldModel)));
  const prior = await import(url(oldFile('roster-generator.js')
    .replace('"./roster-model.js"', JSON.stringify(oldModel)).replace('"./roster-policy.js"', JSON.stringify(oldPolicy))));
  for (const team of ['Affiliate', 'CSP']) {
    const ctx = contextFor(seed(), team, '2026-12');
    for (const group of ctx.groups) ctx.draft.coverage[group.id + '|*|' + (team === 'Affiliate' ? 'AM' : 'DAY')] = 1;
    const measure = (fn, priorMode) => {
      const input = structuredClone(ctx);
      if (priorMode) input.draft.rules.offPolicy = 'legacy';
      const start = performance.now();
      const output = fn(input);
      const elapsed = performance.now() - start;
      assert.equal(output.status, 'feasible', output.reason);
      const cells = output.candidates[0].cells;
      const r = coverageReport(ctx, cells);
      return { off: r.offCompliant, windows: r.offWeeks, excess: r.excessOff,
        coverage: r.daily.filter(d => !d.shortfall && ctx.groups.some(group => group.id === d.group)).length,
        pm: r.pm, work: r.working, cycleChanges: r.cycleTransitions, ms: +elapsed.toFixed(1),
        blocking: priorMode ? prior.validate(input, cells).errors.length : validate(ctx, cells).errors.length };
    };
    const before = measure(prior.generateCandidates, true), after = measure(generateCandidates, false);
    assert.equal(after.off, after.windows);
    assert.equal(after.excess, 0);
    assert.equal(before.blocking, 0);
    assert.equal(after.blocking, 0);
    assert.equal(after.coverage, before.coverage);
    t.diagnostic(JSON.stringify({ team, before, after }));
  }
});
