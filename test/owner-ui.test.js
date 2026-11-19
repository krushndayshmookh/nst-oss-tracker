// SPEC addendum G, frontend: "Krushn's dashboard" in a real browser (headless Chromium via Playwright) against a real
// mongod. Skipped when Playwright is not installed. Covers: the second password is asked every time the page is opened,
// Lock, the lock on leaving, a 401 going back to the prompt, every view rendering, the note + flag, and the wording rule
// ("readiness score" everywhere; "estimated selection rate" only once outcomes exist).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMongo } from './helpers/mongo.js';
import { startApp, TEST_PASSWORD } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { ensurePrograms, loadPrograms, savePrograms } from '../src/programs.js';
import { recomputeScores } from '../src/scores.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OWNER_PASSWORD = 'owner page second password';

function loadPlaywright() {
  for (const from of [import.meta.url, '/opt/npm-tools/', `${process.env.NODE_PATH || ''}/`]) {
    try { return createRequire(from)('playwright'); } catch { /* try the next place */ }
  }
  return null;
}
const playwright = loadPlaywright();

let mongo; let app; let db; let browser;

before(async () => {
  if (!playwright) return;
  mongo = await startMongo();
  db = mongo.client.db('owner_ui');
  await ensureIndexes(db);
  invalidateContext();
  await ensurePrograms(db, new Date());
  const cfg = await loadPrograms(db);
  const day = (nAgo, h = 0) => new Date(Date.now() - nAgo * 86400000 + h * 3600000).toISOString();
  const win = { from: new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10), to: new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10) };
  await savePrograms(db, { ...cfg, programs: cfg.programs.map((p) => ({ ...p, window: win, ...(p.key === 'gsoc' && { orgs: ['zulip', 'sugarlabs', 'oppia'] }) })) });
  const [alice, bob] = await insertStudents(db, [
    { username: 'Alice', name: 'Alice Anand', campus: 'RU', batch: 2025 },
    { username: 'Bob', name: 'Bob B', campus: 'ADYPU', batch: 2026 },
    { username: 'carol', name: 'Carol C', campus: 'RU', batch: 2024 },
  ]);
  invalidateContext();
  await upsertPRs(db, alice, Array.from({ length: 8 }, (_, i) => prNode({ repo: 'zulip/zulip', number: 100 + i, title: `Fix narrow bug ${i}`, createdAt: day(70 - i * 9), mergedAt: day(70 - i * 9, 20), additions: 120, deletions: 30 })));
  await upsertPRs(db, bob, [prNode({ repo: 'sugarlabs/musicblocks', number: 5, state: 'OPEN', title: 'Add tempo widget', createdAt: day(3) })]);
  await collections(db).prs.updateMany({ ownerLc: 'zulip' }, { $set: { changedFiles: 4, comments: 4, reviews: 3 } });
  await refreshAggregates(db);
  await recomputeScores(db);
  app = await startApp(db, { ownerPassword: OWNER_PASSWORD });
  browser = await playwright.chromium.launch();
});
after(async () => { await browser?.close(); await app?.close(); await mongo?.stop(); });

async function openAdmin(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[01]/.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(`${app.base}/admin`);
  await page.fill('input[name=password]', TEST_PASSWORD);
  await page.click('button[name=sign-in]');
  await page.waitForSelector('#admin-nav:not([hidden])');
  return { ctx, page, problems };
}
async function unlock(page, password = OWNER_PASSWORD) {
  await page.waitForSelector('input[name=owner-password]');
  await page.fill('input[name=owner-password]', password);
  await page.click('button[name=unlock]');
}
const go = async (page, hash, selector) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector(selector); };
const ownerMe = (page) => page.evaluate(async () => (await fetch('/api/owner/me', { credentials: 'same-origin' })).json());

test('owner page ships no data and is not referenced by the public site', async () => {
  const dir = path.join(ROOT, 'public/js/owner');
  const files = await readdir(dir);
  assert.ok(files.includes('main.js'));
  for (const f of files) {
    const src = await readFile(path.join(dir, f), 'utf8');
    // "probability" may only appear where the page says what the score is NOT
    for (const m of src.matchAll(/probabilit(y|ies)/gi)) {
      const around = src.slice(Math.max(0, m.index - 30), m.index + 12);
      assert.match(around, /not a probability|never a probability/i, `${f}: "${around}"`);
    }
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/, `${f} must not keep anything in browser storage`);
  }
  const pub = `${await readFile(path.join(ROOT, 'public/index.html'), 'utf8')}\n${await readFile(path.join(ROOT, 'public/js/app.js'), 'utf8')}`;
  assert.doesNotMatch(pub, /js\/owner|api\/owner|owner\.css|Krushn/i);
});

test('the second password is asked every time: wrong password, unlock, Lock, leaving, reload, expiry', { skip: !playwright && 'Playwright is not installed' }, async () => {
  const { ctx, page, problems } = await openAdmin();
  try {
    // the link is in the top bar; nothing of the page is loaded before it is opened
    const requested = [];
    page.on('request', (r) => { if (/\/js\/owner\/|\/api\/owner\/(?!me)/.test(r.url())) requested.push(r.url()); });
    assert.equal(await page.textContent('a.nav-owner'), "Krushn's dashboard");
    await page.click('a.nav-owner');
    await page.waitForSelector('input[name=owner-password]');
    assert.ok(requested.every((u) => /\/js\/owner\//.test(u)), `only code before the unlock: ${requested.join(', ')}`);
    assert.equal(await page.locator('.owner-headline, table.data').count(), 0);

    await unlock(page, 'not the right password at all');
    await page.waitForSelector('.field-error:not([hidden])');
    assert.match(await page.textContent('.field-error:not([hidden])'), /not right/);
    assert.equal((await ownerMe(page)).unlocked, false);

    await unlock(page);
    await page.waitForSelector('.owner-headline');
    assert.match(await page.textContent('.owner-big'), /Students with a real chance/);
    assert.equal((await ownerMe(page)).unlocked, true);

    // Lock button
    await page.click('button[name=owner-lock]');
    await page.waitForSelector('input[name=owner-password]');
    assert.equal((await ownerMe(page)).unlocked, false);
    assert.equal(await page.locator('.owner-headline').count(), 0);

    // leaving for another admin page locks; coming back asks again
    await unlock(page);
    await page.waitForSelector('.owner-headline');
    await go(page, '#/jobs', 'h1');
    await page.waitForFunction(async () => !(await (await fetch('/api/owner/me')).json()).unlocked);
    await page.click('a.nav-owner');
    await page.waitForSelector('input[name=owner-password]');

    // a reload asks again even though the 2 h cookie was still valid, and clears that cookie
    await unlock(page);
    await page.waitForSelector('.owner-headline');
    await page.reload();
    await page.waitForSelector('input[name=owner-password]');
    assert.equal((await ownerMe(page)).unlocked, false);

    // the unlock ends on the server (2 h, or locked from another tab): the next request returns to the prompt
    await unlock(page);
    await page.waitForSelector('.owner-headline');
    await page.evaluate(() => fetch('/api/owner/lock', { method: 'POST', headers: { 'X-Requested-With': 'oss-admin', 'Content-Type': 'application/json' }, body: '{}' }));
    await page.click('.tabs a:has-text("Students")');
    await page.waitForSelector('input[name=owner-password]');
    assert.match(await page.textContent('.owner-unlock'), /locked itself/);
    assert.equal(await page.locator('#admin-nav[hidden]').count(), 0, 'still signed in as admin');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('every view renders at 1280 and 375 px; note and flag; readiness wording until outcomes exist', { skip: !playwright && 'Playwright is not installed' }, async () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 800 }]) {
    const { ctx, page, problems } = await openAdmin({ viewport });
    try {
      await page.click('a.nav-owner');
      await unlock(page);
      await page.waitForSelector('.owner-headline');
      const noOverflow = async (what) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, `${what} scrolls sideways at ${viewport.width}px`);
      const text = () => page.evaluate(() => document.body.innerText);

      // Summary
      assert.match(await page.textContent('.owner-big-value'), /^1$/, 'alice is the one student with a real chance');
      assert.match(await text(), /How this is computed and its limits/);
      assert.match(await text(), /not a probability of selection/);
      assert.match(await text(), /GSoC requires contributors to be 18 or older/);
      assert.doesNotMatch(await text(), /estimated selection rate/i);
      await noOverflow('summary');

      // Students: heat cells, filter, drawer with breakdown, next step, note and flag
      await go(page, '#/owner/students?program=gsoc', '.owner-students table.data tbody tr');
      assert.equal(await page.locator('.owner-students tbody tr').count(), 3);
      assert.match(await page.textContent('.owner-students tbody tr:first-child'), /Alice Anand/);
      assert.equal(await page.locator('.owner-students tbody tr:first-child .rc.band-strong').count() >= 1, true);
      assert.match(await page.getAttribute('a[download]', 'href'), /^\/api\/owner\/export\/students\.csv\?program=gsoc/);
      await noOverflow('students');
      await page.click('button[name=open-Alice]');
      await page.waitForSelector('#owner-drawer .feat');
      const drawer = await page.innerText('#owner-drawer');
      assert.match(drawer, /Strong readiness for GSoC/);
      assert.match(drawer, /Suggested next step/);
      assert.match(drawer, /Why this score/);
      assert.match(drawer, /8 merged PRs in zulip/i);
      assert.match(drawer, /Week by week/);
      assert.match(drawer, /Fix narrow bug/);
      assert.equal(await page.locator('#owner-drawer .feat').count(), 7);
      await page.click('#owner-drawer button[name=flag-shortlist]');
      await page.waitForSelector('#owner-drawer button[name=flag-shortlist][aria-pressed=true]');
      const noteText = `Wants zulip; mentor: R. (${viewport.width})`;
      await page.fill('#owner-drawer textarea[name=owner-note]', noteText);
      await page.click('#owner-drawer button[name=note-save]');
      await page.waitForFunction(() => /Saved/.test(document.querySelector('#owner-drawer .od-note-foot').textContent));
      assert.deepEqual(await db.collection('owner_notes').findOne({}, { projection: { _id: 0, note: 1, flag: 1 } }), { note: noteText, flag: 'shortlist' });
      await page.waitForSelector('.owner-students tbody tr:first-child .flag-shortlist');
      await page.click('#owner-drawer button[name=flag-shortlist]'); // remove it again for the next viewport
      await page.waitForSelector('#owner-drawer button[name=flag-shortlist][aria-pressed=false]');
      await page.click('#owner-drawer button[name=drawer-close]');
      await page.waitForFunction(() => !document.querySelector('#owner-drawer'));

      // Organisations
      await go(page, '#/owner/orgs?open=zulip', 'tr.org-people');
      assert.match(await page.innerText('.owner-orgs'), /Alice Anand/);
      await noOverflow('organisations');

      // Settings: programs, mapping, outcomes
      await go(page, '#/owner/settings', 'details.set-prog');
      assert.equal(await page.locator('details.set-prog').count(), 7);
      assert.equal(await page.isDisabled('button[name=save-settings]'), true);
      await page.fill('input[name=band-strong]', '20');
      await page.fill('input[name=band-possible]', '30');
      await page.click('button[name=save-settings]');
      await page.waitForSelector('.set-actions ~ *, .notice-warn:not([hidden])');
      assert.match(await page.textContent('.notice-warn:not([hidden])'), /Not saved.*strong > possible/i);
      await page.click('button[name=discard-settings]');
      await page.waitForFunction(() => document.querySelector('input[name=band-strong]')?.value === '60');
      await noOverflow('settings');
      await go(page, '#/owner/settings?s=orgs', '.owner-map');
      await noOverflow('organisation mapping');
      await go(page, '#/owner/settings?s=outcomes', 'textarea[name=outcomes-csv]');
      await noOverflow('past outcomes');

      if (viewport.width === 1280) {
        // outcomes turn the label mode to "calibrated": only now may a selection rate be shown
        await page.fill('textarea[name=outcomes-csv]', 'username,program,year,org,selected\nAlice,gsoc,2025,zulip,yes\ncarol,gsoc,2025,zulip,no');
        await page.click('button[name=upload-outcomes]');
        await page.waitForSelector('button[name="del-gsoc-2025"]');
        await page.waitForSelector('.calib');
        await go(page, '#/owner', '.owner-headline');
        await page.waitForFunction(() => /Estimated selection rate, from past outcomes/.test(document.body.innerText), null, { timeout: 15000 });
        assert.match(await text(), /past applicants selected|no past applicants/);
        await go(page, '#/owner/settings?s=outcomes', 'button[name="del-gsoc-2025"]');
        await page.click('button[name="del-gsoc-2025"]');
        await page.click('dialog[open] button.btn-danger');
        await page.waitForFunction(() => !document.querySelector('button[name="del-gsoc-2025"]'));
      }
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  }
});
