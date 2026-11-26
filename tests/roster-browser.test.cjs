const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { startPreview } = require('../scripts/roster-preview.cjs');
let browser, server, base;
const artifacts = process.env.ROSTER_ARTIFACTS;

before(async () => {
  server = await startPreview(0);
  base = 'http://127.0.0.1:' + server.address().port + '/staff-portal-v2/';
  browser = await chromium.launch({ headless: true, channel: process.env.PORTAL_TEST_BROWSER || 'chrome' });
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); });

async function open(width, height = 850) {
  const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await context.newPage(), external = [], errors = [], requests = [];
  context.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(base + 'admin-roster.html');
  await page.locator('#period').getByText('December 2026', { exact: true }).waitFor();
  return { context, page, external, errors, requests };
}
const cell = (page, id, date) => page.locator('[data-key="' + id + '|' + date + '"]');
const applyGenerated = async page => {
  await page.click('#generate');
  await page.getByRole('heading', { name: 'Review generated candidates' }).waitFor();
  await page.getByRole('button', { name: 'Apply candidate' }).click();
};

test('desktop editing, bulk selection, copy/paste, undo/redo, locks and draft restore', async () => {
  const { context, page, external, errors } = await open(1390);
  try {
    assert.equal(await page.locator('[data-person]').count(), 18);
    assert.equal(await page.locator('#matrix thead th').count(), 33);
    const a = cell(page, 'SYN-001', '2026-12-01'), b = cell(page, 'SYN-001', '2026-12-02');
    const c = cell(page, 'SYN-002', '2026-12-01'), leave = cell(page, 'SYN-003', '2026-12-09');
    await a.click();
    await b.click({ modifiers: ['Shift'] });
    await page.selectOption('#assignment', 'AM');
    await page.click('#apply');
    assert.equal(await a.textContent(), 'AM');
    assert.equal(await b.textContent(), 'AM');
    await page.click('#copy');
    await c.click();
    await page.click('#paste');
    assert.equal(await c.textContent(), 'AM');
    await page.click('#undo');
    assert.equal(await c.textContent(), '-');
    await page.click('#redo');
    assert.equal(await c.textContent(), 'AM');
    await page.click('#clear');
    assert.equal(await c.textContent(), '-');
    await leave.click();
    await page.click('#apply');
    assert.equal(await leave.textContent(), 'AL');
    await page.click('#save');
    await page.reload();
    assert.equal(await a.textContent(), 'AM');
    await page.locator('#month').fill('2028-02');
    await page.locator('#month').dispatchEvent('change');
    assert.equal(await page.locator('#matrix thead th').count(), 31);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('worker generation, preview confirmation, downloads and desktop/mobile screenshots stay local', async () => {
  const f = await open(1440, 1000);
  try {
    const { page } = f;
    assert.ok(!f.requests.some(url => url.includes('exceljs')));
    await applyGenerated(page);
    await page.getByRole('status').getByText(/Generated 18 staff/).waitFor();
    assert.match(await page.locator('#validation-title').textContent(), /0 blocking/);
    assert.equal(await cell(page, 'SYN-003', '2026-12-09').textContent(), 'AL');
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-desktop.png'), fullPage: true });
    await page.click('#preview');
    assert.equal(await page.locator('button.cell').count(), 0);
    await page.click('#confirm');
    await page.getByText(/Production publishing is unavailable/).waitFor();
    await page.getByText(/Please check the Future_Leave_Requests tab/).waitFor();
    const accept = page.getByRole('button', { name: 'Save simulated snapshot' });
    assert.equal(await accept.isDisabled(), true);
    await page.getByLabel('I acknowledge the reminder').check();
    await accept.click();
    await page.selectOption('#source', '0');
    for (const format of ['csv', 'xlsx']) {
      const pending = page.waitForEvent('download');
      await page.click('#' + format);
      const download = await pending;
      assert.match(download.suggestedFilename(), /^SYNTHETIC-Affiliate-2026-12-r\d+\./);
      if (artifacts) await download.saveAs(path.join(artifacts, download.suggestedFilename()));
    }
    assert.ok(f.requests.some(url => url.includes('exceljs.min.js')));
    assert.deepEqual(f.external, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
  const mobile = await open(390);
  try {
    const { page } = mobile;
    await page.selectOption('#team', 'CSP');
    await applyGenerated(page);
    await page.getByRole('status').getByText(/Generated 6 staff/).waitFor();
    assert.match(await page.locator('#legend').textContent(), /22:00 - 07:00 \(\+1\)/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const sticky = await page.locator('#scroll').evaluate(scroll => {
      const name = scroll.querySelector('thead .name');
      const before = name.getBoundingClientRect().left;
      scroll.scrollLeft = 400;
      const after = name.getBoundingClientRect().left;
      return { moved: scroll.scrollLeft > 0, pinned: Math.abs(before - after) < 2 };
    });
    assert.deepEqual(sticky, { moved: true, pinned: true });
    await page.locator('#scroll').evaluate(scroll => { scroll.scrollLeft = 0; });
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-mobile.png'), fullPage: true });
    assert.deepEqual(mobile.external, []);
    assert.deepEqual(mobile.errors, []);
  } finally { await mobile.context.close(); }
});

test('candidate comparison and cancellation do not change the draft; required leave acknowledgment resets after editing', async () => {
  const { context, page, external, errors } = await open(1200);
  try {
    const first = cell(page, 'SYN-001', '2026-12-01');
    await page.evaluate(() => {
      document.getElementById('generate').click();
      document.getElementById('cancel-generation').click();
    });
    assert.match(await page.locator('#notice').textContent(), /cancelled/);
    assert.equal(await first.textContent(), '-');
    await page.click('#generate');
    const dialog = page.locator('#dialog');
    await dialog.getByRole('heading', { name: 'Review generated candidates' }).waitFor();
    assert.equal(await first.textContent(), '-');
    assert.ok(await dialog.getByLabel('Preview').locator('option').count() > 1);
    await dialog.getByLabel('Preview').selectOption('1');
    await page.getByRole('button', { name: 'Apply candidate' }).click();
    await page.click('#preview');
    await page.click('#confirm');
    await page.getByLabel('I acknowledge the reminder').check();
    await page.keyboard.press('Escape');
    await page.click('#preview');
    await first.click();
    await page.click('#lock');
    await page.click('#preview');
    await page.click('#confirm');
    assert.equal(await page.getByLabel('I acknowledge the reminder').isChecked(), false);
    assert.equal(await page.getByRole('button', { name: 'Save simulated snapshot' }).isDisabled(), true);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('coverage matrix validates independent configurations and jumps to an under-covered shift', async () => {
  const { context, page } = await open(390);
  try {
    await page.click('#coverage');
    const dialog = page.locator('#dialog');
    await dialog.getByLabel('Rule period').selectOption('2026-12-01');
    await dialog.getByLabel('AM minimum', { exact: true }).fill('2');
    await dialog.getByRole('button', { name: 'Save coverage' }).click();
    await dialog.getByText(/require minimum/).waitFor();
    await dialog.getByLabel('AM target', { exact: true }).fill('3');
    await dialog.getByLabel('AM maximum', { exact: true }).fill('4');
    await dialog.getByLabel('AM priority', { exact: true }).selectOption('3');
    await dialog.getByRole('button', { name: 'Save coverage' }).click();
    await dialog.getByText('Coverage saved.').waitFor();
    await page.keyboard.press('Escape');
    await page.click('#validation-title');
    await page.getByRole('button', { name: /OLD Brands 2026-12-01 AM: 0\/2 minimum/ }).click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.coverage), 'old|2026-12-01|AM');
    assert.equal(await page.locator('[data-coverage="old|2026-12-01|AM"]').getAttribute('data-shortfall'), 'true');
    assert.equal(await page.locator('[data-coverage="new|2026-12-01|AM"]').getAttribute('data-shortfall'), 'false');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await context.close(); }
});

test('weekly demand panel saves scoped weekday and date limits and shows capacity on mobile', async () => {
  const { context, page, errors, external } = await open(390);
  try {
    await page.click('#demand');
    const dialog = page.locator('#dialog');
    await dialog.getByRole('heading', { name: 'Weekly Demand & OFF Planning' }).waitFor();
    await dialog.getByLabel('Fri workload').selectOption('Very Busy');
    await dialog.getByLabel('Fri OFF maximum').fill('1');
    await dialog.getByLabel('Fri OFF preferred').fill('2');
    await dialog.getByRole('button', { name: 'Save demand' }).click();
    await dialog.getByText(/do not set preferred OFF above/).waitFor();
    await dialog.getByLabel('Fri OFF preferred').fill('1');
    await dialog.getByRole('button', { name: 'Save demand' }).click();
    await dialog.getByText('Demand saved.').waitFor();
    await dialog.getByLabel('Rule period').selectOption('2026-12-04');
    assert.equal(await dialog.getByLabel('2026-12-04 OFF maximum').inputValue(), '1');
    await dialog.getByLabel('2026-12-04 OFF maximum').fill('0');
    await dialog.getByLabel('2026-12-04 OFF preferred').fill('0');
    await dialog.getByRole('button', { name: 'Save demand' }).click();
    await dialog.getByText(/not proof of feasible OFF pairs/).waitFor();
    await dialog.getByLabel('Demand group', { exact: true }).selectOption('new');
    assert.equal(await dialog.getByLabel('2026-12-04 OFF maximum').inputValue(), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-planning-mobile.png') });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally { await context.close(); }
});
