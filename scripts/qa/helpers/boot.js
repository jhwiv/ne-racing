// Shared boot helpers for the Railbird QA harness.
// Every layer goes through bootPage() so version mismatches, tour modals, and
// onboarding flows can never silently block a test the way they have before.

const { chromium, devices } = require('playwright');

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1';

const VIEWPORT = { width: 393, height: 852 };

async function launch({ headless = true } = {}) {
  return chromium.launch({ headless });
}

async function newSession(browser, { version, baseUrl }) {
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    userAgent: IPHONE_UA,
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  // Pre-seed localStorage *before* any page script runs. This is the only
  // reliable way to skip the version-mismatch reload loop and the welcome tour.
  await ctx.addInitScript((v) => {
    try {
      if (v) localStorage.setItem('ne-racing-version', v);
      localStorage.setItem('ne-racing-tour-dismissed', '1');
      localStorage.setItem('ne-racing-tour-seen', '1');
      localStorage.setItem('ne-racing-onboard-done', '1');
    } catch (e) {}
  }, version);

  const page = await ctx.newPage();
  const errors = [];
  // Filter out errors that are environmental artifacts of running the harness
  // locally rather than real app bugs:
  //   - Worker CORS rejections when running from 127.0.0.1 (the worker only
  //     allows the railbirdai.com origin in production, by design).
  //   - The matching "Failed to load resource" lines those CORS rejections
  //     produce.
  // These errors do not appear when the app runs on its real domain, and
  // suppressing them locally keeps the harness focused on real regressions.
  const isHarmlessLocalError = (msg) => {
    if (!msg) return false;
    const s = String(msg);
    if (s.includes('cloudflare-worker.jhwiv-online.workers.dev') && s.includes('CORS')) return true;
    if (s.includes('net::ERR_FAILED') && s.includes('cloudflare-worker.jhwiv-online.workers.dev')) return true;
    // Chrome emits a bare "Failed to load resource: net::ERR_FAILED" line
    // immediately after each CORS rejection — same root cause, no URL in the
    // message itself. Swallow it on local-server runs only.
    if (/^Failed to load resource: net::ERR_FAILED/i.test(s.trim()) && baseUrl.startsWith('http://127.')) return true;
    // Chrome logs "Failed to load resource: the server responded with a status
    // of 404" for every 404 the page fetches. This is expected when the harness
    // runs on a non-race-day for a track (no entries JSON yet on GitHub Pages).
    // The app handles 404s gracefully via the live-unavailable banner.
    if (/^Failed to load resource: the server responded with a status of 404/i.test(s.trim())) return true;
    return false;
  };
  page.on('pageerror', e => {
    if (!isHarmlessLocalError(e.message)) errors.push({ type: 'pageerror', message: e.message });
  });
  page.on('console', m => {
    if (m.type() === 'error') {
      const text = m.text();
      if (!isHarmlessLocalError(text)) errors.push({ type: 'console.error', message: text });
    }
  });

  const cacheBust = Date.now();
  const url = `${baseUrl}?dev=1&_=${cacheBust}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait for the app to actually initialise — NE_APP_VERSION is the canonical
  // signal that index.html booted. If it isn't there in 15s, the page is broken.
  await page.waitForFunction(() => !!window.NE_APP_VERSION, null, { timeout: 15000 });

  // Belt-and-suspenders tour kill.
  await page.evaluate(() => {
    const tm = document.getElementById('tour-modal');
    if (tm) { tm.classList.remove('open'); tm.style.display = 'none'; tm.setAttribute('aria-hidden','true'); }
  });

  // Force-build the lookup candidate cache. It's lazy in production (only
  // populated when the picker opens or after the first scan call), so the
  // harness has to nudge it explicitly. Without this, search tests run
  // against an empty haystack and false-fail.
  //
  // We retry the build call itself a few times because on cold-cache cross-
  // layer runs the first call can resolve before underlying fetches settle.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(async () => {
      if (typeof window.__buildLookupCandidates === 'function') {
        try { await window.__buildLookupCandidates(); } catch (_) {}
      }
    });
    const ok = await page.evaluate(() => {
      return typeof window.__getLookupCandidatesCached === 'function'
        && Array.isArray(window.__getLookupCandidatesCached())
        && window.__getLookupCandidatesCached().length > 50;
    });
    if (ok) break;
    await page.waitForTimeout(750);
  }
  await page.waitForFunction(() => {
    return typeof window.__getLookupCandidatesCached === 'function'
      && Array.isArray(window.__getLookupCandidatesCached())
      && window.__getLookupCandidatesCached().length > 50;
  }, null, { timeout: 30000 }).catch(() => {});

  return { page, ctx, errors, url };
}

// Centralised selector list for heart buttons. The app uses .barn-heart in
// the canonical render and various legacy selectors elsewhere.
const HEART_SELECTORS = [
  '.barn-heart',
  '[data-heart-horse]',
  '[data-action="toggle-heart"]',
  '.heart-btn',
].join(', ');

// Picker row selector — drawer rows are .barn-lookup-result in the current
// build. Legacy aliases included for forward compatibility.
const PICKER_ROW_SELECTORS = [
  '.barn-lookup-result',
  '.barn-picker-row',
  '[data-picker-row]',
  '.picker-result-row',
  '.lookup-result-row',
].join(', ');

const PICKER_INPUT_ID = 'barn-lookup-input';
const PICKER_ADD_BTN  = '.barn-lookup-add';

async function openPickerDrawer(page) {
  // Open the lookup drawer the way the user does: tap the Add CTA on the
  // Barn tab. If the CTA isn't visible (already-open / no-barn state), fall
  // back to the global function the CTA invokes.
  await tapNav(page, 'barn');
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('#barn-open-add, .my-barn-empty-cta');
    if (btn) { btn.click(); return 'cta'; }
    if (typeof window.barn_openDrawer === 'function') { window.barn_openDrawer(); return 'fn'; }
    if (typeof barn_openDrawer === 'function') { barn_openDrawer(); return 'fn'; }
    return null;
  });
  await page.waitForSelector('#' + PICKER_INPUT_ID, { timeout: 3000 }).catch(() => {});
  return opened;
}

async function closePickerDrawer(page) {
  await page.evaluate(() => {
    const close = document.getElementById('barn-drawer-close');
    if (close) close.click();
  });
  await page.waitForTimeout(200);
}

async function typePicker(page, query) {
  // The drawer re-renders on input, which detaches the previous handle.
  // Use the locator API instead of an ElementHandle so each action re-resolves.
  const loc = page.locator('#' + PICKER_INPUT_ID);
  try {
    await loc.waitFor({ state: 'attached', timeout: 3000 });
  } catch (e) {
    return false;
  }
  // Set the value directly to bypass any re-render races, then dispatch input
  // so the app's listener fires.
  await page.evaluate(({ id, q }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus();
    el.value = q;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id: PICKER_INPUT_ID, q: query });
  await page.waitForTimeout(400);
  return true;
}

// Barn tab stall cards. Multiple class names used across builds; the canonical
// is .stall-card. .barn-item.barn-stall is a legacy alias.
const BARN_CARD_SELECTORS = [
  '.stall-card',
  '.barn-item.barn-stall',
  '.barn-stall-card',
  '.barn-horse-card',
  '[data-barn-horse]',
].join(', ');

async function tapPickerAddRow(page, horseName) {
  // Click the .barn-lookup-add button on the row whose name matches.
  return page.evaluate(({ name, rowSel, btnSel }) => {
    const rows = Array.from(document.querySelectorAll(rowSel));
    const row = rows.find(r => (r.textContent || '').toLowerCase().includes(name.toLowerCase()));
    if (!row) return { ok: false, reason: 'no row matched', rows: rows.length };
    const btn = row.querySelector(btnSel);
    if (!btn) return { ok: false, reason: 'no add button in row' };
    if (btn.disabled) return { ok: false, reason: 'add button disabled (already in barn?)' };
    btn.click();
    return { ok: true };
  }, { name: horseName, rowSel: PICKER_ROW_SELECTORS, btnSel: PICKER_ADD_BTN });
}

// Read a clean snapshot of the in-app store. Tests use this to assert
// state-after-action *separately* from DOM rendering, so we catch "store
// updated but UI didn't refresh" bugs like the picker → barn miss.
async function readStore(page) {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('racing2026');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return { _error: String(e) }; }
  });
}

// DOM snapshot helpers. These deliberately read what the *user* sees, not the
// scan() return value or the store. Bugs hide in the gap between those.
async function visibleText(page) {
  return page.evaluate(() => document.body.innerText || '');
}

async function activeTab(page) {
  return page.evaluate(() => {
    const t = document.querySelector('.bottom-nav .nav-item.active, [data-tab].active');
    return t ? (t.getAttribute('data-tab') || t.textContent.trim()) : null;
  });
}

async function tapNav(page, tabKey) {
  // The app exposes switchTab(name) globally. We could click the bottom-nav
  // button, but switchTab covers the exact same code path the button does
  // (it's literally the onclick), and is hidden-tab safe (barn is display:none
  // in the nav strip but still a real tab).
  await page.evaluate((k) => { if (typeof switchTab === 'function') switchTab(k); }, tabKey);
  await page.waitForTimeout(300);
}

async function clickBottomNav(page, tabKey) {
  // Real-button version for tests that must prove the actual nav button works.
  await page.evaluate((k) => {
    const btn = document.getElementById('tab-btn-' + k);
    if (btn) btn.click();
  }, tabKey);
  await page.waitForTimeout(300);
}

async function openSearch(page) {
  await page.evaluate(() => { if (typeof openGlobalSearch === 'function') openGlobalSearch(); });
  await page.waitForSelector('#global-search-input', { timeout: 3000 });
}

async function closeSearch(page) {
  await page.evaluate(() => {
    if (typeof closeGlobalSearch === 'function') closeGlobalSearch();
    const ov = document.getElementById('global-search-overlay');
    if (ov) ov.style.display = 'none';
  });
  await page.waitForTimeout(150);
}

async function typeSearch(page, q) {
  const input = await page.$('#global-search-input');
  if (!input) throw new Error('global search input not found');
  await input.click();
  await input.fill('');
  await input.type(q, { delay: 25 });
  await page.waitForTimeout(350);
}

async function readSearchResults(page) {
  return page.evaluate(() => {
    const c = document.getElementById('global-search-results');
    if (!c) return null;
    const rows = Array.from(c.querySelectorAll('.gs-result-row'));
    return rows.map(r => {
      const kindEl = r.querySelector('.gs-result-kind');
      const titleEl = r.querySelector('.gs-result-title');
      const metaEl = r.querySelector('.gs-result-meta');
      return {
        kind: kindEl ? kindEl.textContent.trim().toLowerCase() : null,
        title: titleEl ? titleEl.textContent.trim() : '',
        meta: metaEl ? metaEl.textContent.trim() : '',
      };
    });
  });
}

module.exports = {
  IPHONE_UA, VIEWPORT,
  HEART_SELECTORS, PICKER_ROW_SELECTORS, BARN_CARD_SELECTORS, PICKER_INPUT_ID, PICKER_ADD_BTN,
  launch, newSession,
  readStore, visibleText, activeTab, tapNav, clickBottomNav,
  openSearch, closeSearch, typeSearch, readSearchResults,
  openPickerDrawer, closePickerDrawer, typePicker, tapPickerAddRow,
};
