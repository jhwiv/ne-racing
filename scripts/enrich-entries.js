#!/usr/bin/env node
'use strict';

/**
 * enrich-entries.js
 *
 * Offline enrichment script that applies jockey/trainer stats, speed figures,
 * and additional expert picks to an existing entries JSON file.
 * Used when the full pipeline can't run (no network access to NYRA/Equibase).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// --- Helpers ---

function buildLookup(statsArray) {
  const map = {};
  if (!Array.isArray(statsArray)) return map;
  for (const entry of statsArray) {
    if (entry.name) {
      map[entry.name.toLowerCase().trim()] = entry;
    }
  }
  return map;
}

function lookupWinPct(name, lookup, fallback) {
  if (!name || !lookup) return fallback;
  const key = name.toLowerCase().trim();
  const hit = lookup[key];
  if (hit && typeof hit.winPct === 'number') return hit.winPct;
  if (hit && typeof hit.win_pct === 'number') return hit.win_pct;
  if (hit && typeof hit.pct === 'number') return hit.pct;

  // Try partial match (last name)
  const parts = key.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 1) {
    const lastName = parts[parts.length - 1];
    for (const [k, v] of Object.entries(lookup)) {
      if (k.endsWith(lastName)) {
        if (typeof v.winPct === 'number') return v.winPct;
        if (typeof v.win_pct === 'number') return v.win_pct;
        if (typeof v.pct === 'number') return v.pct;
      }
    }
  }

  return fallback;
}

// --- Main ---

const entriesPath = path.join(DATA_DIR, 'entries-AQU-2026-04-16.json');
const entries = JSON.parse(fs.readFileSync(entriesPath, 'utf-8'));

// 1. Load jockey/trainer stats (unwrap wrapper objects)
const jockeyStats = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jockey-stats.json'), 'utf-8'));
const trainerStats = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'trainer-stats.json'), 'utf-8'));
const jockeyLookup = buildLookup(jockeyStats.jockeys || jockeyStats);
const trainerLookup = buildLookup(trainerStats.trainers || trainerStats);
console.log(`Jockeys loaded: ${Object.keys(jockeyLookup).length}`);
console.log(`Trainers loaded: ${Object.keys(trainerLookup).length}`);

// 2. Load speed figures
const sfPath = path.join(DATA_DIR, 'speed-figures-AQU.json');
const sfData = JSON.parse(fs.readFileSync(sfPath, 'utf-8'));
const sfHorses = sfData.horses || {};
console.log(`Speed figures loaded for ${Object.keys(sfHorses).length} horses`);

// 3. Load additional expert picks
const epPath = path.join(DATA_DIR, 'expert-picks-AQU-2026-04-16.json');
const epData = JSON.parse(fs.readFileSync(epPath, 'utf-8'));
const epSources = epData.sources || [];
console.log(`Expert pick sources loaded: ${epSources.length}`);

// 4. Apply enrichments
let statsApplied = 0;
let speedApplied = 0;
let classApplied = 0;
let expertAdded = 0;

for (const race of entries.races) {
  for (const entry of race.entries) {
    // Apply jockey/trainer stats (always overwrite — fixes fallback 10%)
    const newJPct = lookupWinPct(entry.jockey, jockeyLookup, 10);
    const newTPct = lookupWinPct(entry.trainer, trainerLookup, 10);
    if (newJPct !== 10 || newTPct !== 10) statsApplied++;
    entry.jockeyPct = newJPct;
    entry.trainerPct = newTPct;

    // Apply speed figures
    const sfEntry = sfHorses[entry.name];
    if (sfEntry) {
      const existingFigs = entry.speedFigs || [null, null, null];
      const hasData = existingFigs.some(f => f != null);
      if (!hasData && sfEntry.speedFigs) {
        entry.speedFigs = sfEntry.speedFigs;
        speedApplied++;
      }
      if (!entry.lastClass && sfEntry.lastClass) {
        entry.lastClass = sfEntry.lastClass;
        classApplied++;
      }
      if (!entry.lastRaceDate && sfEntry.lastRaceDate) {
        entry.lastRaceDate = sfEntry.lastRaceDate;
      }
      if (sfEntry.runningStyle) {
        entry.runningStyle = sfEntry.runningStyle;
      }
    }

    // Recompute data completeness
    let dc = 0;
    const figs = entry.speedFigs || [];
    if (figs[0] != null) dc++;
    if (figs[1] != null) dc++;
    if (figs[2] != null) dc++;
    if (entry.runningStyle) dc++;
    if ((parseFloat(entry.jockeyPct) || 0) > 0) dc++;
    if ((parseFloat(entry.trainerPct) || 0) > 0) dc++;
    if (entry.lastClass) dc++;
    entry.dataCompleteness = parseFloat((dc / 7).toFixed(2));
  }

  // Apply additional expert picks
  if (!race.expertPicks) race.expertPicks = [];
  for (const source of epSources) {
    const picksByRace = source.picks || {};
    const raceKey = String(race.race_number);
    const sp = picksByRace[raceKey];
    if (!sp) continue;
    const isDupe = race.expertPicks.some(ep => ep.source === source.name);
    if (isDupe) continue;
    race.expertPicks.push({
      source: source.name,
      pick: sp.pick,
      picks: sp.picks,
      horseName: sp.horseName || null,
    });
    expertAdded++;
  }

  // Resolve PP numbers to horse names for all expert picks
  for (const ep of race.expertPicks) {
    if (!ep.horseName && ep.pick) {
      const match = race.entries.find(e => e.pp === ep.pick);
      if (match) ep.horseName = match.name;
    }
  }
}

console.log(`\nEnrichment results:`);
console.log(`  Jockey/trainer stats applied: ${statsApplied} horses`);
console.log(`  Speed figures applied: ${speedApplied} horses`);
console.log(`  Class history applied: ${classApplied} horses`);
console.log(`  Expert picks added: ${expertAdded} race-source combos`);

// 5. Write enriched entries
fs.writeFileSync(entriesPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
console.log(`\nEnriched entries written to: ${entriesPath}`);

// 6. Print sample data for verification
console.log('\n=== Sample Data Verification ===');
for (const race of entries.races.slice(0, 3)) {
  console.log(`\nRace ${race.race_number} (${race.race_type}):`);
  for (const entry of race.entries.slice(0, 3)) {
    console.log(`  ${entry.name}: figs=${JSON.stringify(entry.speedFigs)}, jPct=${entry.jockeyPct}, tPct=${entry.trainerPct}, class=${entry.lastClass}, dc=${entry.dataCompleteness}`);
  }
  console.log(`  Expert picks: ${(race.expertPicks || []).map(ep => ep.source).join(', ')}`);
}
