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

async function setRecoveryDraft(page) {
  await page.evaluate(async () => {
    const { seed, draftFor, save } = await import(new URL('js/roster-model.js', location.href));
    const model = seed(), draft = draftFor(model, 'Affiliate', '2026-12');
    for (const date of ['2026-12-07', '2026-12-08']) {
      draft.cells['SYN-001|' + date] = 'PM';
      draft.locks['SYN-001|' + date] = true;
      draft.coverage['old|' + date + '|PM'] = { min: 0, target: 0, max: 0 };
    }
    save(localStorage, model, 'Affiliate', '2026-12');
  });
  await page.reload();
  await page.selectOption('#group', 'old');
  await page.selectOption('#scope', 'group');
  await page.selectOption('#generation', 'balanced');
  await page.check('#empty-only');
}

test('desktop recovery trial failure is atomic, a verified second trial applies, and Undo restores both settings and cells', async () => {
  const { context, page, external, errors } = await open(1440, 950);
  try {
    await setRecoveryDraft(page);
    const revision = await page.locator('#summary').textContent();
    const dialog = page.locator('#dialog');
    await page.click('#generate');
    await dialog.getByRole('heading', { name: 'Generation diagnostics' }).waitFor();
    await dialog.getByText(/Selected scope: 307 unassigned.*Full month: 554 unassigned/).waitFor();
    const first = dialog.getByLabel(/2026-12-07.*0 to 1/), second = dialog.getByLabel(/2026-12-08.*0 to 1/);
    await first.check();
    await dialog.getByRole('button', { name: 'Apply & Regenerate' }).click();
    await dialog.getByText(/No settings or assignments were changed/).waitFor();
    assert.equal(await page.locator('#summary').textContent(), revision);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-recovery-failure.png') });
    await first.check();
    await second.check();
    await dialog.getByRole('button', { name: 'Apply & Regenerate' }).click();
    await dialog.getByText(/trial produced a valid candidate/).waitFor();
    assert.equal(await page.locator('#summary').textContent(), revision);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-recovery-success.png') });
    await dialog.getByRole('button', { name: 'Apply tested changes and candidate' }).click();
    assert.equal(await cell(page, 'SYN-001', '2026-12-07').textContent(), 'PM');
    assert.notEqual(await cell(page, 'SYN-002', '2026-12-07').textContent(), '-');
    await page.click('#undo');
    assert.equal(await page.locator('#summary').textContent(), revision);
    assert.equal(await cell(page, 'SYN-002', '2026-12-07').textContent(), '-');
    await page.click('#generate');
    await dialog.getByRole('heading', { name: 'Generation diagnostics' }).waitFor();
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mobile diagnostics navigate to an effective date and do not overflow', async () => {
  const { context, page, external, errors } = await open(390);
  try {
    await setRecoveryDraft(page);
    const dialog = page.locator('#dialog');
    await page.click('#generate');
    await dialog.getByRole('heading', { name: 'Generation diagnostics' }).waitFor();
    assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-recovery-mobile.png') });
    await dialog.getByRole('button', { name: 'Open first affected setting or cell' }).click();
    await dialog.getByRole('heading', { name: 'Coverage matrix' }).waitFor();
    assert.equal(await dialog.getByLabel('Rule period').inputValue(), '2026-12-07');
    assert.equal(await dialog.getByLabel('PM maximum', { exact: true }).inputValue(), '0');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('manual retry recovers after a budget-limited worker; incomplete candidate is view-only', async () => {
  const { context, page, external, errors } = await open(1180);
  try {
    await page.addInitScript(() => {
      const Original = window.Worker;
      window.Worker = class extends Original {
        postMessage(data) {
          super.postMessage(data.options.retry ? data : { ...data, options: { ...data.options, budget: 40 } });
        }
      };
    });
    await page.reload();
    await page.selectOption('#group', 'old');
    await page.selectOption('#scope', 'group');
    await page.selectOption('#generation', 'balanced');
    await page.click('#generate');
    const dialog = page.locator('#dialog');
    await dialog.getByText(/Search budget reached. Feasibility is unknown/).waitFor();
    await dialog.getByRole('button', { name: 'View Best Possible Draft' }).click();
    await dialog.getByText(/Invalid for final confirmation or publishing/).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /apply|confirm|publish/i }).count(), 0);
    assert.ok(await dialog.locator('td.error').count() > 0);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-recovery-incomplete.png') });
    await dialog.getByRole('button', { name: 'Back to diagnostics' }).click();
    await dialog.getByRole('button', { name: 'Retry Generation' }).click();
    await dialog.getByRole('heading', { name: 'Review generated candidates' }).waitFor();
    assert.equal(await cell(page, 'SYN-002', '2026-12-07').textContent(), '-');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mobile monthly recovery shows 100 percent assignment with cap conflicts and cannot apply the provisional plan', async () => {
  const { context, page, external, errors } = await open(390);
  try {
    await setRecoveryDraft(page);
    const dialog = page.locator('#dialog');
    await page.click('#generate');
    await dialog.getByText(/Disproven under current settings/).waitFor();
    await dialog.getByText(/before: 100.0% assigned/i).first().waitFor();
    await dialog.getByRole('button', { name: 'Review monthly candidates' }).click();
    await dialog.getByRole('heading', { name: 'Best Available Monthly Roster' }).waitFor();
    await dialog.getByText(/Provisional plans cannot be applied/).waitFor();
    await dialog.getByText(/100.0% assigned/).first().waitFor();
    assert.ok(await dialog.getByRole('button', { name: 'Apply Changes & Regenerate' }).isDisabled());
    assert.equal(await dialog.getByRole('button', { name: /confirm|publish/i }).count(), 0);
    assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-monthly-provisional-mobile.png') });
    await dialog.getByRole('button', { name: 'Back to diagnostics' }).click();
    await dialog.getByLabel(/2026-12-07.*0 to 1/).check();
    await dialog.getByLabel(/2026-12-08.*0 to 1/).check();
    await dialog.getByRole('button', { name: 'Apply & Regenerate' }).click();
    await dialog.getByText(/Before trial:.*After trial:/).waitFor();
    await dialog.getByRole('button', { name: 'Discard candidates' }).click();
    assert.equal(await cell(page, 'SYN-002', '2026-12-07').textContent(), '-');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

async function setWeeklyCaps(page) {
  await page.evaluate(async () => {
    const { seed, draftFor, save } = await import(new URL('js/roster-model.js', location.href));
    const model = seed(), draft = draftFor(model, 'Affiliate', '2026-12');
    for (const [shift, min, max] of [['AM', 2, 2], ['AM1', 1, 1], ['PM1', 1, 1], ['PM', 1, 2]]) {
      draft.coverage['old|*|' + shift] = { min, target: min, max };
    }
    draft.cells['SYN-001|2026-12-07'] = 'PM'; draft.locks['SYN-001|2026-12-07'] = true;
    save(localStorage, model, 'Affiliate', '2026-12');
  });
  await page.reload();
  await page.selectOption('#group', 'old');
  await page.selectOption('#scope', 'group');
  await page.selectOption('#generation', 'pm');
  await page.check('#empty-only');
}

test('desktop coordinated coverage trial exposes exact changes, applies only after approval, then undoes settings and assignments', async () => {
  const { context, page, external, errors } = await open(1440, 980);
  try {
    await setWeeklyCaps(page);
    const dialog = page.locator('#dialog'), revision = await page.locator('#summary').textContent();
    await page.click('#generate');
    await dialog.getByRole('button', { name: 'Review monthly candidates' }).click();
    await dialog.getByRole('heading', { name: 'Recommended Adjustments' }).waitFor();
    await dialog.getByText(/50 working slots.*42 permitted/).waitFor();
    await dialog.getByRole('button', { name: 'Compare Alternatives' }).click();
    await dialog.getByText('Tested recovery alternatives', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Compare Alternatives' }).click();
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-coverage-recommendations-desktop.png') });
    await dialog.getByRole('button', { name: 'Auto Optimize Coverage' }).click();
    await dialog.getByRole('heading', { name: 'Review generated candidates' }).waitFor();
    await dialog.getByText(/After trial:.*155\/155 required slots.*0 over caps.*0 blockers/).first().waitFor();
    await dialog.locator('summary').filter({ hasText: /exact-date coverage changes/ }).click();
    const apply = dialog.getByRole('button', { name: 'Apply Changes & Regenerate' });
    assert.equal(await apply.isEnabled(), true);
    assert.equal(await page.locator('#summary').textContent(), revision);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-coverage-trial-desktop.png') });
    await apply.click();
    await dialog.getByRole('heading', { name: 'Coverage changes applied' }).waitFor();
    assert.equal(await cell(page, 'SYN-001', '2026-12-07').textContent(), 'PM');
    assert.equal(await cell(page, 'SYN-003', '2026-12-09').textContent(), 'AL');
    assert.notEqual(await cell(page, 'SYN-002', '2026-12-07').textContent(), '-');
    await dialog.getByRole('button', { name: 'Undo Applied Changes' }).click();
    assert.equal(await page.locator('#summary').textContent(), revision);
    assert.equal(await cell(page, 'SYN-002', '2026-12-07').textContent(), '-');
    await page.click('#coverage');
    assert.equal(await dialog.getByLabel('PM maximum', { exact: true }).inputValue(), '2');
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mobile selects multiple recommendations and can convert selected strict caps without changing other shifts', async () => {
  const { context, page, external, errors } = await open(390);
  try {
    await setRecoveryDraft(page);
    const dialog = page.locator('#dialog');
    await page.click('#generate');
    await dialog.getByRole('button', { name: 'Review monthly candidates' }).click();
    await dialog.getByRole('heading', { name: 'Recommended Adjustments' }).waitFor();
    assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-coverage-recommendations-mobile.png') });
    await dialog.getByLabel(/2026-12-07.*0 to 1/).check();
    await dialog.getByLabel(/2026-12-08.*0 to 1/).check();
    await dialog.getByRole('button', { name: 'Test Selected Recommendations' }).click();
    await dialog.getByRole('button', { name: 'Apply Changes & Regenerate' }).waitFor();
    await dialog.getByRole('button', { name: 'Discard changes' }).click();
    await dialog.getByRole('button', { name: 'Edit Coverage Settings' }).click();
    await dialog.getByRole('heading', { name: 'Coverage matrix' }).waitFor();
    assert.equal(await dialog.getByLabel('PM maximum', { exact: true }).inputValue(), '0');
    await dialog.getByLabel('PM select cap to convert').check();
    await dialog.getByRole('button', { name: 'Convert selected caps to targets' }).click();
    assert.equal(await dialog.getByLabel('PM maximum', { exact: true }).inputValue(), '');
    assert.equal(await dialog.getByLabel('PM minimum', { exact: true }).inputValue(), '0');
    await dialog.getByRole('button', { name: 'Save coverage' }).click();
    await dialog.getByText('Coverage saved.', { exact: true }).waitFor();
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('desktop diagnostic export and isolated replay retain settings without overwriting browser storage', async () => {
  const { context, page, external, errors } = await open(1360);
  try {
    await setRecoveryDraft(page);
    const dialog = page.locator('#dialog');
    const original = await page.evaluate(() => localStorage.getItem('spv2.syntheticRoster.v1'));
    await page.click('#diagnostic-bundle');
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export anonymized diagnostic bundle' }).click();
    const file = await downloading;
    const data = await fs.readFile(await file.path());
    assert.doesNotMatch(data.toString(), /Avery Vale|SYNLOGIN|SYN-001/);
    await dialog.getByLabel('Diagnostic JSON').setInputFiles({ name: file.suggestedFilename(), mimeType: 'application/json', buffer: data });
    await dialog.getByRole('button', { name: 'Replay imported bundle' }).click();
    await dialog.getByRole('heading', { name: 'Best Available Monthly Roster' }).waitFor();
    await dialog.getByRole('cell', { name: 'Staff-01', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: /apply|confirm|publish/i }).count(), 0);
    if (artifacts) await page.screenshot({ path: path.join(artifacts, 'roster-diagnostic-replay-desktop.png') });
    assert.equal(await page.evaluate(() => localStorage.getItem('spv2.syntheticRoster.v1')), original);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
