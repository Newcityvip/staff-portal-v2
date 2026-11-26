const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(bodyStalls) {
  const timers = [];
  let requests = 0;
  const context = vm.createContext({
    console, AbortController, location: { pathname: '/staff.html' },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    setInterval: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      if (ms === 700) queueMicrotask(fn);
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
    fetch: async (_url, options) => {
      requests++;
      return { ok: true, status: 200, text: () => bodyStalls
        ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
          const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
        }))
        : Promise.resolve(JSON.stringify({ ok: true, staff: {}, attendance_state: {}, today_schedule: null, monthly_schedule: [] })) };
    }
  });
  context.window = context;
  vm.runInContext(fs.readFileSync('js/app.js', 'utf8'), context);
  context.Portal.getSession = () => null;
  context.Portal.api.detectIp = async () => '192.0.2.1';
  return { api: context.Portal.api, timers, requests: () => requests };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
test('dashboard deadline covers stalled body after successful headers, with only one read retry', async () => {
  const h = harness(true);
  const result = h.api.dashboard('staff').then(() => 'resolved', error => error.name);
  for (let i = 0; i < 2; i++) {
    await flush();
    const deadline = h.timers.find(t => t.ms === 15000 && !t.cleared && !t.fired);
    assert.ok(deadline, 'dashboard deadline must stay active until body completes');
    deadline.fired = true;
    deadline.fn();
  }
  assert.equal(await result, 'AbortError');
  assert.equal(h.requests(), 2);
  assert.equal(h.timers.filter(t => t.ms === 15000).every(t => t.cleared), true);
});
test('successful dashboard consumes body and clears its deadline', async () => {
  const h = harness(false);
  assert.equal((await h.api.dashboard('staff')).ok, true);
  assert.equal(h.requests(), 1);
  assert.equal(h.timers.find(t => t.ms === 15000).cleared, true);
});
test('attendance response body timeout remains single-shot, without a mutation retry', async () => {
  const h = harness(true);
  const result = h.api.action('attendance_action').then(() => 'resolved', error => error.name);
  await flush();
  assert.equal(h.requests(), 1);
  const deadline = h.timers.find(t => t.ms === 20000);
  assert.equal(deadline.cleared, false);
  deadline.fn();
  assert.equal(await result, 'AbortError');
  assert.equal(h.requests(), 1);
  assert.equal(h.timers.find(t => t.ms === 20000).cleared, true);
});
