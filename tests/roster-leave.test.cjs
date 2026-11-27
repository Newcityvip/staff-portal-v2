const test = require('node:test');
const assert = require('node:assert/strict');
const Excel = require('../vendor/exceljs-4.4.0/dist/exceljs.min.js');
const m = import('../js/roster-model.js');
const g = import('../js/roster-generator.js');
const x = import('../js/roster-export.js');
const b = import('../js/roster-diagnostic-bundle.js');
const team = 'Affiliate', month = '2026-12', cameron = 'SYN-003', cameronDate = '2026-12-09';
const k = cameron + '|' + cameronDate, at = '2026-11-27T09:00:00.000Z';
const options = { group: 'old', strategy: 'balanced' };

test('fixture origin is approved, not a manual lock; manual AL, SL and UL survive normal regeneration', async () => {
  const { seed, contextFor, assignCell, assignmentSource, isManualLock, assignmentsFromGeneration } = await m;
  const { generateCandidates } = await g;
  const ctx = contextFor(seed(), team, month);
  assert.equal(ctx.draft.cells[k], 'AL');
  assert.equal(assignmentSource(ctx, k), 'approved');
  assert.equal(isManualLock(ctx, cameron, cameronDate), false);
  for (const [i, code] of ['AL', 'SL', 'UL'].entries()) assignCell(ctx.draft, 'SYN-00' + (i + 4) + '|2026-12-10', code);
  const result = generateCandidates(ctx, options);
  assert.equal(result.status, 'feasible');
  const generated = result.candidates[0].cells;
  assert.equal(generated[k], 'AL');
  for (const [i, code] of ['AL', 'SL', 'UL'].entries()) {
    const cell = 'SYN-00' + (i + 4) + '|2026-12-10';
    assert.equal(generated[cell], code);
    assert.equal(assignmentSource(ctx, cell), 'manual-leave');
  }
  assignmentsFromGeneration(ctx.draft, generated);
  assert.equal(assignmentSource(ctx, 'SYN-004|2026-12-01'), 'generated');
  assignCell(ctx.draft, 'SYN-004|2026-12-10', 'PM1');
  assert.equal(assignmentSource(ctx, 'SYN-004|2026-12-10'), 'manual');
  assignCell(ctx.draft, 'SYN-004|2026-12-10', '');
  assert.equal(ctx.draft.cells['SYN-004|2026-12-10'], undefined);
});

test('approved leave override to AM, OFF and SL respects locks and regeneration and creates an audit entry', async () => {
  const { seed, contextFor, overrideApprovedLeave, assignmentSource } = await m;
  const { generateCandidates, validate } = await g;
  for (const replace of ['AM', 'OFF', 'SL']) {
    const model = seed(), ctx = contextFor(model, team, month);
    assert.equal(overrideApprovedLeave(ctx, ctx.draft, [[k, replace]], '   ', at), false);
    ctx.draft.locks[k] = true;
    assert.equal(overrideApprovedLeave(ctx, ctx.draft, [[k, replace]], 'Reviewed', at), false);
    delete ctx.draft.locks[k];
    assert.equal(overrideApprovedLeave(ctx, ctx.draft, [[k, replace]], ' Reviewed ', at), true);
    const edited = contextFor(model, team, month);
    assert.equal(model.leave[k], 'AL');
    assert.equal(edited.leave[k], undefined);
    assert.equal(assignmentSource(edited, k), 'overridden');
    const result = generateCandidates(edited, options);
    assert.equal(result.status, 'feasible');
    const plan = result.candidates[0];
    assert.equal(plan.cells[k], replace);
    assert.equal(validate(edited, plan.cells, { groups: ['old'], people: new Set(plan.scopePeople) }).errors.length, 0);
    assert.deepEqual(ctx.draft.leaveAudit, [{ k, original: 'AL', previous: 'AL', replacement: replace, reason: 'Reviewed', at }]);
  }
});

test('generated, unlocked and all clear are scoped; approved leave removal needs an audited override and stays blank', async () => {
  const { seed, contextFor, clearRosterAssignments, assignCell, draftFor, heldBlank } = await m;
  const { generateCandidates } = await g;
  const model = seed(), ctx = contextFor(model, team, month);
  const generated = 'SYN-003|2026-12-10', manualLeave = 'SYN-003|2026-12-11', manualWork = 'SYN-003|2026-12-12',
    locked = 'SYN-003|2026-12-13', other = 'SYN-015|2026-12-17';
  assignCell(ctx.draft, generated, 'AM', 'generated'); assignCell(ctx.draft, manualLeave, 'UL');
  assignCell(ctx.draft, manualWork, 'AM'); assignCell(ctx.draft, locked, 'AM', 'generated'); ctx.draft.locks[locked] = true;
  const outside = draftFor(model, 'CSP', month), next = draftFor(model, team, '2027-01');
  assignCell(next, 'SYN-003|2027-01-01', 'PM');
  assert.equal(clearRosterAssignments(ctx, ctx.draft, [cameron], 'generated'), true);
  assert.equal(ctx.draft.cells[generated], undefined);
  assert.equal(ctx.draft.cells[manualWork], 'AM');
  clearRosterAssignments(ctx, ctx.draft, [cameron], 'unlocked');
  assert.equal(ctx.draft.cells[manualWork], undefined);
  assert.equal(ctx.draft.cells[manualLeave], 'UL');
  assert.equal(ctx.draft.cells[k], 'AL');
  assert.equal(ctx.draft.cells[locked], 'AM');
  assert.equal(clearRosterAssignments(ctx, ctx.draft, [cameron], 'all'), false);
  assert.ok(ctx.draft.locks[locked]);
  ctx.draft.staffLocks[cameron] = true;
  assert.equal(clearRosterAssignments(ctx, ctx.draft, [cameron], 'all', 'Clear selected staff', at), true);
  assert.equal(ctx.draft.cells[manualLeave], undefined);
  assert.equal(ctx.draft.cells[locked], undefined);
  assert.equal(ctx.draft.staffLocks[cameron], undefined);
  assert.equal(ctx.draft.cells[other], 'SL');
  assert.equal(outside.cells['SYN-021|2026-12-11'], 'UL');
  assert.equal(next.cells['SYN-003|2027-01-01'], 'PM');
  const changed = contextFor(model, team, month);
  assert.ok(heldBlank(changed, k));
  const result = generateCandidates(changed, options);
  assert.notEqual(result.status, 'feasible');
  assert.equal(result.candidates[0].cells[k] || '', '');
  assert.equal(result.candidates[0].metrics.assigned, 309);
});

test('scoped reset plus history preserve audit, overrides, locks, settings and other staff', async () => {
  const { seed, contextFor, createHistory, draftFor, overrideApprovedLeave, resetRosterScope } = await m;
  const base = seed(), initial = structuredClone(contextFor(base, team, month).draft);
  const history = createHistory(base);
  history.change(model => {
    const ctx = contextFor(model, team, month);
    overrideApprovedLeave(ctx, ctx.draft, [[k, 'AM']], 'Scoped change', at);
    ctx.draft.locks[k] = true;
    ctx.draft.coverage['old|*|AM'] = 2;
    ctx.draft.coverage['new|*|PM'] = 1;
  });
  const current = () => draftFor(history.current, team, month);
  history.undo(); assert.equal(current().cells[k], 'AL'); assert.equal(current().leaveAudit.length, 0);
  history.redo(); assert.equal(current().cells[k], 'AM'); assert.equal(current().leaveAudit.length, 1);
  history.change(model => resetRosterScope(draftFor(model, team, month), initial, [cameron], contextFor(model, team, month).dates, { group: 'old' }));
  assert.equal(current().cells[k], 'AL');
  assert.equal(current().leaveAudit.length, 0);
  assert.equal(current().locks[k], undefined);
  assert.equal(current().coverage['old|*|AM'], undefined);
  assert.equal(current().coverage['new|*|PM'], 1);
  history.undo(); assert.equal(current().leaveAudit[0].replacement, 'AM'); assert.equal(current().coverage['old|*|AM'], 2);
  history.redo(); assert.equal(current().cells[k], 'AL');
});

test('legacy assignment sources are not guessed; save, workbook and audit CSV retain overrides and anonymized replay omits reasons', async () => {
  const { seed, contextFor, restore, save, snapshot, storageKey, assignmentSource, overrideApprovedLeave } = await m;
  const { rosterCsv, leaveAuditCsv, workbookBytes } = await x;
  const { createDiagnosticBundle, readDiagnosticBundle } = await b;
  const model = seed(), original = contextFor(model, team, month);
  const legacy = 'SYN-001|2026-12-03';
  original.draft.cells[legacy] = 'PM';
  delete original.draft.sources; delete original.draft.leaveOverrides; delete original.draft.leaveAudit;
  const storage = new Map([[storageKey, JSON.stringify({ schema: 2, model, team, month })]]);
  const api = { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) };
  const loaded = restore(api), ctx = contextFor(loaded.model, team, month);
  assert.equal(assignmentSource(ctx, legacy), 'legacy');
  overrideApprovedLeave(ctx, ctx.draft, [[k, 'PM']], '=Private audit, reviewed', at);
  save(api, loaded.model, team, month);
  const restored = contextFor(restore(api).model, team, month), record = snapshot(restored);
  assert.equal(assignmentSource(restored, k), 'overridden');
  assert.match(rosterCsv(record, 'old'), /2026-12-09","SYN-003".*"PM".*"WORKING".*APPROVED LEAVE OVERRIDE/);
  assert.match(leaveAuditCsv(record, 'old'), /"AL","AL","PM","'=Private audit, reviewed"/);
  assert.doesNotMatch(leaveAuditCsv(record, 'new'), /Private audit|Cameron/);
  const book = new Excel.Workbook();
  await book.xlsx.load(await workbookBytes(Excel, record, 'old'));
  assert.deepEqual(book.getWorksheet('Leave audit').getRow(3).values.slice(3, 8),
    ['2026-12-09', 'AL', 'AL', 'PM', '=Private audit, reviewed']);
  const json = createDiagnosticBundle(restored, options);
  assert.doesNotMatch(json, /Private audit|Cameron/);
  const replay = readDiagnosticBundle(json);
  assert.equal(replay.context.draft.leaveOverrides['Staff-03|2026-12-09'].replacement, 'PM');
});
