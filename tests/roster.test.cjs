const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ExcelJS = require('../vendor/exceljs-4.4.0/dist/exceljs.min.js');
const model = import('../js/roster-model.js');
const solver = import('../js/roster-generator.js');
const exportsModule = import('../js/roster-export.js');

test('calendar handles 28 to 31 days, leap years and year rollover', async () => {
  const { datesFor, previousMonth, weekday } = await model;
  assert.deepEqual(['2027-02', '2028-02', '2026-11', '2026-12', '2100-02'].map(m => datesFor(m).length), [28, 29, 30, 31, 28]);
  assert.equal(previousMonth('2027-01'), '2026-12');
  assert.equal(weekday('2026-12-01'), 2);
});

test('group transfers use IDs, respect team, apply by effective month and preserve snapshots', async () => {
  const { seed, contextFor, snapshot, groupOf, transfer } = await model;
  const m = seed(), id = 'SYN-001';
  const ctx = contextFor(m, 'Affiliate', '2026-12');
  assert.equal(ctx.people.filter(p => p.group === 'old').length, 10);
  assert.equal(ctx.people.filter(p => p.group === 'new').length, 8);
  const saved = snapshot(ctx);
  assert.equal(transfer(m, id, 'csp', '2027-01'), false);
  assert.equal(transfer(m, id, 'new', '2027-01'), true);
  assert.equal(groupOf(m, id, '2027-01'), 'new');
  assert.equal(groupOf(m, id, '2026-12'), 'old');
  assert.equal(saved.people.find(p => p.id === id).group, 'old');
  assert.equal(m.people.find(p => p.id === id).team, 'Affiliate');
  m.memberships.push({ id, group: 'old', from: '2027-01' });
  assert.deepEqual(contextFor(m, 'Affiliate', '2027-01').conflicts, [id]);
});

test('draft restoration and undo/redo do not change earlier edits', async () => {
  const { seed, createHistory, draftFor, save, restore } = await model;
  const history = createHistory(seed());
  history.change(m => { draftFor(m, 'CSP', '2026-12').cells['SYN-019|2026-12-01'] = 'NIGHT'; });
  history.undo();
  assert.equal(history.current.drafts['CSP|2026-12'], undefined);
  history.redo();
  const memory = new Map();
  const storage = { setItem: (key, value) => memory.set(key, value), getItem: key => memory.get(key) };
  save(storage, history.current, 'CSP', '2026-12');
  assert.equal(restore(storage).model.drafts['CSP|2026-12'].cells['SYN-019|2026-12-01'], 'NIGHT');
});

test('deterministic generation meets coverage, preserves locks/leave and never transfers staff', async t => {
  const { seed, contextFor, key, coverage } = await model;
  const { generate, validate } = await solver;
  const context = contextFor(seed(), 'Affiliate', '2026-12');
  const locked = key('SYN-001', context.dates[0]), leave = key('SYN-003', '2026-12-09');
  context.draft.cells[locked] = 'AM';
  context.draft.locks[locked] = true;
  context.draft.coverage['old|*|AM'] = 1;
  context.draft.coverage['new|2026-12-04|PM'] = 2;
  const result = generate(context), repeat = generate(context);
  assert.equal(result.status, 'feasible', result.reason);
  assert.deepEqual(result.cells, repeat.cells);
  assert.equal(result.cells[locked], 'AM');
  assert.equal(result.cells[leave], 'AL');
  assert.equal(validate(context, result.cells).errors.length, 0);
  assert.ok(coverage(context.people.filter(p => p.group === 'old'), context.dates, result.cells).every(day => day.AM >= 1));
  assert.equal(context.people.filter(p => p.group === 'old').length, 10);
  assert.equal(generate(context, { group: 'new' }).cells[locked], 'AM');
  t.diagnostic(JSON.stringify({ steps: result.steps, totals: result.totals }));
});

test('generator reports proven staffing impossibility separately from search budget exhaustion', async () => {
  const { seed, contextFor } = await model;
  const { generate } = await solver;
  const context = contextFor(seed(), 'Affiliate', '2026-12');
  assert.equal(generate(context, { budget: 1 }).status, 'timeout');
  context.draft.coverage['old|*|AM'] = 11;
  const result = generate(context);
  assert.equal(result.status, 'infeasible');
  assert.match(result.reason, /2026-12-01/);
});

test('validation catches month-boundary overnight rest, leave conflict, duplicates and invalid codes', async () => {
  const { seed, contextFor, key } = await model;
  const { interval, validate } = await solver;
  const context = contextFor(seed(), 'CSP', '2026-12'), id = 'SYN-019';
  context.previous[key(id, '2026-11-30')] = 'NIGHT';
  const [start, end] = interval('2026-11-30', context.catalog.find(s => s.id === 'NIGHT'));
  assert.equal(end - start, 9 * 60);
  context.draft.cells[key(id, '2026-12-01')] = 'DAY';
  context.draft.cells[key(id, '2026-12-02')] = ['DAY', 'MID'];
  context.draft.cells[key(id, '2026-12-03')] = 'INVALID';
  context.draft.cells[key('SYN-021', '2026-12-11')] = 'DAY';
  const { errors } = validate(context);
  for (const label of [/Insufficient rest.*2026-12-01/, /Duplicate assignments/, /Invalid shift/, /Confirmed leave conflict/]) {
    assert.ok(errors.some(error => label.test(error.label)));
  }
});

test('synthetic CSV round trips through the actual flat importer and neutralizes spreadsheet formulas', async () => {
  const { seed, contextFor, snapshot, key } = await model;
  const { rosterCsv } = await exportsModule;
  const context = contextFor(seed(), 'Affiliate', '2026-12');
  context.people[0].name = '=1+2, "sample"';
  context.draft.cells[key('SYN-001', '2026-12-01')] = 'AM';
  const js = fs.readFileSync('js/admin.js', 'utf8');
  const parsed = vm.runInNewContext(js.slice(js.indexOf('  const NON_WORKING_SHIFT_CODES'), js.indexOf('  const validateRosterTimesBeforeUpload')) +
    '\nparseScheduleCsv(csv)', { csv: rosterCsv(snapshot(context), 'old') });
  assert.equal(parsed.mode, 'flat');
  const first = parsed.rows[0];
  assert.equal(first.schedule_date, '2026-12-01');
  assert.equal(first.staff_id, 'SYN-001');
  assert.equal(first.login_id, 'SYNLOGIN001');
  assert.equal(first.full_name, "'=1+2, \"sample\"");
  assert.equal(first.start_time, '06:30');
  assert.equal(first.end_time, '15:30');
  assert.equal(first.status, 'WORKING');
  assert.match(first.notes, /SYNTHETIC/);
  assert.equal(parsed.rows[1].status, 'AL');
});

test('real Excel export reopens with styled sheets, dates, coverage, legend and frozen views', async () => {
  const { seed, contextFor, snapshot, key } = await model;
  const { workbookBytes } = await exportsModule;
  const context = contextFor(seed(), 'Affiliate', '2026-12');
  context.draft.cells[key('SYN-001', '2026-12-01')] = 'AM';
  const output = await workbookBytes(ExcelJS, snapshot(context));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(output);
  const combined = book.getWorksheet('Combined roster');
  assert.ok(book.getWorksheet('OLD Brands'));
  assert.ok(book.getWorksheet('NEW Brands'));
  assert.equal(combined.views[0].state, 'frozen');
  assert.equal(combined.getCell('D2').value.toISOString().slice(0, 10), '2026-12-01');
  assert.equal(combined.getCell('D3').value, 'Tue');
  assert.equal(combined.getCell('D4').fill.fgColor.argb, 'FF82D9EE');
  assert.equal(combined.getCell('D23').value, 1);
  assert.equal(book.getWorksheet('Legend').getCell('C3').value, '06:30');
});
