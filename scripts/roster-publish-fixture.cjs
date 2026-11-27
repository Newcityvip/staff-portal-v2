const { createHash } = require('node:crypto');

function publishFixture(readSource, fault = '') {
  const records = new Map(), operations = new Map();
  let attempts = 0;
  const scope = (team, month) => team + '|' + month;
  const id = row => (row.staff_id || row.id) + '|' + (row.schedule_date || row.date);
  const view = row => row && [row.shift_code || row.code, row.start_time ?? row.start, row.end_time ?? row.end, row.status];
  const equal = (a, b) => JSON.stringify(view(a)) === JSON.stringify(view(b));
  async function read(team, month) {
    const source = await readSource(team, month);
    const changes = records.get(scope(team, month));
    if (!changes) return source;
    const schedule = source.schedule.filter(row => !changes.has(id(row))).concat([...changes.values()]);
    return { ...source, schedule, revision: createHash('sha256').update(JSON.stringify(schedule)).digest('hex') };
  }
  const service = import('../backend/roster-publish.mjs').then(({ createRosterPublisher, fixturePublishConfiguration }) =>
    createRosterPublisher({
      readSource: async (team, month) => ({ ...await read(team, month), ok: true, team, month, teams: [team], principal: 'fixture' }),
      readConfiguration: fixturePublishConfiguration,
      windowVerified: () => fault !== 'closed',
      journal: {
        get: operation => operations.get(operation),
        put: operation => operations.set(operation.id, operation),
        unresolved: () => [...operations.values()].some(operation => ['pending', 'uncertain', 'rollback-pending'].includes(operation.state))
      },
      async commitBatch(changes, team, month) {
        attempts++;
        const next = new Map(records.get(scope(team, month)));
        for (const { after } of changes) next.set(id(after), after);
        if (fault === 'interrupt-before') throw Error('Simulated interruption before batch');
        records.set(scope(team, month), next);
        if (fault === 'interrupt-after') throw Error('Simulated interruption after batch');
        if (fault === 'mismatch') {
          const row = changes[0].after;
          next.set(id(row), { ...row, status: 'SIMULATED_MISMATCH' });
        }
      },
      async rollbackBatch(changes, team, month) {
        const next = new Map(records.get(scope(team, month)));
        const original = (await readSource(team, month)).schedule;
        for (const { before, after } of changes) {
          const k = id(after);
          if (!before || equal(before, original.find(row => id(row) === k))) next.delete(k);
          else next.set(k, { ...after, shift_code: before.code, start_time: before.start, end_time: before.end, status: before.status });
        }
        records.set(scope(team, month), next);
      },
      async reconcileBatch(changes, team, month) {
        const latest = (await read(team, month)).schedule;
        const rows = changes.map(change => latest.find(row => id(row) === id(change.after)));
        if (changes.every((change, i) => equal(rows[i], change.after))) return 'verified';
        if (changes.every((change, i) => !rows[i] && !change.before || equal(rows[i], change.before))) return 'not-written';
        return 'uncertain';
      }
    }));
  return { read, async request(actor, body) { return (await service)(actor, body); }, get attempts() { return attempts; } };
}
module.exports = { publishFixture };
