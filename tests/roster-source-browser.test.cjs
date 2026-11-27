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

test('fixture browser generates, reviews, acknowledges and verifies a simulated monthly publish', async t => {
  const { page, base, external, errors } = await setup(t, { publishing: true }, 1280);
  await page.goto(base + 'admin-roster-source.html?publish=fixture');
  await page.getByRole('button', { name: 'Open Published Copy' }).click();
  await page.click('#generate');
  await page.getByRole('button', { name: 'Apply candidate', exact: true }).click();
  await page.click('#preview');
  await page.click('#confirm');
  await page.getByRole('button', { name: 'Review simulated publish' }).click();
  await page.getByText(/\d+ new \/ \d+ updated \/ \d+ unchanged \/ 0 conflicting/).waitFor();
  const confirm = page.getByRole('button', { name: 'Publish Final Schedule' });
  assert.equal(await confirm.isDisabled(), true);
  await page.getByLabel('I verified the leave requests').check();
  await confirm.click();
  await page.getByText('Simulated schedule write verified.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('link', { name: 'Review source' }).click();
  await page.getByText(/Last refreshed/).waitFor();
  assert.ok(await page.locator('#source-schedule tbody tr').count() > 8);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
});

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

for (const partial of [false, true]) {
  test('fixture staffing recovery: ' + (partial ? 'one tested allocation improves but does not unblock confirmation' :
    'coordinated allocation fully resolves coverage with approval and undo'), async t => {
    const { page, base, errors, external } = await setup(t, {}, partial ? 390 : 1360);
    await page.goto(base + 'admin-roster-source.html');
    await page.getByRole('button', { name: 'Open Published Copy' }).click();
    await page.getByText(/Fixture source/).waitFor();
    await page.evaluate(async () => {
      const { fixtureHandoffKey } = await import('./js/roster-source.js');
      const { draftFor } = await import('./js/roster-model.js');
      const handoff = JSON.parse(sessionStorage.getItem(fixtureHandoffKey));
      draftFor(handoff.model, handoff.team, handoff.month).coverage['old|*|PM'] = 1;
      sessionStorage.setItem(fixtureHandoffKey, JSON.stringify(handoff));
    });
    await page.reload();
    await page.locator('#period').getByText('December 2026', { exact: true }).waitFor();
    const dialog = page.locator('#dialog'), initial = await page.locator('#summary').textContent();
    const cell = (id, date) => page.locator('[data-key="' + id + '|' + date + '"]');
    await page.click('#generate');
    await dialog.getByRole('heading', { name: 'Staffing check before generation' }).waitFor();
    await dialog.getByText(/5 unassigned staff/).waitFor();
    await dialog.getByRole('cell', { name: 'OLD Brands', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Generate Baseline & Review' }).click();
    await dialog.getByRole('button', { name: 'Review monthly candidates' }).click();
    assert.equal(await dialog.getByRole('button', { name: 'Test Staff Allocation' }).isDisabled(), true);
    assert.doesNotMatch(await dialog.textContent(), /Lowers the required staffing/);
    if (partial) {
      await dialog.getByRole('button', { name: 'Open Provisional in Editor' }).click();
      assert.notEqual(await cell('TEST-A-1', '2026-12-02').textContent(), '-');
      await cell('TEST-A-4', '2026-12-09').click();
      assert.equal(await page.locator('#apply').isEnabled(), true);
      await page.selectOption('#assignment', 'OFF');
      await page.click('#apply');
      assert.equal(await cell('TEST-A-4', '2026-12-09').textContent(), 'OFF');
      await page.click('#undo');
      await page.click('#undo-recovery');
      assert.equal(await page.locator('#summary').textContent(), initial);
      await page.click('#generate');
      await dialog.getByRole('button', { name: 'Generate Baseline & Review' }).click();
      await dialog.getByRole('button', { name: 'Review monthly candidates' }).click();
      await dialog.getByLabel('Roster Fixture 1 (TEST-A-1)', { exact: true }).selectOption('old');
    } else await dialog.getByRole('button', { name: 'Suggest Coordinated Allocation' }).click();
    await dialog.getByRole('button', { name: 'Test Staff Allocation' }).click();
    await dialog.getByText(partial ? /31 before \/ 11 after.*Validated partial/ : /31 before \/ 0 after.*Full resolution/).waitFor();
    assert.equal(await page.locator('#summary').textContent(), initial);
    await dialog.getByRole('button', { name: partial ? 'Apply Partial Improvement' : 'Apply Changes & Regenerate' }).click();
    await dialog.getByRole('heading', { name: partial ? 'Partial improvement applied' : 'Staff allocation applied' }).waitFor();
    assert.equal(await cell('TEST-A-2', '2026-12-06').textContent(), 'AL');
    await dialog.getByRole('button', { name: 'Continue Editing' }).click();
    await page.selectOption('#group', 'old');
    assert.equal(await page.locator('[data-person]').count(), partial ? 1 : 5);
    await page.selectOption('#group', '');
    if (partial) {
      assert.equal(await page.locator('#preview').isDisabled(), true);
      assert.equal(await page.locator('#confirm').isVisible(), false);
    } else {
      await page.click('#preview');
      await page.click('#confirm');
      await dialog.getByLabel('I acknowledge the reminder').check();
      assert.equal(await dialog.getByRole('button', { name: 'Save simulated snapshot' }).isEnabled(), true);
      await dialog.getByRole('button', { name: 'Close dialog' }).click();
      await page.click('#preview');
    }
    await page.click('#undo-recovery');
    assert.equal(await page.locator('#summary').textContent(), initial);
    await page.selectOption('#group', 'old');
    assert.equal(await page.locator('[data-person]').count(), 0);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  });
}
