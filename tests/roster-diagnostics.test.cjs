const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const m = import('../js/roster-model.js');
const g = import('../js/roster-generator.js');
const p = import('../js/roster-policy.js');
const w = import('../js/roster-weekly.js');
const scope = { group: 'old', keepAssigned: true, strategy: 'balanced' };

async function december() {
  const { contextFor, seed } = await m;
  const ctx = contextFor(seed(), 'Affiliate', '2026-12');
  ['Normal', 'Busy', 'Very Busy', 'Busy', 'Normal', 'Quiet', 'Quiet'].forEach((workload, i) => {
    ctx.draft.demand['old|' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]] =
      { workload, maxOff: null, preferredOff: null, minWork: 0 };
  });
  ctx.draft.coverage['old|*|AM'] = 5;
  return ctx;
}

test('old draft blanks migrate to unlimited; actual numeric zeros and other settings survive', async () => {
  const { seed, draftFor, restore } = await m;
  const { coverageRule } = await p;
  const { demandRule } = await w;
  const model = seed(), draft = draftFor(model, 'Affiliate', '2026-12');
  draft.cells['SYN-001|2026-12-01'] = 'OFF';
  draft.locks['SYN-001|2026-12-01'] = true;
  draft.coverage['old|*|PM'] = { min: 0, target: 0, max: ' ' };
  draft.coverage['old|Mon|PM'] = { min: 0, target: 0, max: 0 };
  draft.demand['old|Sun'] = { maxOff: '', preferredOff: '', minWork: 0 };
  draft.demand['old|2026-12-06'] = { maxOff: 0, preferredOff: 0 };
  const restored = restore({ getItem: () => JSON.stringify({ schema: 1, model, team: 'Affiliate', month: '2026-12' }) });
  const read = restored.model.drafts['Affiliate|2026-12'], ctx = { draft: read };
  assert.equal(coverageRule(ctx, 'old', '2026-12-06', 'PM').max, null);
  assert.equal(coverageRule(ctx, 'old', '2026-12-07', 'PM').max, 0);
  assert.equal(demandRule(ctx, 'old', '2026-12-06').maxOff, 0);
  assert.equal(demandRule(ctx, 'old', '2026-12-13').maxOff, null);
  assert.equal(demandRule(ctx, 'old', '2026-12-13').preferredOff, null);
  assert.deepEqual(read.cells, draft.cells);
  assert.deepEqual(read.locks, draft.locks);
});

test('December OLD Brands reported workload and 34-35 aggregate OFF slots are feasible with blank maxima', async t => {
  const { diagnose, generateCandidates, validate } = await g, { coverageReport } = await p;
  const ctx = await december(), before = structuredClone(ctx);
  const dates = coverageReport(ctx, ctx.draft.cells).daily.filter(day => day.group === 'old');
  assert.equal(ctx.people.filter(person => person.group === 'old').length * 2, 20);
  assert.equal(dates.slice(6, 13).reduce((a, d) => a + d.cap, 0), 34);
  assert.equal(dates.slice(0, 7).reduce((a, d) => a + d.cap, 0), 35);
  assert.equal(diagnose(ctx, scope).issues.filter(item => item.certainty === 'Confirmed').length, 0);
  for (const options of [scope, { ...scope, group: '', strategy: 'pm' }]) {
    const result = generateCandidates(ctx, options);
    assert.equal(result.status, 'feasible', result.reason);
    const candidate = result.candidates[0];
    assert.equal(candidate.selectedCount, options.group ? 10 : 18);
    assert.equal(validate(ctx, candidate.cells, { people: new Set(candidate.scopePeople), groups: candidate.scopeGroups }).errors.length, 0);
    assert.equal(candidate.cells['SYN-003|2026-12-09'], 'AL');
    assert.equal(candidate.cells['SYN-015|2026-12-17'], 'SL');
    t.diagnostic(JSON.stringify({ mode: options.strategy, selected: candidate.selectedCount, steps: candidate.steps }));
  }
  assert.deepEqual(ctx, before);
});

test('preflight attributes an explicit date cap and offers a temporary exact-date adjustment', async t => {
  const { generateCandidates, adjustmentTrial } = await g;
  const ctx = await december(), k = 'SYN-001|2026-12-07';
  ctx.draft.cells[k] = 'PM';
  ctx.draft.locks[k] = true;
  ctx.draft.coverage['old|2026-12-07|PM'] = { min: 0, target: 0, max: 0 };
  const before = structuredClone(ctx), result = generateCandidates(ctx, scope);
  const baseline = 'd90ba7000b57bfe7c7c901ca68b995726502aab2';
  const sources = new Map();
  for (const name of ['roster-model', 'roster-weekly', 'roster-policy', 'roster-generator']) {
    const source = execFileSync('git', ['show', baseline + ':js/' + name + '.js'], { encoding: 'utf8' })
      .replace(/"\.\/(roster-[a-z]+)\.js"/g, (_, dependency) => JSON.stringify(sources.get(dependency)));
    sources.set(name, 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  }
  const old = (await import(sources.get('roster-generator'))).generateCandidates(ctx, scope);
  assert.equal(result.status, 'infeasible');
  const cap = result.issues.find(item => item.code === 'shift-cap');
  assert.deepEqual([cap.group, cap.date, cap.shift, cap.current, cap.available, cap.certainty], ['old', '2026-12-07', 'PM', 0, 1, 'Confirmed']);
  const proposal = result.suggestions.find(item => item.field === 'max');
  const trial = adjustmentTrial(ctx, { ...scope, retry: true }, [proposal]);
  const recovery = generateCandidates(trial.context, trial.options);
  assert.equal(recovery.status, 'feasible', recovery.reason);
  assert.equal(recovery.candidates[0].cells[k], 'PM');
  assert.deepEqual(ctx, before);
  t.diagnostic(JSON.stringify({ baselineStatus: old.status, baselineReason: old.reason, preflightStatus: result.status,
    trialStatus: recovery.status, trialStaff: recovery.candidates[0].selectedCount }));
});

test('scope excludes unrelated brand errors; retain-only conflict can be retried without dropping locks or leave', async () => {
  const { generateCandidates, adjustmentTrial } = await g;
  const ctx = await december(), a = 'SYN-001|2026-12-01', b = 'SYN-001|2026-12-03';
  ctx.draft.cells[a] = ctx.draft.cells[b] = 'OFF';
  ctx.draft.locks[a] = true;
  ctx.draft.coverage['new|*|AM'] = 20;
  const blocked = generateCandidates(ctx, scope);
  assert.ok(blocked.issues.some(item => item.code === 'retained-policy' && item.staff === 'Avery Vale' && item.cell === b));
  assert.ok(!blocked.issues.some(item => item.group === 'new'));
  const trial = adjustmentTrial(ctx, scope, blocked.suggestions.filter(item => item.id === 'refill'));
  assert.equal(trial.options.keepAssigned, false);
  const result = generateCandidates(trial.context, trial.options);
  assert.equal(result.status, 'feasible', result.reason);
  assert.equal(result.candidates[0].cells[a], 'OFF');
  assert.notEqual(result.candidates[0].cells[b], 'OFF');
  assert.equal(ctx.draft.cells[b], 'OFF');
});

test('bounded search exposes only a read-only partial, never upgrades an observed branch to proven cause', async () => {
  const { generateCandidates, validate } = await g;
  const ctx = await december(), start = structuredClone(ctx);
  const result = generateCandidates(ctx, { ...scope, budget: 40 });
  assert.equal(result.status, 'timeout');
  assert.ok(result.best?.completed > 0);
  assert.ok(result.best.completed < 310);
  assert.ok(!result.candidates);
  assert.ok(result.issues.every(issue => ['Unknown', 'Observed branch', 'Preference'].includes(issue.certainty)));
  assert.ok(validate(ctx, result.best.cells).errors.some(issue => issue.type === 'missing'));
  assert.deepEqual(ctx, start);
  assert.equal(generateCandidates(ctx, { ...scope, retry: true }).status, 'feasible');
});

test('minimum staffing, daily OFF cap, eligibility, rest, leave and brand membership stay hard', async () => {
  const { diagnose, generateCandidates } = await g;
  const ctx = await december(), a = 'SYN-001|2026-12-01', b = 'SYN-001|2026-12-02';
  ctx.draft.cells[a] = 'PM'; ctx.draft.cells[b] = 'AM';
  ctx.draft.preferences['SYN-001'] = { fixed: 'AM' };
  ctx.draft.cells['SYN-003|2026-12-09'] = 'OFF';
  ctx.draft.demand['old|Mon'].minWork = 11;
  ctx.draft.demand['old|Wed'].maxOff = 0;
  ctx.draft.cells['SYN-002|2026-12-02'] = 'OFF';
  ctx.conflicts.push('SYN-004');
  const found = diagnose(ctx, scope).issues;
  for (const type of ['staffing', 'off-cap', 'eligibility', 'leave', 'membership', 'retained-policy']) {
    assert.ok(found.some(item => item.code === type && item.certainty === 'Confirmed'), type);
  }
  assert.ok(found.some(item => /Insufficient rest/.test(item.reason)));
  assert.equal(generateCandidates(ctx, { ...scope, retry: true }).status, 'infeasible');
});

test('preflight detects conflicting minimums even when each shift separately has enough eligible staff', async () => {
  const { diagnose } = await g;
  const ctx = await december();
  ctx.draft.coverage['old|*|AM'] = 0;
  ctx.draft.coverage['old|2026-12-07|AM'] = 1;
  ctx.draft.coverage['old|2026-12-07|AM1'] = 1;
  const old = ctx.people.filter(person => person.group === 'old');
  for (const person of old.slice(1)) ctx.draft.preferences[person.id] = { fixed: 'PM' };
  const found = diagnose(ctx, scope).issues.find(issue => issue.code === 'overlapping-eligibility');
  assert.deepEqual([found.certainty, found.date, found.shift], ['Confirmed', '2026-12-07', 'AM, AM1']);
});
