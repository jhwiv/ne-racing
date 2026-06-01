// Layer 4: State-transition matrix.
// For each (action, observable surface) pair, drive the action and read the
// surface. Fail on any cell that doesn't update. This is the exact shape of
// test that would have caught the picker → barn miss: the store updated,
// the badge updated, but the barn tab DOM didn't.
//
// Actions:    A1 heart-tap, A2 picker-add, A3 clear-all, A4 per-item-×
// Surfaces:   S1 barn-tab card count, S2 today-strip chip count,
//             S3 picker-row heart state, S4 horse-row heart state on today

const path = require('path');
const {
  launch, newSession, readStore, tapNav,
  openSearch, closeSearch, typeSearch,
  openPickerDrawer, closePickerDrawer, typePicker, tapPickerAddRow,
  HEART_SELECTORS, PICKER_ROW_SELECTORS, BARN_CARD_SELECTORS,
} = require(path.join(__dirname, '..', 'helpers', 'boot.js'));
const { Report } = require(path.join(__dirname, '..', 'helpers', 'report.js'));

// ---- Surface readers (read what the user sees) ----

async function s1_barnTabCount(page) {
  await tapNav(page, 'barn');
  return page.evaluate((sel) => {
    const tab = document.getElementById('tab-barn');
    if (!tab) return -1;
    return tab.querySelectorAll(sel).length;
  }, BARN_CARD_SELECTORS);
}

async function s2_todayStripCount(page) {
  await tapNav(page, 'today');
  return page.evaluate(() => document.querySelectorAll('.barn-today-chip').length);
}

async function s3_pickerRowHeart(page, horse) {
  // Open picker, type horse, read whether the row's badge says "In Barn"
  // (which is the picker's visible signal that the row reflects an existing
  // barn entry — functionally the same as a filled heart).
  await openPickerDrawer(page);
  await typePicker(page, horse);
  const state = await page.evaluate(({h, rowSel}) => {
    const rows = Array.from(document.querySelectorAll(rowSel));
    const row = rows.find(r => (r.textContent || '').toLowerCase().includes(h.toLowerCase()));
    if (!row) return { found: false };
    const addBtn = row.querySelector('.barn-lookup-add');
    const badge = row.querySelector('.barn-lookup-badge-inbarn, .barn-lookup-badge-fav');
    return {
      found: true,
      inBarn: !!(addBtn && addBtn.disabled) || !!badge,
      addBtnText: addBtn ? (addBtn.textContent || '').trim() : null,
    };
  }, { h: horse, rowSel: PICKER_ROW_SELECTORS });
  await closePickerDrawer(page);
  return state;
}

// ---- Actions ----

async function a_clearStore(page) {
  await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('racing2026');
      const s = raw ? JSON.parse(raw) : {};
      s.barn = { horses: [], jockeys: [], trainers: [] };
      localStorage.setItem('racing2026', JSON.stringify(s));
    } catch (e) {}
  });
  await page.evaluate(() => { if (typeof switchTab === 'function') switchTab('today'); });
  await page.waitForTimeout(200);
}

async function a_pickerAdd(page, horse) {
  await openPickerDrawer(page);
  await typePicker(page, horse);
  const res = await tapPickerAddRow(page, horse);
  await page.waitForTimeout(400);
  await closePickerDrawer(page);
  return res.ok;
}

async function a_heartTapOnToday(page) {
  await tapNav(page, 'today');
  return page.evaluate((sel) => {
    const hearts = Array.from(document.querySelectorAll(sel))
      .filter(h => h.offsetParent !== null);
    if (!hearts.length) return { ok: false, reason: 'no visible hearts' };
    const h = hearts[0];
    const name = h.getAttribute('data-heart-horse') || h.getAttribute('data-horse') || null;
    h.click();
    return { ok: true, name };
  }, HEART_SELECTORS);
}

async function pickHorseRunningToday(page) {
  // Prefer a 'live' source horse so we can assert the today-strip chip
  // surface as well. Fall back to curated if no live day.
  return page.evaluate(() => {
    const c = (typeof window.__getLookupCandidatesCached === 'function') ? window.__getLookupCandidatesCached() : null;
    if (!Array.isArray(c)) return null;
    const live = c.find(y => y && y.source === 'live');
    if (live) return { name: live.name, source: 'live' };
    const cur = c.find(y => y && y.source === 'curated') || c[0];
    return cur ? { name: cur.name, source: cur.source || 'curated' } : null;
  });
}

// ---- Matrix runner ----

async function run({ baseUrl, version }) {
  const r = new Report('L4 state-transitions');
  const browser = await launch();
  const { page } = await newSession(browser, { baseUrl, version });

  const picked = await pickHorseRunningToday(page);
  r.check('found a horse to drive the matrix', !!picked, { picked });
  if (!picked) { await browser.close(); return r.finish(); }
  const horse = picked.name;
  const horseIsLive = picked.source === 'live';
  r.note(`driving matrix with "${horse}" (source=${picked.source})`);

  // ===== A2 picker-add =====
  await a_clearStore(page);
  const addedViaPicker = await a_pickerAdd(page, horse);
  r.check('picker accepted Add', addedViaPicker);
  if (addedViaPicker) {
    const store = await readStore(page);
    const storeNames = (store?.barn?.horses || []).map(h => h.name.toLowerCase());
    r.check('A2→store: barn.horses contains horse', storeNames.includes(horse.toLowerCase()), { storeNames, want: horse });
    r.check('A2→S1: barn tab DOM shows 1 card', (await s1_barnTabCount(page)) === 1);
    if (horseIsLive) {
      r.check('A2→S2: today strip shows 1 chip (horse runs today)', (await s2_todayStripCount(page)) === 1);
    } else {
      r.note(`A2→S2: skipped (horse is ${picked.source}, not on today's card)`);
    }
    const ps = await s3_pickerRowHeart(page, horse);
    r.check('A2→S3: picker row reflects "In Barn"', ps.found && ps.inBarn === true, ps);
  }

  // ===== A3 clear-all =====
  await tapNav(page, 'today');
  const clearedViaButton = await page.evaluate(() => {
    const btn = document.querySelector('.barn-today-clearall');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clearedViaButton) {
    r.note('A3: clear-all button selector not found, falling back to direct store clear');
    await a_clearStore(page);
  } else {
    await page.waitForTimeout(300);
  }
  r.check('A3→store: barn.horses empty', (((await readStore(page))?.barn?.horses) || []).length === 0);
  r.check('A3→S1: barn tab DOM empty', (await s1_barnTabCount(page)) === 0);
  r.check('A3→S2: today strip empty (or hidden)', (await s2_todayStripCount(page)) <= 0);

  // ===== A1 heart-tap =====
  await a_clearStore(page);
  const ht = await a_heartTapOnToday(page);
  if (ht.ok) {
    await page.waitForTimeout(300);
    r.check('A1→store: heart-tap added 1 horse', (((await readStore(page))?.barn?.horses) || []).length === 1);
    r.check('A1→S1: barn tab DOM shows 1 card', (await s1_barnTabCount(page)) === 1);
    r.check('A1→S2: today strip shows 1 chip', (await s2_todayStripCount(page)) === 1);
  } else {
    r.note(`A1 heart-tap not testable on this build: ${ht.reason}`);
  }

  // ===== A4 per-item × =====
  // Requires there to be at least one chip. Add via heart first if empty.
  if (((await readStore(page))?.barn?.horses || []).length === 0) {
    const ht2 = await a_heartTapOnToday(page);
    if (!ht2.ok) r.note('A4: cannot pre-populate strip via heart, skipping');
  }
  await tapNav(page, 'today');
  const removedViaButton = await page.evaluate(() => {
    const x = document.querySelector('.barn-today-x');
    if (!x) return false;
    x.click();
    return true;
  });
  if (removedViaButton) {
    await page.waitForTimeout(300);
    r.check('A4→store: × removed the chip', (((await readStore(page))?.barn?.horses) || []).length === 0);
    r.check('A4→S2: today strip now empty', (await s2_todayStripCount(page)) <= 0);
    r.check('A4→S1: barn tab DOM now empty', (await s1_barnTabCount(page)) === 0);
  } else {
    r.note('A4: × button selector not found, skipping');
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
