// Layer 5: Visual regression.
// Snapshot every key screen at iPhone Chrome viewport (393x852) and diff
// pixel-by-pixel against a stored baseline. Catches contrast regressions,
// layout overflow, and "looks broken" things scripts otherwise miss.
//
// First run creates the baseline. Re-runs diff against it.
//   - baseline/<name>.png    canonical
//   - reports/<name>.png     latest
//   - reports/<name>.diff.png  visual diff (where the change happened)
//
// pixelmatch threshold: 0.1 channel sensitivity, fail if mismatched pixels > 0.5% of frame.

const path = require('path');
const fs = require('fs');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const {
  launch, newSession, tapNav, openSearch, typeSearch, closeSearch,
} = require(path.join(__dirname, '..', 'helpers', 'boot.js'));
const { Report } = require(path.join(__dirname, '..', 'helpers', 'report.js'));

const BASELINE_DIR = path.join(__dirname, '..', 'baselines');
const REPORT_DIR = path.join(__dirname, '..', 'reports');
fs.mkdirSync(BASELINE_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

const FAIL_PCT = 0.5; // % of pixels allowed to differ

async function snap(page, name) {
  // Freeze animations and stabilise time-based content so consecutive runs
  // produce byte-identical screenshots (or close enough to diff cleanly).
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
    }
  ` }).catch(() => {});
  await page.waitForTimeout(300);
  const file = path.join(REPORT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

function diff(baselinePath, latestPath, diffPath) {
  const a = PNG.sync.read(fs.readFileSync(baselinePath));
  const b = PNG.sync.read(fs.readFileSync(latestPath));
  if (a.width !== b.width || a.height !== b.height) {
    return { mismatchedPixels: -1, totalPixels: a.width * a.height, sameSize: false };
  }
  const out = new PNG({ width: a.width, height: a.height });
  const mismatchedPixels = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: 0.1 });
  fs.writeFileSync(diffPath, PNG.sync.write(out));
  return { mismatchedPixels, totalPixels: a.width * a.height, sameSize: true };
}

async function run({ baseUrl, version, updateBaseline = false }) {
  const r = new Report('L5 visual-regression');
  const browser = await launch();
  const { page } = await newSession(browser, { baseUrl, version });

  // Reset barn state to canonical-empty before snapshotting. Without this,
  // residual hearts from earlier sessions (or even from this very run's
  // L2/L4 work if run in sequence) shift the layout and produce 8-10%
  // false-positive diffs.
  await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('racing2026');
      const s = raw ? JSON.parse(raw) : {};
      s.barn = { horses: [], jockeys: [], trainers: [] };
      localStorage.setItem('racing2026', JSON.stringify(s));
      if (typeof switchTab === 'function') switchTab('today');
    } catch (e) {}
  });
  await page.waitForTimeout(400);

  // Wait for late-arriving content (date strip, today's ticket) before any
  // snap. Without this, the today tab is partial in the first capture.
  async function settle() {
    await page.waitForTimeout(1200);
  }

  const scenes = [
    { name: 'today',    prepare: async () => { await tapNav(page, 'today'); await settle(); } },
    { name: 'bets',     prepare: async () => { await tapNav(page, 'bets'); await settle(); } },
    { name: 'handicap', prepare: async () => { await tapNav(page, 'handicap'); await settle(); } },
    { name: 'barn',     prepare: async () => { await tapNav(page, 'barn'); await settle(); } },
    { name: 'search-rosario', prepare: async () => { await openSearch(page); await typeSearch(page, 'Rosario'); } },
    { name: 'search-velazquez', prepare: async () => { await typeSearch(page, 'Velazquez'); } },
  ];

  for (const s of scenes) {
    await s.prepare();
    await page.waitForTimeout(400);
    const latest = await snap(page, s.name);
    const baseline = path.join(BASELINE_DIR, `${s.name}.png`);
    if (updateBaseline || !fs.existsSync(baseline)) {
      fs.copyFileSync(latest, baseline);
      r.note(`baseline ${updateBaseline ? 'refreshed' : 'created'}: ${s.name}.png`);
      continue;
    }
    const diffPath = path.join(REPORT_DIR, `${s.name}.diff.png`);
    const d = diff(baseline, latest, diffPath);
    if (!d.sameSize) {
      r.check(`scene "${s.name}" same dimensions as baseline`, false, d);
      continue;
    }
    const pct = (d.mismatchedPixels / d.totalPixels) * 100;
    r.check(`scene "${s.name}" within ${FAIL_PCT}% of baseline (${pct.toFixed(2)}% diff)`, pct <= FAIL_PCT, { ...d, pct });
  }

  // close search overlay before we finish so subsequent runs don't get confused
  await closeSearch(page);

  await browser.close();
  return r.finish();
}

if (require.main === module) {
  const baseUrl = process.env.QA_BASE_URL || 'https://railbirdai.com/';
  const version = process.env.QA_VERSION || null;
  const update = process.env.QA_UPDATE_BASELINE === '1';
  run({ baseUrl, version, updateBaseline: update }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  }).catch(e => { console.log('FATAL:', e.message); process.exit(2); });
}

module.exports = { run };
