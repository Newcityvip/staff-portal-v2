const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const m = import('../js/roster-model.js');
const g = import('../js/roster-generator.js');
const b = import('../js/roster-diagnostic-bundle.js');
const oldOptions = { strategy: 'balanced', group: 'old', keepAssigned: true };
const oldFixture = [
  'CCCOODDDDDOODDDDDOODDDDDOODDDDD', 'DDOOCCCCCOOBBBBBOOBBBBBOOBBBBBO',
  'AAAAAOOCLCCCOOCCCCCOOCCCCCOOCCC', 'BBBBOOCCCCCOOBBBBBOOBBBBBOOBBBB',
  'OODDDDDOOAAAAAOOAAAAAOOAAAAAOOA', 'AAAAOOAAAAAOOAAAAAOOAAAAAOOAAAA',
  'BBBBBOOBBBBBOOBBBBBOOBBBBBOOBBB', 'CCCOOBBBBBOOCCCCCOOCCCCCOOCCCCC',
  'OCCCCCOODDDDDOODDDDDOODDDDDOODD', 'DDOOAAAAAOOAAAAAOOAAAAAOOAAAAAO'
];

async function december() {
  const { seed, contextFor } = await m;
  const context = contextFor(seed(), 'Affiliate', '2026-12');
  for (const [i, day] of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].entries()) {
    context.draft.demand['old|' + day] = { workload: ['Normal', 'Busy', 'Very Busy', 'Busy', 'Normal', 'Quiet', 'Quiet'][i] };
  }
  return context;
}

async function baseline() {
  const version = '641b46b6fb475c693f0ebf35af2709bd2eb06b21';
  const urls = new Map();
  for (const file of ['roster-model', 'roster-weekly', 'roster-policy', 'roster-generator']) {
    const source = execFileSync('git', ['show', version + ':js/' + file + '.js'], { encoding: 'utf8' })
      .replace(/"\.\/(roster-[a-z]+)\.js"/g, (_, dep) => JSON.stringify(urls.get(dep)));
    urls.set(file, 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  }
  return import(urls.get('roster-generator'));
}

test('dated OLD Brands constraints exceed the Phase 1D search budget but validate as a full month', async t => {
  const { generateCandidates, validate } = await g;
  const ctx = await december(), old = await baseline();
  const workCodes = ['AM', 'AM1', 'PM1', 'PM'];
  for (const [i, date] of ctx.dates.entries()) if (i >= 5) {
    for (const [n, code] of workCodes.entries()) {
      const exact = oldFixture.filter(row => row[i] === 'ABCD'[n]).length;
      ctx.draft.coverage['old|' + date + '|' + code] = { min: exact, target: exact, max: exact };
    }
  }
  const run = fn => {
    const start = performance.now(), result = fn(ctx, oldOptions);
    return { result, ms: Number((performance.now() - start).toFixed(1)) };
  };
  // Drive the historical solver to its step limit independently of CPU contention.
  const before = run((context, options) => {
    const clock = t.mock.method(performance, 'now', () => 0);
    try { return old.generateCandidates(context, options); }
    finally { clock.mock.restore(); }
  });
  const after = run(generateCandidates);
  assert.equal(before.result.status, 'timeout');
  assert.equal(before.result.steps, 60001);
  assert.equal(after.result.status, 'feasible');
  const best = after.result.candidates[0], metrics = best.metrics;
  assert.notEqual(best.profile, 'Validated fallback');
  assert.equal(metrics.completion, 100);
  assert.equal(metrics.coverage, 100);
  assert.equal(metrics.blockers, 0);
  assert.equal(validate(ctx, best.cells, { people: new Set(best.scopePeople), groups: best.scopeGroups }).errors.length, 0);
  t.diagnostic(JSON.stringify({ before: { ms: before.ms, steps: before.result.steps, assigned: before.result.best.completed },
    after: { ms: after.ms, assigned: metrics.assigned, expected: metrics.expected, coverage: metrics.coverage,
      paired: metrics.paired, weeks: metrics.windows, leave: metrics.leaveMet, blockers: metrics.blockers } }));
});

test('proven impossible coverage produces a full legal provisional month and tested exact-date recovery', async t => {
  const { generateCandidates, adjustmentTrial } = await g;
  const ctx = await december();
  const lock = 'SYN-001|2026-12-07', date = '2026-12-16';
  ctx.draft.cells[lock] = 'PM'; ctx.draft.locks[lock] = true;
  ctx.draft.coverage['old|' + date + '|AM'] = 11;
  const before = structuredClone(ctx), result = generateCandidates(ctx, oldOptions);
  assert.equal(result.status, 'infeasible');
  const best = result.candidates[0], metrics = best.metrics;
  assert.equal(best.status, 'provisional');
  assert.equal(metrics.completion, 100);
  assert.equal(metrics.staffBlockers, 0);
  assert.equal(metrics.leaveMet, metrics.leaveTotal);
  assert.equal(metrics.paired, metrics.windows);
  assert.equal(best.cells[lock], 'PM');
  assert.ok(metrics.shortages.some(s => s.date === date && s.shift === 'AM'));
  const item = result.suggestions.find(s => s.field === 'min' && s.date === date);
  assert.ok(item?.impact);
  assert.equal(item.impact.outcome, 'Resolves in this trial');
  assert.equal(item.impact.before.needed, 11);
  assert.equal(item.impact.after.needed, item.proposed);
  const trial = adjustmentTrial(ctx, oldOptions, [item]);
  assert.equal(generateCandidates(trial.context, trial.options).status, 'feasible');
  assert.deepEqual(ctx, before);
  t.diagnostic(JSON.stringify({ before: item.impact.before, after: item.impact.after }));
});

test('NEW Brands, combined Affiliate, temporary transfer and CSP use the same optimizer and boundaries', async () => {
  const { seed, contextFor, transfer } = await m;
  const { generateCandidates } = await g;
  const model = seed();
  for (const [team, group, count] of [['Affiliate', 'new', 8], ['Affiliate', '', 18], ['CSP', '', 6]]) {
    const result = generateCandidates(contextFor(model, team, '2026-12'), { group, strategy: 'pm' });
    const best = result.candidates[0];
    assert.equal(best.selectedCount, count);
    assert.equal(best.metrics.completion, 100);
    assert.equal(best.metrics.blockers, 0);
    assert.ok(best.warnings.some(w => w.type === 'boundary'));
    if (team === 'Affiliate') {
      const balanced = result.candidates.find(c => c.profile === 'Best Balanced');
      assert.ok(balanced && best.metrics.pm > balanced.metrics.pm);
    }
  }
  assert.equal(transfer(model, 'SYN-001', 'new', '2026-12', true), true);
  const result = generateCandidates(contextFor(model, 'Affiliate', '2026-12'), { group: 'new' });
  assert.equal(result.candidates[0].selectedCount, 9);
  assert.ok(result.candidates[0].scopePeople.includes('SYN-001'));
  assert.ok(!result.candidates[0].scopePeople.includes('SYN-002'));
  assert.equal(contextFor(model, 'Affiliate', '2027-01').people.find(p => p.id === 'SYN-001').group, 'old');
});

test('anonymized diagnostic bundle reproduces exact cap, lock, scope and policy without storing private identity', async () => {
  const { createDiagnosticBundle, readDiagnosticBundle } = await b;
  const { generateCandidates } = await g;
  const ctx = await december();
  ctx.people[0].name = 'PRIVATE NAME'; ctx.people[0].login = 'PRIVATE LOGIN';
  ctx.draft.cells['SYN-001|2026-12-07'] = 'PM';
  ctx.draft.locks['SYN-001|2026-12-07'] = true;
  ctx.draft.coverage['old|2026-12-07|PM'] = { min: 0, max: 0 };
  const exported = createDiagnosticBundle(ctx, oldOptions);
  assert.doesNotMatch(exported, /PRIVATE|SYN-001/);
  const imported = readDiagnosticBundle(exported);
  assert.deepEqual(imported.options, oldOptions);
  assert.equal(imported.context.draft.locks['Staff-01|2026-12-07'], true);
  const result = generateCandidates(imported.context, imported.options);
  assert.equal(result.status, 'infeasible');
  assert.equal(result.candidates[0].metrics.completion, 100);
  assert.ok(result.issues.some(i => i.code === 'shift-cap' && i.date === '2026-12-07' && i.current === 0));
  const invalid = JSON.parse(exported); invalid.context.people[0].login = 'unexpected';
  assert.throws(() => readDiagnosticBundle(JSON.stringify(invalid)), /not a supported/i);
});
