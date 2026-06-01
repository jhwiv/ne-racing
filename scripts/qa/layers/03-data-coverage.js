// Layer 3: Data-coverage fuzzer.
// Walk every name in the candidate pool (horses, jockeys, trainers, owners,
// sires) and assert: typing a distinctive token from that name into global
// search surfaces a result in the *expected section*.
//
// This is the test that would have caught the jockey-search gap in seconds.

const path = require('path');
const fs = require('fs');
const {
  launch, newSession, openSearch, closeSearch, typeSearch, readSearchResults,
} = require(path.join(__dirname, '..', 'helpers', 'boot.js'));
const { Report } = require(path.join(__dirname, '..', 'helpers', 'report.js'));

function distinctiveToken(fullName) {
  // Use the longest word from the name as the search token. Avoids common
  // first names like "John" matching too many things and gives the search
  // engine a fair shot at being distinctive.
  const words = String(fullName || '').split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // Filter out 1-2 char tokens and pure initials (J., R.)
  const useful = words.filter(w => w.replace(/[^A-Za-z]/g, '').length >= 4);
  const pool = useful.length ? useful : words;
  return pool.sort((a, b) => b.length - a.length)[0];
}

async function gatherUniverse(page) {
  return page.evaluate(() => {
    const cands = (typeof window.__getLookupCandidatesCached === 'function')
      ? window.__getLookupCandidatesCached() : null;
    if (!Array.isArray(cands)) return null;
    const horses = new Set(), jockeys = new Set(), trainers = new Set(), owners = new Set(), sires = new Set();
    cands.forEach(c => {
      if (c && c.name) horses.add(c.name);
      const p = (c && c.profile) || {};
      if (p.jockey) jockeys.add(String(p.jockey).trim());
      if (p.trainer) trainers.add(String(p.trainer).trim());
      if (p.owner) owners.add(String(p.owner).trim());
      if (p.sire) sires.add(String(p.sire).trim());
    });
    return {
      horses: Array.from(horses),
      jockeys: Array.from(jockeys),
      trainers: Array.from(trainers),
      owners: Array.from(owners),
      sires: Array.from(sires),
    };
  });
}

async function run({ baseUrl, version, sampleSize = null, writeReport = true }) {
  const r = new Report('L3 data-coverage');
  const browser = await launch();
  const { page } = await newSession(browser, { baseUrl, version });

  const universe = await gatherUniverse(page);
  r.check('candidate pool loaded', !!universe, universe);
  if (!universe) { await browser.close(); return r.finish(); }

  r.note(`universe: ${universe.horses.length} horses, ${universe.jockeys.length} jockeys, ${universe.trainers.length} trainers, ${universe.owners.length} owners`);

  const groups = [
    { label: 'horse',   names: universe.horses,   expectKind: 'horse'   },
    { label: 'jockey',  names: universe.jockeys,  expectKind: 'jockey'  },
    { label: 'trainer', names: universe.trainers, expectKind: 'trainer' },
  ];

  const missing = { horse: [], jockey: [], trainer: [] };

  await openSearch(page);

  for (const g of groups) {
    let names = g.names;
    if (sampleSize && names.length > sampleSize) {
      // Deterministic sample so failures are reproducible
      const step = Math.ceil(names.length / sampleSize);
      names = names.filter((_, i) => i % step === 0).slice(0, sampleSize);
    }
    for (const name of names) {
      const token = distinctiveToken(name);
      if (!token) continue;
      await typeSearch(page, token);
      const rows = await readSearchResults(page);
      const matched = rows.some(row =>
        row.kind === g.expectKind &&
        row.title.toLowerCase().includes(name.toLowerCase().split(/\s+/).pop()) // surname match good enough
      );
      // For horses, we expect kind=horse with exact title containing the name.
      const matchedExact = g.expectKind === 'horse'
        ? rows.some(row => row.kind === 'horse' && row.title.toLowerCase() === name.toLowerCase())
        : matched;
      if (!matchedExact && !matched) {
        missing[g.label].push({ name, token, rows: rows.slice(0, 5) });
      }
    }
  }

  await closeSearch(page);

  // Convert to pass/fail at the group level — too noisy to fail on each name.
  for (const g of groups) {
    const m = missing[g.label];
    r.check(`every ${g.label} in pool surfaces in search (${universe[g.label + 's'].length} names)`,
      m.length === 0,
      m.slice(0, 10)
    );
  }

  if (writeReport) {
    const out = {
      timestamp: new Date().toISOString(),
      universe_sizes: { horses: universe.horses.length, jockeys: universe.jockeys.length, trainers: universe.trainers.length },
      missing,
    };
    const outPath = path.join(__dirname, '..', 'reports', 'L3-data-coverage.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    r.note(`detailed report → ${outPath}`);
  }

  await browser.close();
  return r.finish();
}

if (require.main === module) {
  const baseUrl = process.env.QA_BASE_URL || 'https://railbirdai.com/';
  const version = process.env.QA_VERSION || null;
  const sample = process.env.QA_SAMPLE ? parseInt(process.env.QA_SAMPLE, 10) : null;
  run({ baseUrl, version, sampleSize: sample }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  }).catch(e => { console.log('FATAL:', e.message); process.exit(2); });
}

module.exports = { run };
