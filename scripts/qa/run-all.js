// Top-level runner. Executes L1-L4 (and L5 unless --preship). Exits non-zero
// on any failure. Used by scripts/preship.sh and by CI.

const path = require('path');

const layers = [
  { id: 'L1', run: require('./layers/01-smoke-crawl.js').run },
  { id: 'L2', run: require('./layers/02-interaction-matrix.js').run },
  { id: 'L3', run: require('./layers/03-data-coverage.js').run },
  { id: 'L4', run: require('./layers/04-state-transitions.js').run },
];

if (!process.argv.includes('--preship')) {
  layers.push({ id: 'L5', run: require('./layers/05-visual-regression.js').run });
}

(async () => {
  const baseUrl = process.env.QA_BASE_URL || 'https://railbirdai.com/';
  const version = process.env.QA_VERSION || null;

  console.log(`\n==== Railbird QA harness ====`);
  console.log(`URL: ${baseUrl}`);
  console.log(`pinned version: ${version || '(none)'}`);
  console.log(`layers: ${layers.map(l => l.id).join(', ')}\n`);

  const results = [];
  for (const L of layers) {
    console.log(`\n---- ${L.id} ----`);
    try {
      const res = await L.run({ baseUrl, version });
      results.push({ id: L.id, ...res });
    } catch (e) {
      console.log(`${L.id} FATAL: ${e.message}`);
      results.push({ id: L.id, layer: L.id, passed: 0, failed: 1, total: 1, error: e.message });
    }
  }

  console.log(`\n==== Summary ====`);
  let anyFail = false;
  for (const r of results) {
    const tag = r.failed > 0 ? 'FAIL' : 'PASS';
    console.log(`  ${tag}  ${r.id}  ${r.passed}/${r.total}  (${r.failed} failed)`);
    if (r.failed > 0) anyFail = true;
  }
  process.exit(anyFail ? 1 : 0);
})();
