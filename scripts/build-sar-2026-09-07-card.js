#!/usr/bin/env node
'use strict';

/**
 * One-day personal-use builder for SAR 2026-09-07.
 * Source: NYRA public HTMX entries (https://www.nyra.com/saratoga/rdl/race/).
 * Leaves scratched:false on every runner — Equibase XML is the live scratch feed.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NYRA_BASE = 'https://www.nyra.com';
const TRACK = 'SAR';
const DATE = '2026-09-07';
const OUT = path.join(__dirname, '..', 'data', `entries-${TRACK}-${DATE}.json`);

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'NERacing-Pipeline/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(fetchUrl(new URL(res.headers.location, url).href, maxRedirects - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&bull;/g, '•')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRaceHTML(html, raceNumber) {
  const race = {
    race_number: raceNumber,
    post_time: null,
    purse: null,
    race_type: null,
    conditions: null,
    distance: null,
    surface: 'Dirt',
    entries: [],
  };

  const headerMatch = html.match(/<header[^>]*>\s*Race\s+(\d+)\s*<\/header>/i);
  if (headerMatch) race.race_number = parseInt(headerMatch[1], 10);

  const purseTypeMatch = html.match(/<div>\s*(\$[\d,]+)\s*\n\s*([^<]+)\s*<\/div>/);
  if (purseTypeMatch) {
    race.purse = purseTypeMatch[1].trim();
    race.race_type = purseTypeMatch[2].trim();
  }

  const distMatch = html.match(/title="[^"]*">([\d\s/]+[FM])<\/div>/);
  if (distMatch) race.distance = distMatch[1].trim();

  const surfaceMatch = html.match(/<div[^>]*>\s*(Dirt|Turf|Inner Turf|Hurdle)\s*<\/div>/);
  if (surfaceMatch) race.surface = surfaceMatch[1].trim();

  const postTimeMatch = html.match(/([\d]+:[\d]+[ap])\s*at\s/);
  if (postTimeMatch) {
    const raw = postTimeMatch[1];
    race.post_time = raw.slice(0, -1) + ' ' + (raw.endsWith('p') ? 'PM' : 'AM');
  }

  const condMatch = html.match(/<div class="text-sm lg:text-base text-zinc-800 dark:text-white">\s*FOR\s+([\s\S]*?)<\/div>/);
  if (condMatch) race.conditions = condMatch[1].replace(/\s+/g, ' ').trim();

  const blocks = html.split(/<div class="flex items-start gap-3 lg:gap-5 text-sm/).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/blend-links[^>]*><a\s+href="([^"]*)"[^>]*>\s*([^<]+)\s*<\/a>/);
    if (!nameMatch) continue;

    const jtMatch = block.match(/<div class="text-zinc-800 dark:text-white">([^<]+?)&bull;([^<]+?)<\/div>/);
    const weightMatch = block.match(/(\d+)lbs/);
    const ppMatch = block.match(/saddle-(\d+)/) || block.match(/rounded-md">\s*(\d+)\s*</);
    const mlMatch = block.match(/title="Morning Line Odds">ML\s*([^<]+)<\/div>/);

    race.entries.push({
      pp: ppMatch ? parseInt(ppMatch[1], 10) : 0,
      name: decodeEntities(nameMatch[2]),
      jockey: jtMatch ? decodeEntities(jtMatch[1]) : 'N/A',
      trainer: jtMatch ? decodeEntities(jtMatch[2]) : 'N/A',
      weight: weightMatch ? weightMatch[1] : '',
      ml: mlMatch ? mlMatch[1].trim() : 'N/A',
      // Live scratches come from Equibase XML — never bake them into static.
      scratched: false,
    });
  }

  return race;
}

function loadExpertPicks() {
  try {
    const raw = execSync('git show 58a4a42^:data/entries-SAR-2026-09-07.json', {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
    });
    return JSON.parse(raw);
  } catch (err) {
    console.warn('Could not load prior expertPicks:', err.message);
    return null;
  }
}

async function main() {
  const prior = loadExpertPicks();
  const priorByRace = new Map();
  if (prior && Array.isArray(prior.races)) {
    for (const r of prior.races) priorByRace.set(r.race_number, r.expertPicks || []);
  }

  const races = [];
  for (let rn = 1; rn <= 12; rn++) {
    const url = `${NYRA_BASE}/saratoga/rdl/race/?day=${DATE}&limit=entries&race=${rn}`;
    console.log(`Fetching ${url}`);
    const html = await fetchUrl(url);
    const race = parseRaceHTML(html, rn);
    const expertPicks = (priorByRace.get(rn) || []).map((ep) => {
      const copy = { ...ep };
      if (!copy.horseName && copy.pick) {
        const match = race.entries.find((e) => e.pp === copy.pick);
        if (match) copy.horseName = match.name;
      }
      return copy;
    });
    if (expertPicks.length) race.expertPicks = expertPicks;
    races.push(race);
    console.log(`  R${rn}: ${race.entries.length} runners  ${race.race_type || '?'}  ${race.distance || '?'}  ${race.surface || '?'}`);
    if (rn < 12) await delay(350);
  }

  const total = races.reduce((n, r) => n + r.entries.length, 0);
  const output = {
    track: TRACK,
    date: DATE,
    source: 'nyra-public-entries',
    note: 'One-day personal use. Scratches are NOT baked in; Equibase late-change XML is the live scratch feed.',
    expertPicksLastUpdated: prior && prior.expertPicksLastUpdated ? prior.expertPicksLastUpdated : undefined,
    races,
  };
  if (!output.expertPicksLastUpdated) delete output.expertPicksLastUpdated;

  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT}`);
  console.log(`Races: ${races.length}  Runners: ${total}`);
  if (races.length !== 12 || total < 100) {
    throw new Error(`Unexpected card size: ${races.length} races / ${total} runners`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
