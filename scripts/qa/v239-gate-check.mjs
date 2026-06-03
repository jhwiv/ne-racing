// v2.39.0 — beta-gate smoke checks.
// Verifies the gate renders the right mode for each query-param scenario,
// stubs the /api/beta-* worker calls so we don't hit live infra.
//
// Run:  node scripts/qa/v239-gate-check.mjs

import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8765';
const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? '  · ' + detail : ''));
}

const browser = await chromium.launch();

async function newCtx() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 664 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    timezoneId: 'America/New_York',
  });
  // Stub every cross-origin worker call. Returns canned JSON.
  await ctx.route('https://cloudflare-worker.jhwiv-online.workers.dev/**', (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname;
    if (path === '/api/beta-unlock') {
      const token = u.searchParams.get('token') || '';
      if (token === 'good-token-fixture') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, first: 'Stub', last: 'User', email: 'stub@example.com' })
        });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Token not found."}' });
    }
    if (path === '/api/beta-request') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, id: 'TEST123', emailStatus: 'sent' })
      });
    }
    // Default — let everything else through (beta-ping is OK, will just 404 / CORS).
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  return ctx;
}

// ── Scenario 1: no params → code mode visible ────────────────────────────
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const codeVisible    = await page.locator('#bg-mode-code').isVisible();
  const requestVisible = await page.locator('#bg-mode-request').isVisible();
  const approvVisible  = await page.locator('#bg-mode-approved').isVisible();
  rec('default → code mode visible',    codeVisible,    `code=${codeVisible}`);
  rec('default → request mode hidden',  !requestVisible, `request=${requestVisible}`);
  rec('default → approved mode hidden', !approvVisible,  `approved=${approvVisible}`);
  await ctx.close();
}

// ── Scenario 2: ?invite=alice-jones-abcd1234 → request mode + prefill ────
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html?invite=alice-jones-abcd1234', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const requestVisible = await page.locator('#bg-mode-request').isVisible();
  const codeVisible    = await page.locator('#bg-mode-code').isVisible();
  const invitedBy = await page.locator('#bg-invited-by').inputValue();
  rec('?invite= → request mode visible', requestVisible, `request=${requestVisible}`);
  rec('?invite= → code mode hidden',     !codeVisible,   `code=${codeVisible}`);
  rec('?invite= → invited_by prefilled', invitedBy.toLowerCase().includes('alice'),
    `invited_by="${invitedBy}"`);
  await ctx.close();
}

// ── Scenario 3: submit request happy-path ────────────────────────────────
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html?invite=alice-jones-abcd1234', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.fill('#bg-first', 'Bob');
  await page.fill('#bg-last', 'Tester');
  await page.fill('#bg-email', 'bob@example.com');
  await page.click('#bg-request-btn');
  await page.waitForTimeout(700);
  const okVisible = await page.locator('#bg-request-ok').isVisible();
  const okText = (await page.locator('#bg-request-ok').textContent()) || '';
  rec('submit request → success banner', okVisible && /Bob/.test(okText), `ok="${okText.slice(0,80)}"`);
  await ctx.close();
}

// ── Scenario 4: ?approved=good-token-fixture → unlocked + flag set ───────
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html?approved=good-token-fixture', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500); // wait past the 900ms reveal delay
  const gateHidden = await page.locator('#beta-gate').evaluate(el => el.classList.contains('hidden'));
  const flag = await page.evaluate(() => localStorage.getItem('railbird-beta-unlocked-v1'));
  const urlClean = await page.evaluate(() => location.search);
  const nameCache = await page.evaluate(() => localStorage.getItem('railbird.userName.v1'));
  rec('?approved=valid → gate hidden',       gateHidden,                `hidden=${gateHidden}`);
  rec('?approved=valid → unlock flag set',   flag === '1',              `flag=${flag}`);
  rec('?approved=valid → URL token stripped', !urlClean.includes('approved'), `search="${urlClean}"`);
  rec('?approved=valid → name cached',       (nameCache || '').includes('Stub'), `cache=${nameCache}`);
  await ctx.close();
}

// ── Scenario 5: ?approved=BAD → error message shown ──────────────────────
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html?approved=BAD', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const errText = (await page.locator('#bg-approved-err').textContent()) || '';
  const flag = await page.evaluate(() => localStorage.getItem('railbird-beta-unlocked-v1'));
  rec('?approved=BAD → error shown',     /invalid|revoked|HTTP/i.test(errText), `err="${errText}"`);
  rec('?approved=BAD → flag NOT set',    flag !== '1', `flag=${flag}`);
  await ctx.close();
}

// ── Scenario 6: Invite a friend button → buildInviteUrl works ────────────
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  // Skip the gate so the page boots fully.
  await page.addInitScript(() => {
    localStorage.setItem('railbird-beta-unlocked-v1', '1');
    localStorage.setItem('railbird.userName.v1', JSON.stringify({ first: 'Jane', last: 'Doe' }));
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const url = await page.evaluate(() => window.buildInviteUrl && window.buildInviteUrl());
  rec('buildInviteUrl exposed',        typeof url === 'string' && url.startsWith('https://railbirdai.com/?invite='), `url=${url}`);
  rec('buildInviteUrl uses name slug', /jane-doe-/.test(url || ''),                                                  `url=${url}`);
  await ctx.close();
}

await browser.close();

const failed = results.filter(r => !r.ok);
console.log(`\n=== v2.39.0 gate checks: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach(r => console.log('  - ' + r.name + ' | ' + r.detail));
  process.exit(1);
}
