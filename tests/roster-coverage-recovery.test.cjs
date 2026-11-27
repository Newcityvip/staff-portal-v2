const test = require('node:test');
const assert = require('node:assert/strict');
const m = import('../js/roster-model.js');
const g = import('../js/roster-generator.js');
const p = import('../js/roster-policy.js');
const options = { group: 'old', strategy: 'pm', keepAssigned: true };

async function capped() {
  const { contextFor, seed } = await m;
  const ctx = contextFor(seed(), 'Affiliate', '2026-12');
  for (const [shift, min, max] of [['AM', 2, 2], ['AM1', 1, 1], ['PM1', 1, 1], ['PM', 1, 2]]) {
    ctx.draft.coverage['old|*|' + shift] = { min, target: min, max };
  }
  for (const [i, day] of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].entries()) {
    ctx.draft.demand['old|' + day] = { workload: ['Normal', 'Busy', 'Very Busy', 'Busy', 'Normal', 'Quiet', 'Quiet'][i] };
  }
  const k = 'SYN-001|2026-12-07';
  ctx.draft.locks[k] = true; ctx.draft.cells[k] = 'PM';
  return ctx;
}

test('preflight proves 50 required versus 42 capped slots before leave; other windows account for approved leave', async () => {
  const { diagnose } = await g;
  const ctx = await capped();
  const issues = diagnose(ctx, options).issues.filter(i => i.code === 'weekly-work-capacity');
  assert.match(issues.find(i => i.date === '2026-12-01').current, /^50 working slots/);
  assert.match(issues.find(i => i.date === '2026-12-01').available, /^42 permitted/);
  assert.match(issues.find(i => i.date === '2026-12-07').current, /^49 working slots .*1 leave/);
  assert.ok(issues.every(i => i.certainty === 'Confirmed' && i.group === 'old'));
  const { coverageRule } = await p;
  assert.equal(coverageRule(ctx, 'old', '2026-12-07', 'PM').max, 2);
});

test('coordinated exact-date cap raises and flexible targets are tested and preserve minimums, locks, OFF and leave', async t => {
  const { generateCandidates, adjustmentTrial } = await g, { coverageRule } = await p;
  const ctx = await capped(), saved = structuredClone(ctx);
  const start = performance.now();
  const result = generateCandidates(ctx, options), elapsed = performance.now() - start;
  const best = result.candidates[0];
  assert.equal(result.status, 'infeasible');
  assert.equal(best.metrics.assigned, 310);
  assert.equal(best.metrics.needed, 155);
  assert.ok(best.metrics.excess > 25);
  for (const id of ['optimize-caps', 'flexible-caps']) {
    const item = result.suggestions.find(i => i.id === id);
    assert.ok(item?.changes.length > 10);
    assert.equal(item.impact.outcome, 'Resolves in this trial');
    assert.equal(item.impact.after.met, 155);
    assert.equal(item.impact.after.excess, 0);
    assert.equal(item.impact.after.blockers, 0);
    assert.equal(item.impact.after.paired, 40);
    assert.equal(item.impact.after.leaveMet, 1);
    if (id === 'optimize-caps') {
      assert.ok(item.changes.some(c => c.shift === 'PM'));
      assert.ok(item.impact.after.pm > item.impact.before.pm);
    }
    const trial = adjustmentTrial(ctx, options, [item]);
    for (const c of item.changes) {
      const previous = coverageRule(ctx, c.group, c.date, c.shift);
      const rule = coverageRule(trial.context, c.group, c.date, c.shift);
      assert.equal(rule.min, previous.min);
      assert.equal(rule.max, id === 'flexible-caps' ? null : c.rule.max);
    }
    const verified = generateCandidates(trial.context, trial.options);
    assert.equal(verified.status, 'feasible');
    assert.equal(verified.candidates[0].cells['SYN-001|2026-12-07'], 'PM');
    assert.equal(verified.candidates[0].cells['SYN-003|2026-12-09'], 'AL');
    t.diagnostic(JSON.stringify({ id, changed: item.changes.length, ms: Math.round(elapsed),
      before: item.impact.before, after: item.impact.after }));
  }
  assert.deepEqual(ctx, saved);
});

test('daily capacity respects shift eligibility and locked cells', async () => {
  const { diagnose } = await g;
  const ctx = await capped();
  for (const person of ctx.people.filter(p => p.group === 'old')) ctx.draft.preferences[person.id] = { fixed: 'PM' };
  const issues = diagnose(ctx, options).issues;
  assert.ok(issues.some(i => i.code === 'daily-work-capacity' && i.date === '2026-12-07' &&
    /2 permitted/.test(i.available)));
});

test('coverage changes cannot repair incompatible locked OFF assignments or publish an incomplete roster', async () => {
  const { generateCandidates } = await g;
  const ctx = await capped();
  for (const date of ['2026-12-01', '2026-12-03']) {
    const k = 'SYN-002|' + date;
    ctx.draft.cells[k] = 'OFF'; ctx.draft.locks[k] = true;
  }
  const result = generateCandidates(ctx, options);
  assert.equal(result.status, 'infeasible');
  assert.ok(result.issues.some(i => i.code === 'staff-pattern'));
  assert.ok(result.candidates.every(c => c.status === 'provisional'));
  assert.ok(result.suggestions.every(s => s.impact.outcome !== 'Resolves in this trial'));
  assert.equal(ctx.draft.cells['SYN-002|2026-12-03'], 'OFF');
});
