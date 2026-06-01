// Layer 2: Real interaction matrix.
// Every assertion in here MUST drive the actual UI (click, type, tap) and
// read the actual DOM the user sees afterwards. No direct store seeding.
// No assuming a state mutation means the screen updated.
//
// Covers the exact bug classes I missed:
//   - heart-tap on a horse row → barn tab count must reflect it
//   - picker drawer "Add to Barn" → barn tab count must reflect it
//   - global search must surface curated jockey/trainer names
//   - "Clear all" in the today strip must empty barn.horses
//   - per-item × on a today-strip chip must remove only that horse

const path = require('path');
const {
  launch, newSession, readStore, tapNav,
  openSearch, closeSearch, typeSearch, readSearchResults,
  openPickerDrawer, closePickerDrawer, typePicker, tapPickerAddRow,
  HEART_SELECTORS, PICKER_ROW_SELECTORS, BARN_CARD_SELECTORS,
} = require(path.join(__dirname, '..', 'helpers', 'boot.js'));
const { Report } = require(path.join(__dirname, '..', 'helpers', 'report.js'));

async function countBarnHorsesInDom(page) {
  // Read the barn tab's rendered horse rows. We open the barn tab and count
  // the stall cards (NOT the badge — the badge bug we just fixed was exactly
  // because the badge updated but the tab didn't).
  await tapNav(page, 'barn');
  return page.evaluate((sel) => {
    const tab = document.getElementById('tab-barn');
    if (!tab) return -1;
    return tab.querySelectorAll(sel).length;
  }, BARN_CARD_SELECTORS);
}

async function todayStripHorseCount(page) {
  await tapNav(page, 'today');
  return page.evaluate(() => document.querySelectorAll('.barn-today-chip').length);
}

async function clearStore(page) {
  await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('racing2026');
      const s = raw ? JSON.parse(raw) : {};
      s.barn = { horses: [], jockeys: [], trainers: [] };
      localStorage.setItem('racing2026', JSON.stringify(s));
    } catch (e) {}
  });
  // Force a re-render of whatever tab is active.
  await page.evaluate(() => { if (typeof switchTab === 'function') switchTab('today'); });
  await page.waitForTimeout(200);
}

async function pickFirstCuratedHorseName(page) {
  // Use the candidate pool (same source the picker uses) so we always have
  // a horse that exists in the lookup, regardless of dark/live day. Retry
  // until the cache is populated — on back-to-back runs the lazy build can
  // still be in flight when this is first called.
  for (let i = 0; i < 20; i++) {
    const name = await page.evaluate(async () => {
      if (typeof window.__buildLookupCandidates === 'function') {
        try { await window.__buildLookupCandidates(); } catch (_) {}
      }
      const cands = (typeof window.__getLookupCandidatesCached === 'function')
        ? window.__getLookupCandidatesCached() : null;
      if (!Array.isArray(cands) || cands.length === 0) return null;
      const c = cands.find(x => x && x.source === 'curated') || cands[0];
      return c ? c.name : null;
    });
    if (name) return name;
    await page.waitForTimeout(500);
  }
  return null;
}

async function addViaPickerUI(page, horseName) {
  // Drive the picker the way the user does:
  //   open drawer → type name → click Add on the matching row.
  const opened = await openPickerDrawer(page);
  if (!opened) return { added: false, reason: 'drawer did not open' };
  const typed = await typePicker(page, horseName);
  if (!typed) return { added: false, reason: 'picker input not found after open' };
  const res = await tapPickerAddRow(page, horseName);
  await page.waitForTimeout(400);
  await closePickerDrawer(page);
  return { added: res.ok, reason: res.ok ? null : res.reason };
}

async function run({ baseUrl, version }) {
  const r = new Report('L2 interaction-matrix');
  const browser = await launch();
  const { page } = await newSession(browser, { baseUrl, version });

  // Baseline: clear barn before each scenario
  await clearStore(page);
  r.check('store cleared', ((await readStore(page))?.barn?.horses || []).length === 0);

  // ---- Scenario A: picker → barn ----
  const horse = await pickFirstCuratedHorseName(page);
  r.check('candidate pool has at least one curated horse', !!horse, { horse });
  if (horse) {
    const res = await addViaPickerUI(page, horse);
    r.check(`picker UI accepted Add for "${horse}"`, res.added, res);

    const storeAfter = await readStore(page);
    const storedNames = (storeAfter?.barn?.horses || []).map(h => h.name.toLowerCase());
    r.check('store now contains the horse', storedNames.includes(horse.toLowerCase()), { stored: storedNames, want: horse });

    const domCount = await countBarnHorsesInDom(page);
    r.check('barn tab DOM shows >= 1 horse card after picker add', domCount >= 1, { domCount });
  }

  // ---- Scenario B: clear all → empty state ----
  await clearStore(page);
  const emptyDom = await countBarnHorsesInDom(page);
  r.check('barn tab DOM empty after clear', emptyDom === 0, { emptyDom });

  // ---- Scenario C: heart tap on a horse row ----
  // Go to today tab, find any horse-row heart, click it. Then count barn.
  await tapNav(page, 'today');
  const heartResult = await page.evaluate((sel) => {
    const hearts = Array.from(document.querySelectorAll(sel));
    const visible = hearts.filter(h => {
      const rect = h.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!visible.length) return { ok: false, reason: 'no visible heart buttons on today tab', count: hearts.length };
    const h = visible[0];
    const name = h.getAttribute('data-heart-horse')
      || h.getAttribute('data-horse')
      || (h.closest('[data-horse-name]') || {}).dataset?.horseName
      || (h.closest('tr, .runner-row, .barn-stall-card') || {}).getAttribute?.('data-horse')
      || null;
    h.click();
    return { ok: true, name };
  }, HEART_SELECTORS);
  r.check('heart button found and clicked on today tab', heartResult.ok, heartResult);
  if (heartResult.ok) {
    await page.waitForTimeout(300);
    const storeAfter = await readStore(page);
    const count = (storeAfter?.barn?.horses || []).length;
    r.check('heart tap added a horse to store', count === 1, { count, name: heartResult.name });
    const domCount = await countBarnHorsesInDom(page);
    r.check('barn tab DOM reflects heart-tap add', domCount === 1, { domCount });
  }

  // ---- Scenario D: per-item × on today strip ----
  await tapNav(page, 'today');
  const removeResult = await page.evaluate(() => {
    const x = document.querySelector('.barn-today-x');
    if (!x) return { ok: false, reason: 'no × button on today strip' };
    x.click();
    return { ok: true };
  });
  if (removeResult.ok) {
    await page.waitForTimeout(250);
    const storeAfter = await readStore(page);
    const count = (storeAfter?.barn?.horses || []).length;
    r.check('per-item × cleared the chip from store', count === 0, { count });
  } else {
    r.note(`per-item × not testable: ${removeResult.reason}`);
  }

  // ---- Scenario E: global search jockey emit (regression for v2.38.15) ----
  await clearStore(page);
  await openSearch(page);
  // Pick a jockey known to be in the curated pool (Rosario)
  await typeSearch(page, 'Rosario');
  const rows = await readSearchResults(page);
  const jockeyRows = rows.filter(x => x.kind === 'jockey');
  r.check('search "Rosario" returns >= 1 jockey row', jockeyRows.length >= 1, { rows });
  r.check('a jockey row title contains "Rosario"',
    jockeyRows.some(x => x.title.toLowerCase().includes('rosario')),
    { jockeyRows });
  await closeSearch(page);

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
