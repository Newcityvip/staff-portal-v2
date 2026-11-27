const { randomUUID, createHash } = require('node:crypto');
const cookieName = 'spv2_roster_fixture';
const boundary = Symbol('fixture gateway');

function fixtureRows(team, month) {
  const { dates, catalog } = team === 'Affiliate' ? {
    dates: ['03', '06', '10', '14'], catalog: [['AM', '06:30:00', '15:30:00'], ['AM1', '09:30:00', '18:30:00'],
      ['PM', '14:30:00', '23:30:00'], ['GY', '15:00:00', '02:00:00']]
  } : { dates: ['03', '06', '10', '14'], catalog: [['DAY', '07:00:00', '16:00:00'], ['NIGHT', '22:00:00', '07:00:00']] };
  const staff = Array.from({ length: 8 }, (_, i) => ({
    staff_id: (team === 'Affiliate' ? 'TEST-A-' : 'TEST-C-') + (i + 1), full_name: 'Roster Fixture ' + (i + 1),
    login_id: 'FIXTURE' + (i + 1), team, status: i === 6 ? 'INACTIVE' : 'ACTIVE',
    joining_date: i === 7 ? month + '-15' : '2024-01-01'
  }));
  const codes = [...catalog, ...['OFF', 'AL', 'SL', 'UL'].map(code => [code, '', ''])];
  const shifts = codes.map(([shift_code, start_time, end_time]) => ({ shift_code, start_time, end_time, team, active: 'YES' }));
  const [year, n] = month.split('-').map(Number);
  const prior = new Date(Date.UTC(year, n - 2, 1)).toISOString().slice(0, 7);
  const last = new Date(Date.UTC(year, n - 1, 0)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(year, n, 1)).toISOString().slice(0, 7);
  const schedule = [
    [0, prior, last, 'OFF'], [0, month, month + '-01', 'OFF'],
    [0, month, month + '-03', catalog.at(-1)[0]],
    ...['AL', 'SL', 'UL'].map((code, i) => [i + 1, month, month + '-' + dates[i + 1], code]),
    [6, month, month + '-01', catalog[0][0]], [0, next, next + '-01', catalog.at(-1)[0]]
  ].map(([i, period, schedule_date, shift_code]) => {
    const [, start_time, end_time] = codes.find(c => c[0] === shift_code);
    return { staff_id: staff[i].staff_id, team, schedule_month: period, schedule_date, shift_code, start_time, end_time,
      status: start_time ? 'WORKING' : 'OFF' };
  });
  return { staff, shifts, schedule, excludedStaffIds: [staff[5].staff_id],
    timeZone: team === 'Affiliate' ? 'Asia/Colombo' : 'Asia/Manila',
    revision: createHash('sha256').update(JSON.stringify([staff, shifts, schedule])).digest('hex').slice(0, 16) };
}

function fixtureHandler({ role = 'SUPER_ADMIN', now = Date.now, readSource = fixtureRows, publishing = false, fault = '' } = {}) {
  const publish = publishing ? require('./roster-publish-fixture.cjs').publishFixture(readSource, fault) : null;
  const sessions = new Map();
  const sessionFor = req => {
    const token = (req.headers.cookie || '').split(/;\s*/).find(entry => entry.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return sessions.get(token);
  };
  const contract = import('../backend/roster-read-contract.mjs').then(({ rosterReadContract, rosterSessionMaxAge }) => ({
    ttl: rosterSessionMaxAge,
    read: rosterReadContract({
      verifyGateway: request => request[boundary] === true,
      resolveSession: key => sessions.get(key),
      resolveAdmin: subject => subject === 'fixture-user' ? { role, active: true, draftNamespace: 'preview-' + role.toLowerCase() } : null,
      allowedIp: ip => ip === '127.0.0.1',
      readSource: publish ? publish.read : readSource, now
    })
  }));
  return {
    async issue(req, res) {
      if (req.socket.remoteAddress !== '127.0.0.1') return;
      const { ttl } = await contract, current = now();
      for (const [id, session] of sessions) if (session.expiresAt <= current) sessions.delete(id);
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
      const id = randomUUID();
      sessions.set(id, { subject: 'fixture-user', audience: 'roster-read', issuedAt: current, expiresAt: current + ttl, ip: req.socket.remoteAddress });
      res.setHeader('Set-Cookie', cookieName + '=' + id + '; Path=/; SameSite=Strict; HttpOnly; Max-Age=' + ttl / 1000);
    },
    async read(req, res, url) {
      const { read } = await contract;
      const sessionId = (req.headers.cookie || '').split(/;\s*/).find(entry => entry.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const result = await read({ method: req.method, operation: 'roster_snapshot', gatewayIp: req.socket.remoteAddress,
        sessionId, team: url.searchParams.get('team'), month: url.searchParams.get('month'), [boundary]: req.socket.remoteAddress === '127.0.0.1' });
      res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(result.body));
    },
    async publish(req, res) {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(body));
      };
      if (!publish) return send(404, { ok: false, message: 'Fixture publishing is disabled.' });
      const session = sessionFor(req);
      if (req.method !== 'POST' || req.socket.remoteAddress !== '127.0.0.1' ||
        req.headers.origin !== 'http://' + req.headers.host ||
        !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') ||
        !session || session.expiresAt <= now()) return send(403, { ok: false, message: 'Fixture session or request not authorized.' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 524288) return send(413, { ok: false, message: 'Roster is too large.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks)); } catch { return send(400, { ok: false, message: 'Invalid roster payload.' }); }
      const result = await publish.request({ active: true, role, id: 'fixture-' + role }, body);
      return send(result.status, result.body);
    }
  };
}
module.exports = { fixtureRows, fixtureHandler };
