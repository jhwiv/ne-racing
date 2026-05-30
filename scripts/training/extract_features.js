#!/usr/bin/env node
'use strict';

/**
 * extract_features.js — emit per-race feature matrices for the conditional-logit
 * fitter. Reads the on-disk corpus (and optionally pulls additional history from
 * the Cloudflare Worker), runs the v2 scoring engine on every race that has a
 * recorded result, and writes one JSON object per line to stdout:
 *
 *   {
 *     "raceId": "SAR-20250710-R1",
 *     "track":  "SAR",
 *     "date":   "2025-07-10",
 *     "features": [   // one row per non-scratched horse, six sub-scores 0..100
 *       [speed, classS, pace, tj, bias, fresh],   // pp 1
 *       ...
 *     ],
 *     "ppOrder": [1,2,3,...],    // parallel to `features`, the actual PP values
 *     "winnerIdx": 0              // 0-based index into `features`
 *   }
 *
 * Races without results, or with a winner that's scratched / not in the field,
 * are skipped (and logged to stderr with a reason).
 *
 * Usage:
 *   node scripts/training/extract_features.js > data/weights/_features.jsonl
 *   node scripts/training/extract_features.js \
 *     --worker https://cloudflare-worker.jhwiv-online.workers.dev \
 *     --track BEL --from 2026-05-01 --to 2026-07-31 \
 *     > data/weights/_features.jsonl
 *
 * No DOM, no fetch unless --worker passed. Pure Node.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { loadCorpus, loadCorpusFromWorker, mergeCorpora } = require(
  path.join(ROOT, 'scripts', 'backtest', 'load_corpus.js')
);
const { scoreRace } = require(path.join(ROOT, 'scripts', 'lib', 'scoring.js'));

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worker')        out.worker = argv[++i];
    else if (a === '--track')    out.track  = argv[++i];
    else if (a === '--from')     out.from   = argv[++i];
    else if (a === '--to')       out.to     = argv[++i];
    else if (a === '--out')      out.out    = argv[++i];
    else if (a === '--include-fixtures') out.includeFixtures = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stderr.write([
      'Usage: extract_features.js [--worker URL] [--track CODE] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out PATH]',
      '',
      'Emits JSONL (one race per line) of feature matrices to stdout (or --out).',
    ].join('\n') + '\n');
    process.exit(0);
  }

  const local = loadCorpus({ includeFixtures: !!args.includeFixtures });
  let merged = local;
  if (args.worker) {
    process.stderr.write('[extract] fetching worker corpus...\n');
    const remote = await loadCorpusFromWorker({
      workerUrl: args.worker, track: args.track, from: args.from, to: args.to,
    });
    merged = mergeCorpora(local, remote);
    process.stderr.write(`[extract] local=${local.races.length} worker=${remote.races.length} merged=${merged.races.length}\n`);
  }

  const out = args.out
    ? fs.createWriteStream(args.out, { encoding: 'utf8' })
    : process.stdout;

  let emitted = 0, skipped = 0;
  const skipReasons = Object.create(null);

  for (const race of merged.races) {
    if (!race._hasResult) { skipReasons['no_result'] = (skipReasons['no_result']||0)+1; skipped++; continue; }

    // Determine winner PP from results.finish_positions
    const finish = race.results && race.results.finish_positions;
    const winnerRow = Array.isArray(finish) && finish.find(f => f && (f.position === 1 || f.position === '1'));
    if (!winnerRow || winnerRow.pp == null) {
      skipReasons['no_winner_pp'] = (skipReasons['no_winner_pp']||0)+1; skipped++; continue;
    }
    const winnerPp = parseInt(winnerRow.pp, 10);

    // Score the race with v2 (no expert in composite; bias unknown — pass nothing).
    let scored;
    try {
      scored = scoreRace(race, { version: 'v2', includeExpertInComposite: false });
    } catch (e) {
      skipReasons['score_error'] = (skipReasons['score_error']||0)+1; skipped++; continue;
    }
    if (!scored || !scored.length) {
      skipReasons['empty_scored'] = (skipReasons['empty_scored']||0)+1; skipped++; continue;
    }

    // Find the winner inside the scored field. (scoreRace filters scratches; a
    // late-scratched winner cannot appear here — that race is skipped.)
    const winnerIdx = scored.findIndex(s => s.horse && parseInt(s.horse.pp, 10) === winnerPp);
    if (winnerIdx < 0) {
      skipReasons['winner_scratched'] = (skipReasons['winner_scratched']||0)+1; skipped++; continue;
    }

    const features = scored.map(s => [
      s.speedScore, s.classScore, s.paceScore,
      s.tjScore, s.biasScore, s.freshnessScore,
    ]);
    const ppOrder = scored.map(s => parseInt(s.horse.pp, 10));

    const row = {
      raceId: race.id || `${race.track || ''}-${race.date || ''}-R${race.num || ''}`,
      track:  race.track || null,
      date:   race.date || null,
      features,
      ppOrder,
      winnerIdx,
    };
    out.write(JSON.stringify(row) + '\n');
    emitted++;
  }

  if (out !== process.stdout) out.end();
  process.stderr.write(`[extract] emitted=${emitted} skipped=${skipped} reasons=${JSON.stringify(skipReasons)}\n`);
}

main().catch(e => {
  process.stderr.write('[extract] fatal: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
