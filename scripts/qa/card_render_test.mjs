// Verify the live worker card renders in the app today.
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8765';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 664 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  timezoneId: 'America/New_York',
});
await ctx.addInitScript(() => {
  localStorage.setItem('railbird-beta-unlocked-v1', '1');
  localStorage.setItem('racing2026', JSON.stringify({ settings: { tourDone: true, activeTrack: 'SAR' } }));
  localStorage.setItem('railbird.adminUnlocked.v1', '1');
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error' && !/CORS|favicon|404/i.test(m.text())) consoleErrors.push(m.text()); });
await page.goto(BASE + '/index.html?dev=1', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
// Snapshot anything that looks like a race tile.
const summary = await page.evaluate(() => {
  const cards = document.querySelectorAll('[class*="race"], [data-race-number], .race-tile, .race-card, .race-row');
  const texts = [];
  document.querySelectorAll('body *').forEach(el => {
    const t = (el.textContent || '').trim();
    if (/Little Trilby|Saratoga|Race 1|R1|12:35/i.test(t) && t.length < 200 && !texts.includes(t)) texts.push(t);
  });
  return { cardCount: cards.length, sampleTexts: texts.slice(0, 8) };
});
console.log('Race-ish DOM elements:', summary.cardCount);
console.log('Matching text fragments:');
summary.sampleTexts.forEach(t => console.log('  -', t.slice(0, 120)));
console.log('Console errors:', consoleErrors.length);
consoleErrors.forEach(e => console.log('  !', e.slice(0, 200)));
await page.screenshot({ path: '/tmp/sar_today.png', fullPage: false });
await browser.close();
