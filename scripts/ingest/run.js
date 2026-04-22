#!/usr/bin/env node
// run.js — central ingester. Reads adapters based on env config, writes
// schema-conformant records to data/normalized/{year}/{track}/{date}.json
// and appends a row per ingest to data/ingest_log.jsonl.
//
// Usage:
//   node scripts/ingest/run.js --track SAR --year 2025
//   node scripts/ingest/run.js --track SAR --date 2025-07-17

'use strict';

const fs = require('fs');
const path = require('path');

const { SampleSaratogaAdapter } = require('./sample_saratoga_adapter');
const { TheRacingApiAdapter } = require('./theracingapi_adapter');
// const { UnofficialNyraAdapter } = require('./unofficial_nyra_adapter'); // DISABLED

const DATA_SOURCE = process.env.DATA_SOURCE || 'sample';

function pickAdapter() {
  if (DATA_SOURCE === 'theracingapi') return new TheRacingApiAdapter();
  if (DATA_SOURCE === 'sample') return new SampleSaratogaAdapter();
  throw new Error('Unknown DATA_SOURCE: ' + DATA_SOURCE + ' (valid: sample, theracingapi)');
}

function parseArgs(argv) {
  const out = { track: 'SAR', year: null, date: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--track') { out.track = v; i++; }
    else if (k === '--year') { out.year = Number(v); i++; }
    else if (k === '--date') { out.date = v; i++; }
  }
  return out;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function writeRaces(races, trackCode) {
  if (!races || !races.length) return 0;
  const byDate = {};
  races.forEach(r => {
    (byDate[r.date] = byDate[r.date] || []).push(r);
  });
  let count = 0;
  Object.keys(byDate).forEach(dateStr => {
    const year = dateStr.slice(0, 4);
    const dir = path.join(__dirname, '..', '..', 'data', 'normalized', year, trackCode);
    ensureDir(dir);
    const file = path.join(dir, dateStr + '.json');
    fs.writeFileSync(file, JSON.stringify({ races: byDate[dateStr] }, null, 2));
    count += byDate[dateStr].length;
  });
  return count;
}

function appendLog(entry) {
  const logPath = path.join(__dirname, '..', '..', 'data', 'ingest_log.jsonl');
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const adapter = pickAdapter();
  const log = { ts: new Date().toISOString(), adapter: adapter.id, args: args, ok: false };

  try {
    if (args.date) {
      const races = await adapter.fetchCard(args.date, args.track);
      const n = writeRaces(races, args.track);
      log.ok = true; log.races_written = n;
      console.log('[ingest] wrote ' + n + ' races for ' + args.track + ' ' + args.date + ' via ' + adapter.id);
    } else if (args.year) {
      // Sample adapter path: iterate all fixture dates for the track.
      const doc = adapter._load ? adapter._load() : null;
      const dates = doc && doc.races ? Array.from(new Set(doc.races.map(r => r.date))).sort() : [];
      let total = 0;
      for (const d of dates) {
        if (d.slice(0, 4) !== String(args.year)) continue;
        const races = await adapter.fetchCard(d, args.track);
        total += writeRaces(races, args.track);
      }
      log.ok = true; log.races_written = total;
      console.log('[ingest] wrote ' + total + ' races for ' + args.track + ' ' + args.year + ' via ' + adapter.id);
    } else {
      throw new Error('Pass --date YYYY-MM-DD or --year YYYY');
    }
  } catch (e) {
    log.error = String(e && e.message || e);
    console.error('[ingest] FAILED:', log.error);
    process.exitCode = 1;
  } finally {
    appendLog(log);
  }
}

if (require.main === module) main();

module.exports = { pickAdapter, writeRaces };
