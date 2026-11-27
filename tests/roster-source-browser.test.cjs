const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { startPreview } = require('../scripts/roster-preview.cjs');
const { fixtureRows } = require('../scripts/roster-fixture.cjs');

const artifacts = process.env.ROSTER_ARTIFACTS;
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, channel: process.env.PORTAL_TEST_BROWSER || 'chrome' });
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
});
after(async () => { await browser?.close(); });

async function setup(t, options, width) {
  const server = await startPreview(0, '127.0.0.1', { fixture: true, ...options });
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  t.after(async () => { await context.close(); server.closeAllConnections(); server.close(); });
  const page = await context.newPage(), external = [], errors = [], reads = [];
  context.on('request', req => { if (req.url().includes('/roster-fixture/snapshot')) reads.push(req.url()); });
  page.on('pageerror', err => errors.push(err.message));
  await context.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  return { page, base, external, errors, reads };
}

test('desktop fixture source opens a separate editable draft and retains published leave on regeneration', async t => {
  const { page, base, external, errors, reads } = await setup(t, {}, 1360);
  await page.goto(base + 'admin-roster-source.html');
  await page.getByText(/Last refreshed/).waitFor();
  assert.equal(reads.length, 1);
  assert.match(await page.locator('#source-schedule').textContent(), /GY15:00:0002:00:00/);
  assert.match(await page.locator('#source-staff').textContent(), /Joined after month start/);
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-source-desktop.png') });
  await page.getByRole('button', { name: 'Open Published Copy' }).click();
  await page.getByText('Fixture source / Publishing disabled', { exact: false }).waitFor();
  const leave = page.locator('[data-key="TEST-A-2|2026-12-06"]');
  assert.equal(await leave.textContent(), 'AL');
  assert.match(await leave.getAttribute('title'), /Published leave assignment/);
  assert.equal(await page.locator('[data-key^="SYN-"]').count(), 0);
  await page.locator('[data-key="TEST-A-4|2026-12-09"]').click();
  await page.selectOption('#assignment', 'SL');
  await page.click('#apply');
  await page.click('#generate');
  await page.getByRole('heading', { name: 'Review generated candidates' }).waitFor();
  await page.getByRole('button', { name: 'Apply candidate', exact: true }).click();
  assert.equal(await leave.textContent(), 'AL');
  assert.equal(await page.locator('[data-key="TEST-A-4|2026-12-09"]').textContent(), 'SL');
  await page.click('#save');
  const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
  assert.equal(Object.keys(stored).filter(k => k.startsWith('spv2.roster.fixture-draft')).length, 1);
  assert.doesNotMatch(JSON.stringify(stored), /Roster Fixture|FIXTURE[1-8]|spv2.syntheticRoster/);
  assert.equal(reads.length, 1);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
});

test('mobile fixture CSP denies Affiliate, retries failed reads and reports stale draft without overwriting it', async t => {
  let unavailable = false, revision = 'one';
  const { page, base, errors, external } = await setup(t, { role: 'CSP_ADMIN',
    readSource: (team, month) => {
      if (unavailable) throw new Error('fixture outage');
      return { ...fixtureRows(team, month), revision };
    } }, 390);
  await page.goto(base + 'admin-roster-source.html');
  await page.getByText(/Access denied/).waitFor();
  assert.equal(await page.locator('#source-review').isVisible(), false);
  await page.selectOption('#source-team', 'CSP');
  await page.getByText(/Last refreshed/).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator('#source-team option[value="Affiliate"]').evaluate(option => option.disabled), true);
  if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-source-mobile.png') });
  await page.getByRole('button', { name: 'Open New Draft' }).click();
  await page.getByText(/Fixture source/).waitFor();
  await page.click('#save');
  unavailable = true;
  await page.getByRole('link', { name: 'Review source' }).click();
  await page.getByText(/source unavailable/).waitFor();
  unavailable = false; revision = 'two';
  await page.getByRole('button', { name: 'Refresh Data' }).click();
  await page.getByText(/Source changed since this local draft/).waitFor();
  await page.getByRole('button', { name: 'Open Published Copy' }).click();
  await page.getByRole('heading', { name: 'Compare Local Draft' }).waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('spv2.roster.fixture-draft')))));
  assert.equal(saved.revision, 'one');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
