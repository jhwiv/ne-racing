// Layer 1: Smoke crawl.
// Visit every tab + key overlay. Fail on:
//   - any console.error / pageerror at any point
//   - any 'undefined' / 'NaN' appearing in visible text (catches v2.38.11 "Race undefined")
//   - any required region rendering empty (catches "barn tab shows 0 after add")
//
// This layer doesn't try to be clever. It's the dumbest possible "did the page
// even load" check, run after every nav and overlay open.

const path = require('path');
const { launch, newSession, tapNav, openSearch, closeSearch, visibleText } = require(path.join(__dirname, '..', 'helpers', 'boot.js'));
const { Report } = require(path.join(__dirname, '..', 'helpers', 'report.js'));

const FORBIDDEN_TOKENS = [
  'Race undefined',
  'undefined undefined',
  '$NaN',
  'NaN%',
  ': undefined',
  'null null',
];

async function run({ baseUrl, version }) {
  const r = new Report('L1 smoke-crawl');
  const browser = await launch();
  const { page, errors } = await newSession(browser, { baseUrl, version });

  r.check('app booted (NE_APP_VERSION present)', !!(await page.evaluate(() => window.NE_APP_VERSION)));

  const tabs = ['today', 'bets', 'handicap', 'barn'];
  for (const t of tabs) {
    await tapNav(page, t);
    const text = await visibleText(page);
    const errs = errors.splice(0); // drain
    r.check(`tab "${t}" loads without console errors`, errs.length === 0, errs);
    for (const tok of FORBIDDEN_TOKENS) {
      r.check(`tab "${t}" has no "${tok}"`, !text.includes(tok), { tab: t, token: tok });
    }
    r.check(`tab "${t}" rendered some content`, text.trim().length > 100, { len: text.trim().length });
  }

  // Global search overlay
  await openSearch(page);
  r.check('search overlay opened', !!(await page.$('#global-search-input')));
  const overlayErrs = errors.splice(0);
  r.check('search overlay no errors', overlayErrs.length === 0, overlayErrs);
  await closeSearch(page);

  // Settings (gear icon) — verify there's a settings page reachable
  const settingsReachable = await page.evaluate(() => {
    if (typeof openSettings === 'function') { openSettings(); return true; }
    const btn = document.querySelector('[onclick*="openSettings"]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (settingsReachable) {
    await page.waitForTimeout(300);
    const txt = await visibleText(page);
    r.check('settings page shows current version', /v2\.\d+\.\d+/.test(txt), txt.slice(0, 200));
    // Close settings
    await page.evaluate(() => {
      const close = document.querySelector('#settings-modal .modal-close, [onclick*="closeSettings"]');
      if (close) close.click();
    });
  } else {
    r.note('settings not reachable via known selectors (skip)');
  }

  await browser.close();
  return r.finish();
}

if (require.main === module) {
  const baseUrl = process.env.QA_BASE_URL || 'https://railbirdai.com/';
  const version = process.env.QA_VERSION || null;
  run({ baseUrl, version }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  }).catch(e => { console.log('FATAL:', e.message); process.exit(2); });
}

module.exports = { run };
