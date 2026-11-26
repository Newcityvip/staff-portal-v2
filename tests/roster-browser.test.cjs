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
    await page.click('#generate');
    await page.getByRole('status').getByText(/Generated 18 staff/).waitFor();
    assert.match(await page.locator('#validation-title').textContent(), /0 blocking/);
    assert.equal(await cell(page, 'SYN-003', '2026-12-09').textContent(), 'AL');
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-desktop.png'), fullPage: true });
    await page.click('#preview');
    assert.equal(await page.locator('button.cell').count(), 0);
    await page.click('#confirm');
    await page.getByText(/Production publishing is unavailable/).waitFor();
    await page.getByText(/Before uploading this schedule/).waitFor();
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
    await page.click('#generate');
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
